import type { Context, ExecutionContext } from "hono";
import { Hono } from "hono";

import { buildNotionMarkdown, resolveArticleMarkdown } from "./article";
import {
	type InoreaderWebhookRequestBody,
	type ParsedInoreaderItem,
	parseWebhookPayload,
} from "./inoreader";
import {
	createOrUpdateNotionPage,
	findExistingNotionPageByUrl,
	resolveNotionParent,
} from "./notion";

export type Bindings = Env & {};

export type ProcessResult = {
	title: string;
	url: string;
	status: "created" | "updated" | "failed";
	error?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", async (c, next) => {
	if (!c.req.header("x-inoreader-rule-name")?.includes(c.env.INOREADER_RULE_NAME)) {
		return new Response("Forbidden", { status: 403 });
	}

	await next();
});

app.post("/", async (c) => {
	let payload: InoreaderWebhookRequestBody;

	try {
		payload = await c.req.json<InoreaderWebhookRequestBody>();
	} catch {
		return new Response("Bad Request", { status: 400 });
	}

	const items = parseWebhookPayload(payload);

	if (items.length === 0) {
		return new Response("Bad Request", { status: 400 });
	}

	const processing = processWebhook(items, c.env);

	try {
		const executionCtx = tryGetExecutionContext(c);

		if (executionCtx) {
			executionCtx.waitUntil(processing);
		} else {
			await processing;
		}
	} catch (error) {
		console.error("Failed to accept webhook", {
			error: serializeError(error),
		});

		return new Response("Internal Server Error", { status: 500 });
	}

	return new Response(null, { status: 202 });
});

async function processWebhook(
	items: ParsedInoreaderItem[],
	env: Bindings,
): Promise<void> {
	const startedAt = Date.now();

	try {
		const parent = await resolveNotionParent(fetch, env.NOTION_API_KEY, env);
		const results: ProcessResult[] = [];

		for (const item of items) {
			results.push(await processItem(item, env, parent));
		}

		if (results.some((result) => result.status === "failed")) {
			console.error("Inoreader webhook completed with failures", {
				failures: results.filter((result) => result.status === "failed"),
				durationMs: Date.now() - startedAt,
			});
		}
	} catch (error) {
		console.error("Failed to process webhook", {
			error: serializeError(error),
			durationMs: Date.now() - startedAt,
		});
	}
}

async function processItem(
	item: ParsedInoreaderItem,
	env: Bindings,
	parent: Awaited<ReturnType<typeof resolveNotionParent>>,
): Promise<ProcessResult> {
	try {
		const existingPageId = await findExistingNotionPageByUrl(
			fetch,
			env.NOTION_API_KEY,
			parent,
			item.url,
		);
		const articleMarkdown = await resolveArticleMarkdown(item, env.AI, fetch);
		const notionMarkdown = buildNotionMarkdown(item, articleMarkdown);
		const status = await createOrUpdateNotionPage(
			fetch,
			env.NOTION_API_KEY,
			parent,
			item,
			notionMarkdown,
			existingPageId,
		);

		return {
			title: item.title,
			url: item.url,
			status,
		};
	} catch (error) {
		console.error("Failed to process item", {
			item,
			error: serializeError(error),
		});

		return {
			title: item.title,
			url: item.url,
			status: "failed",
			error: toErrorMessage(error),
		};
	}
}

function tryGetExecutionContext(
	context: Context<{ Bindings: Bindings }>,
): ExecutionContext | undefined {
	try {
		return context.executionCtx;
	} catch {
		return undefined;
	}
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

		for (const key of ["status", "path", "notionVersion", "body"] as const) {
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
};
