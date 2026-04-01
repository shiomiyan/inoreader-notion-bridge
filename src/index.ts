import { Hono } from "hono";
import type { Context, ExecutionContext } from "hono";

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

export type Bindings = Env & {
};

export type ProcessResult = {
	title: string;
	url: string;
	status: "created" | "updated" | "failed";
	error?: string;
};

type ProcessSummary = {
	created: number;
	updated: number;
	failed: number;
	results: ProcessResult[];
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", async (c, next) => {
	if (!c.req.header("x-inoreader-rule-name")?.includes(c.env.INOREADER_RULE_NAME)) {
		return new Response("Forbidden", { status: 403 });
	}

	await next();
});

app.post("/", async (c) => {
	const payload = await c.req.json<InoreaderWebhookRequestBody>();
	const items = parseWebhookPayload(payload);

	if (items.length === 0) {
		return Response.json(
			{ success: false, error: "No valid items found in webhook payload" },
			{ status: 400 },
		);
	}

	const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
	const processing = processWebhook(items, c.env, requestId);
	const executionCtx = tryGetExecutionContext(c);

	if (executionCtx) {
		executionCtx.waitUntil(processing);

		return Response.json({
			success: true,
			accepted: items.length,
			processing: "async",
			requestId,
		});
	}

	const summary = await processing;
	return Response.json(
		{
			success: summary.failed === 0,
			created: summary.created,
			updated: summary.updated,
			failed: summary.failed,
			results: summary.results,
			requestId,
		},
		{ status: summary.failed === 0 ? 200 : 500 },
	);
});

async function processWebhook(
	items: ParsedInoreaderItem[],
	env: Bindings,
	requestId: string,
): Promise<ProcessSummary> {
	const startedAt = Date.now();

	try {
		const parent = await resolveNotionParent(fetch, env.NOTION_API_KEY, env);
		const results: ProcessResult[] = [];

		for (const item of items) {
			results.push(await processItem(item, env, parent));
		}

		const summary = summarizeResults(results);
		if (summary.failed > 0) {
			console.error("Inoreader webhook completed with failures", {
				requestId,
				failures: summary.results.filter((result) => result.status === "failed"),
				durationMs: Date.now() - startedAt,
			});
		}

		return summary;
	} catch (error) {
		console.error("Failed to process webhook", {
			requestId,
			error: serializeError(error),
			durationMs: Date.now() - startedAt,
		});

		return {
			created: 0,
			updated: 0,
			failed: items.length,
			results: items.map((item) => ({
				title: item.title,
				url: item.url,
				status: "failed",
				error: toErrorMessage(error),
			})),
		};
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

function summarizeResults(results: ProcessResult[]): ProcessSummary {
	return {
		created: results.filter((result) => result.status === "created").length,
		updated: results.filter((result) => result.status === "updated").length,
		failed: results.filter((result) => result.status === "failed").length,
		results,
	};
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
