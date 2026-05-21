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

	console.log("Accepted Inoreader webhook", {
		itemCount: items.length,
		items: items.map(summarizeItem),
	});

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
	console.log("Starting queue batch", {
		queue: batch.queue,
		size: batch.messages.length,
	});

	try {
		const dataSourceId = getDataSourceId(env);

		for (const message of batch.messages) {
			const itemContext = summarizeItem(message.body);
			const messageStartedAt = Date.now();
			console.log("Processing queued item", {
				messageId: message.id,
				attempts: message.attempts,
				item: itemContext,
			});

			try {
				const result = await processItem(message.body, env, dataSourceId, {
					messageId: message.id,
					attempts: message.attempts,
				});
				if (result.usedWafFallback) {
					console.error("Notion request blocked by Cloudflare WAF; saved fallback page", {
						messageId: message.id,
						attempts: message.attempts,
						item: itemContext,
						wafBlock: result.wafBlock,
					});
				}
				console.log("Processed queued item", {
					messageId: message.id,
					attempts: message.attempts,
					item: itemContext,
					outcome: result.outcome,
					usedWafFallback: result.usedWafFallback,
					durationMs: Date.now() - messageStartedAt,
				});
				message.ack();
			} catch (error) {
				console.error("Failed to process queued item", {
					messageId: message.id,
					attempts: message.attempts,
					item: itemContext,
					error: serializeError(error),
					durationMs: Date.now() - messageStartedAt,
				});
				message.retry();
			}
		}

		console.log("Finished queue batch", {
			queue: batch.queue,
			size: batch.messages.length,
			durationMs: Date.now() - startedAt,
		});
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
	context?: {
		messageId: string;
		attempts: number;
	},
): Promise<NotionWriteResult> {
	const itemContext = summarizeItem(item);
	console.log("Resolving Notion page state", {
		...context,
		item: itemContext,
	});
	const existingPageId = await getPageIdByUrl(fetch, env.NOTION_API_KEY, dataSourceId, item.url);
	console.log("Resolved Notion page state", {
		...context,
		item: itemContext,
		existingPageId: existingPageId ?? undefined,
	});
	const articleMarkdown = await resolveArticleMarkdown(item, env.AI, fetch, env.BROWSER);
	const savedAt = new Date();
	const notionMarkdown = buildNotionMarkdown(item, articleMarkdown, savedAt);
	console.log("Prepared markdown payloads", {
		...context,
		item: itemContext,
		articleMarkdownLength: articleMarkdown.length,
		notionMarkdownLength: notionMarkdown.length,
		savedAt: savedAt.toISOString(),
	});

	try {
		const archiveKey = await saveArchiveMarkdown(env.WEB_CLIPPINGS, item, notionMarkdown, savedAt);
		console.log("Archived markdown to R2", {
			...context,
			item: itemContext,
			archiveKey,
		});
	} catch (error) {
		console.error("Failed to archive markdown to R2", {
			...context,
			item: itemContext,
			error: serializeError(error),
		});
	}

	const notionResult = await upsertPage(
		fetch,
		env.NOTION_API_KEY,
		dataSourceId,
		item,
		notionMarkdown,
		existingPageId,
		savedAt,
	);

	console.log("Persisted page to Notion", {
		...context,
		item: itemContext,
		existingPageId: existingPageId ?? undefined,
		outcome: notionResult.outcome,
		usedWafFallback: notionResult.usedWafFallback,
	});

	return notionResult;
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

function summarizeItem(item: ParsedInoreaderItem) {
	let hostname: string | undefined;

	try {
		hostname = new URL(item.url).hostname;
	} catch {}

	return {
		title: item.title,
		url: item.url,
		hostname,
		hasSummaryHtml: Boolean(item.summaryHtml),
		summaryHtmlLength: item.summaryHtml?.length,
		author: item.author,
		published: item.published,
		feedTitle: item.feedTitle,
	};
}

export { app };

export default {
	fetch: app.fetch,
	queue: processWebhookBatch,
};
