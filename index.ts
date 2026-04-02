export interface Env {
	SLACK_WEBHOOK_URL: string;
	FIZZY_SIGNING_SECRET: string;
	FIZZY_API_TOKEN: string;
}

interface FizzyUser {
	id: string;
	name: string;
	role: string;
	active: boolean;
	email_address: string;
	created_at: string;
	url: string;
}

interface FizzyBoard {
	id: string;
	name: string;
	all_access: boolean;
	created_at: string;
	creator: FizzyUser;
}

interface FizzyColumn {
	id: string;
	name: string;
}

interface FizzyCardEventable {
	id: string;
	title: string;
	status: string;
	image_url: string | null;
	golden: boolean;
	last_active_at: string;
	created_at: string;
	url: string;
	board: FizzyBoard;
	column: FizzyColumn | null;
	creator: FizzyUser;
}

interface FizzyCommentEventable {
	id: string;
	created_at: string;
	body: {
		plain_text: string;
		html: string;
	};
	creator: FizzyUser;
	reactions_url: string;
	url: string;
}

interface FizzyEvent {
	id: string;
	action: string;
	created_at: string;
	eventable: FizzyCardEventable | FizzyCommentEventable;
	board: FizzyBoard;
	creator: FizzyUser;
}

type FizzyAction =
	| "card_published"
	| "card_assigned"
	| "card_unassigned"
	| "card_closed"
	| "card_reopened"
	| "card_postponed"
	| "card_auto_postponed"
	| "card_triaged"
	| "card_sent_back_to_triage"
	| "card_board_changed"
	| "comment_created";

const ACTION_LABELS: Record<FizzyAction, string> = {
	card_published: "published a card",
	card_assigned: "assigned",
	card_unassigned: "unassigned",
	card_closed: "closed",
	card_reopened: "reopened",
	card_postponed: "postponed",
	card_auto_postponed: "auto-postponed",
	card_triaged: "triaged",
	card_sent_back_to_triage: "sent back to triage",
	card_board_changed: "moved to a different board",
	comment_created: "commented on",
};

function getActionEmoji(action: string): string {
	const emojis: Record<string, string> = {
		card_published: "📝",
		card_assigned: "👤",
		card_unassigned: "👤",
		card_closed: "✅",
		card_reopened: "🔄",
		card_postponed: "⏸️",
		card_auto_postponed: "⏸️",
		card_triaged: "📋",
		card_sent_back_to_triage: "↩️",
		card_board_changed: "➡️",
		comment_created: "💬",
	};
	return emojis[action] ?? "📌";
}

function getActionSlackEmoji(action: string): string {
	const emojis: Record<string, string> = {
		card_published: ":memo:",
		card_assigned: ":bust_in_silhouette:",
		card_unassigned: ":bust_in_silhouette:",
		card_closed: ":white_check_mark:",
		card_reopened: ":arrows_counterclockwise:",
		card_postponed: ":double_vertical_bar:",
		card_auto_postponed: ":double_vertical_bar:",
		card_triaged: ":clipboard:",
		card_sent_back_to_triage: ":leftwards_arrow_with_hook:",
		card_board_changed: ":arrow_right:",
		comment_created: ":speech_balloon:",
	};
	return emojis[action] ?? ":pushpin:";
}

function isCommentEvent(
	event: FizzyEvent
): event is FizzyEvent & { eventable: FizzyCommentEventable } {
	return event.action === "comment_created";
}

async function verifySignature(
	body: string,
	signature: string,
	secret: string
): Promise<boolean> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	const expected = Array.from(new Uint8Array(signed))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	return expected === signature;
}

function rewriteUrl(url: string): string {
	return url.replace(/https?:\/\/[^/]+/, "https://fizzy.hackclub.com");
}

function fixUrls(event: FizzyEvent) {
	if (event.eventable.url) {
		event.eventable.url = rewriteUrl(event.eventable.url);
	}
	if ("board" in event.eventable && event.eventable.board?.creator?.url) {
		event.eventable.board.creator.url = rewriteUrl(event.eventable.board.creator.url);
	}
	if (event.eventable.creator?.url) {
		event.eventable.creator.url = rewriteUrl(event.eventable.creator.url);
	}
	if (event.board?.creator?.url) {
		event.board.creator.url = rewriteUrl(event.board.creator.url);
	}
	if (event.creator?.url) {
		event.creator.url = rewriteUrl(event.creator.url);
	}
	if (isCommentEvent(event) && event.eventable.reactions_url) {
		event.eventable.reactions_url = rewriteUrl(event.eventable.reactions_url);
	}
}

async function fetchCardDescription(cardUrl: string, apiToken: string): Promise<string | null> {
	console.log(`[fetchCardDescription] Fetching description from: ${cardUrl}`);
	try {
		const res = await fetch(cardUrl, {
			headers: { Authorization: `Bearer ${apiToken}` },
		});
		console.log(`[fetchCardDescription] Response status: ${res.status}`);
		if (!res.ok) {
			const errorText = await res.text();
			console.error(`[fetchCardDescription] Non-OK response: ${res.status} ${errorText}`);
			return null;
		}
		const body = await res.text();
		console.log(`[fetchCardDescription] Response body: ${body.slice(0, 500)}`);
		const card = JSON.parse(body) as { description?: string };
		console.log(`[fetchCardDescription] Parsed description: ${card.description ?? "(undefined)"}`);
		return card.description || null;
	} catch (err) {
		console.error(`[fetchCardDescription] Error:`, err);
		return null;
	}
}

