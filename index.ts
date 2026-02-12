export interface Env {
	SLACK_WEBHOOK_URL: string;
	FIZZY_SIGNING_SECRET: string;
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

function buildSlackPayload(event: FizzyEvent) {
	const action = event.action as FizzyAction;
	const emoji = getActionEmoji(action);
	const label = ACTION_LABELS[action] ?? action;
	const actor = event.creator?.name ?? "Someone";

	if (isCommentEvent(event)) {
		const comment = event.eventable;
		const plainText = comment.body.plain_text;
		const truncated =
			plainText.length > 300 ? plainText.slice(0, 300) + "…" : plainText;

		return {
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `${emoji} *${actor}* commented on a card in *${event.board.name}*`,
					},
				},
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `> ${truncated}`,
					},
				},
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `<${comment.url}|View comment>`,
						},
					],
				},
			],
		};
	}

	const card = event.eventable as FizzyCardEventable;
	const title = card.title;
	const cardUrl = card.url;

	const fields: { type: string; text: string }[] = [];

	if (card.column) {
		fields.push({ type: "mrkdwn", text: `*Column:* ${card.column.name}` });
	}
	fields.push({ type: "mrkdwn", text: `*Board:* ${event.board.name}` });
	if (card.golden) {
		fields.push({ type: "mrkdwn", text: `*Golden:* ⭐ Yes` });
	}

	const blocks: Record<string, unknown>[] = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `${emoji} *${actor}* ${label} *<${cardUrl}|${title}>*`,
			},
		},
	];

	if (fields.length > 0) {
		blocks.push({
			type: "section",
			fields,
		});
	}

	blocks.push({
		type: "context",
		elements: [
			{
				type: "mrkdwn",
				text: `${event.board.name} • ${new Date(event.created_at).toLocaleString("en-US", { timeZone: "UTC" })}`,
			},
		],
	});

	return { blocks };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		const body = await request.text();

		const signature = request.headers.get("X-Webhook-Signature");
		if (signature && env.FIZZY_SIGNING_SECRET) {
			const valid = await verifySignature(
				body,
				signature,
				env.FIZZY_SIGNING_SECRET
			);
			if (!valid) {
				return new Response("Invalid signature", { status: 401 });
			}
		}

		let event: FizzyEvent;
		try {
			event = JSON.parse(body) as FizzyEvent;
		} catch {
			return new Response("Invalid JSON", { status: 400 });
		}

		const slackPayload = buildSlackPayload(event);

		const slackResponse = await fetch(env.SLACK_WEBHOOK_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(slackPayload),
		});

		if (!slackResponse.ok) {
			const errorText = await slackResponse.text();
			console.error(`Slack error: ${slackResponse.status} ${errorText}`);
			return new Response("Failed to forward to Slack", { status: 502 });
		}

		return new Response("OK", { status: 200 });
	},
};
