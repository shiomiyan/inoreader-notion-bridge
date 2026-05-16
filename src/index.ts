import { Hono } from "hono";

import { saveArchiveMarkdown } from "./archive";
import { buildNotionMarkdown, resolveArticleMarkdown } from "./article";
import { type ParsedInoreaderItem, parseWebhookPayload, type StreamContents } from "./inoreader";
import { getDataSourceId, getPageIdByUrl, type NotionWriteResult, upsertPage } from "./notion";

export type Bindings = Env & {
	inoreader_notion_bridge_queue: Queue<ParsedInoreaderItem>;
	WEB_CLIPPINGS: R2Bucket;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", async (c, next) => {
	if (!c.req.header("x-inoreader-rule-name")?.includes(c.env.INOREADER_RULE_NAME)) {
		return new Response("Forbidden", { status: 403 });
	}

	await next();
});

app.post("/", async (c) => {
	let payload: StreamContents;

	try {
		payload = await c.req.json<StreamContents>();
	} catch {
		return new Response("Bad Request", { status: 400 });
	}

	const items = parseWebhookPayload(payload);
	if (items.length === 0) {
		return new Response("Bad Request", { status: 400 });
	}

	try {
		await c.env.inoreader_notion_bridge_queue.sendBatch(items.map((item) => ({ body: item })));
	} catch (error) {
		console.error("Failed to enqueue webhook items", {
			error: serializeError(error),
		});

		return new Response("Internal Server Error", { status: 500 });
	}

	return new Response(null, { status: 202 });
});

export async function processWebhookBatch(
	batch: MessageBatch<ParsedInoreaderItem>,
	env: Bindings,
): Promise<void> {
	const startedAt = Date.now();

	try {
		const dataSourceId = getDataSourceId(env);

		for (const message of batch.messages) {
			try {
				const result = await processItem(message.body, env, dataSourceId);
				if (result.usedWafFallback) {
					console.error("Notion request blocked by Cloudflare WAF; saved fallback page", {
						messageId: message.id,
						attempts: message.attempts,
						item: message.body,
						wafBlock: result.wafBlock,
					});
				}
				message.ack();
			} catch (error) {
				console.error("Failed to process queued item", {
					messageId: message.id,
					attempts: message.attempts,
					item: message.body,
					error: serializeError(error),
				});
				message.retry();
			}
		}
	} catch (error) {
		console.error("Failed to process queue batch", {
			queue: batch.queue,
			size: batch.messages.length,
			error: serializeError(error),
			durationMs: Date.now() - startedAt,
		});
		batch.retryAll();
	}
}

async function processItem(
	item: ParsedInoreaderItem,
	env: Bindings,
	dataSourceId: string,
): Promise<NotionWriteResult> {
	const existingPageId = await getPageIdByUrl(fetch, env.NOTION_API_KEY, dataSourceId, item.url);
	const articleMarkdown = await resolveArticleMarkdown(item, env.AI, fetch);
	const savedAt = new Date();
	const notionMarkdown = buildNotionMarkdown(item, articleMarkdown, savedAt);

	try {
		await saveArchiveMarkdown(env.WEB_CLIPPINGS, item, notionMarkdown, savedAt);
	} catch (error) {
		console.error("Failed to archive markdown to R2", {
			item,
			error: serializeError(error),
		});
	}

	return await upsertPage(
		fetch,
		env.NOTION_API_KEY,
		dataSourceId,
		item,
		notionMarkdown,
		existingPageId,
		savedAt,
	);
}

function serializeError(error: unknown) {
	if (error instanceof Error) {
		const serialized: Record<string, unknown> = {
			name: error.name,
			message: error.message,
		};

		if (error.stack) {
			serialized.stack = error.stack;
		}

		for (const key of [
			"status",
			"path",
			"notionVersion",
			"body",
			"wafBlocked",
			"cloudflareRayId",
		] as const) {
			if (key in error) {
				serialized[key] = (error as unknown as Record<string, unknown>)[key];
			}
		}

		return serialized;
	}

	return {
		message: String(error),
	};
}

export { app };

export default {
	fetch: app.fetch,
	queue: processWebhookBatch,
};