function buildSlackPayload(event: FizzyEvent, cardDescription?: string | null) {
	const action = event.action as FizzyAction;
	const emoji = getActionEmoji(action);
	const label = ACTION_LABELS[action] ?? action;
	const actor = event.creator?.name ?? "Someone";
	const slackEmoji = getActionSlackEmoji(action);
	const timestamp = new Date(event.created_at).toLocaleString("en-US", { timeZone: "UTC" });

	if (isCommentEvent(event)) {
		const comment = event.eventable;
		const plainText = comment.body.plain_text;
		const truncated =
			plainText.length > 300 ? plainText.slice(0, 300) + "…" : plainText;

		return {
			text: `${slackEmoji} ${actor} commented on a card`,
			attachments: [
				{
					color: "#5c20b1",
					blocks: [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: `*<${comment.url}|${emoji} ${actor} commented>*`,
							},
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: truncated,
							},
						},
						{
							type: "context",
							elements: [
								{
									type: "mrkdwn",
									text: `${event.board.name} • ${timestamp}`,
								},
							],
						},
					],
				},
			],
		};
	}

	const card = event.eventable as FizzyCardEventable;
	const title = card.title;
	const cardUrl = card.url;

	const detailParts: string[] = [];
	let descriptionBlock: object | null = null;
	if (cardDescription) {
		const truncated = cardDescription.length > 300 ? cardDescription.slice(0, 300) + "…" : cardDescription;
		descriptionBlock = {
			type: "section",
			text: {
				type: "mrkdwn",
				text: truncated,
			},
		};
	}
	if (card.board) {
		detailParts.push(`*Board*\n${card.board.name}`);
	}
	if (card.column) {
		detailParts.push(`*Column*\n${card.column.name}`);
	}
	const contextParts = [timestamp];
	if (card.golden) {
		contextParts.push("⭐ Golden");
	}

	return {
		text: `${slackEmoji} ${actor} ${label} card`,
		attachments: [
			{
				color: card.golden ? "#FFD700" : "#5c20b1",
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `*<${cardUrl}|#${cardUrl.match(/(\d+)\/?$/)?.[1] ?? card.id} ${title}>*`,
						},
					},
					...(descriptionBlock ? [descriptionBlock] : []),
					...(detailParts.length > 0 ? [{
						type: "section",
						fields: detailParts.map((part) => ({
							type: "mrkdwn",
							text: part,
						})),
					}] : []),
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: contextParts.join(" • "),
							},
						],
					},
				],
			},
		],
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/") {
			return new Response("ok");
		}

		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		const body = await request.text();

		const signature = request.headers.get("X-Webhook-Signature");
		console.log(`[webhook] Signature present: ${!!signature}`);
		if (signature && env.FIZZY_SIGNING_SECRET) {
			const valid = await verifySignature(
				body,
				signature,
				env.FIZZY_SIGNING_SECRET
			);
			if (!valid) {
				console.error("[webhook] Invalid signature, rejecting request");
				return new Response("Invalid signature", { status: 401 });
			}
			console.log("[webhook] Signature verified successfully");
		}

		let event: FizzyEvent;
		try {
			event = JSON.parse(body) as FizzyEvent;
		} catch {
			console.error("[webhook] Failed to parse JSON body");
			return new Response("Invalid JSON", { status: 400 });
		}

		console.log(`[webhook] Received event: action=${event.action} id=${event.id}`);
		console.log(`[webhook] Event creator: ${event.creator?.name ?? "unknown"}`);
		console.log(`[webhook] Eventable URL (before fixUrls): ${event.eventable.url}`);

		fixUrls(event);
		console.log(`[webhook] Eventable URL (after fixUrls): ${event.eventable.url}`);

		let cardDescription: string | null = null;
		if (!isCommentEvent(event) && env.FIZZY_API_TOKEN) {
			console.log(`[webhook] Fetching card description for non-comment event`);
			cardDescription = await fetchCardDescription(
				(event.eventable as FizzyCardEventable).url,
				env.FIZZY_API_TOKEN
			);
			console.log(`[webhook] Card description result: ${cardDescription ? cardDescription.slice(0, 100) : "(null)"}`);
		} else {
			console.log(`[webhook] Skipping description fetch: isComment=${isCommentEvent(event)} hasToken=${!!env.FIZZY_API_TOKEN}`);
		}

		const slackPayload = buildSlackPayload(event, cardDescription);
		console.log(`[webhook] Slack payload: ${JSON.stringify(slackPayload).slice(0, 500)}`);

		const slackResponse = await fetch(env.SLACK_WEBHOOK_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(slackPayload),
		});

		console.log(`[webhook] Slack response status: ${slackResponse.status}`);
		if (!slackResponse.ok) {
			const errorText = await slackResponse.text();
			console.error(`[webhook] Slack error: ${slackResponse.status} ${errorText}`);
			return new Response("Failed to forward to Slack", { status: 502 });
		}

		console.log("[webhook] Successfully forwarded to Slack");
		return new Response("OK", { status: 200 });
	},
};
