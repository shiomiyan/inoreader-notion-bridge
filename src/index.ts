import { Hono } from "hono";

import { type AiBinding, buildNotionMarkdown, resolveArticleMarkdown } from "./article";
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

export type Bindings = {
	AI: AiBinding;
	NOTION_API_KEY: string;
	NOTION_DATA_SOURCE_ID?: string;
	NOTION_DATABASE_ID?: string;
	INOREADER_RULE_NAME: string;
};

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
	const payload = await c.req.json<InoreaderWebhookRequestBody>();
	const items = parseWebhookPayload(payload);

	if (items.length === 0) {
		return Response.json(
			{ success: false, error: "No valid items found in webhook payload" },
			{ status: 400 },
		);
	}

	const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
	c.executionCtx.waitUntil(processWebhook(items, c.env, requestId));

	return Response.json(
		{
			accepted: true,
			queued: items.length,
			requestId,
		},
		{ status: 202 },
	);
});

async function processWebhook(items: ParsedInoreaderItem[], env: Bindings, requestId: string) {
	console.log("Webhook processing started", {
		requestId,
		itemCount: items.length,
	});

	try {
		const parent = await resolveNotionParent(fetch, env.NOTION_API_KEY, env);
		const results: ProcessResult[] = [];

		for (const item of items) {
			results.push(await processItem(item, env, parent, requestId));
		}

		const created = results.filter((result) => result.status === "created").length;
		const updated = results.filter((result) => result.status === "updated").length;
		const failed = results.filter((result) => result.status === "failed").length;
		const logPayload = {
			requestId,
			created,
			updated,
			failed,
			results,
		};

		if (failed > 0) {
			console.error("Webhook processing completed with failures", logPayload);
			return;
		}

		console.log("Webhook processing completed", logPayload);
	} catch (error) {
		console.error("Webhook processing crashed", {
			requestId,
			error: serializeError(error),
		});
	}
}

async function processItem(
	item: ParsedInoreaderItem,
	env: Bindings,
	parent: Awaited<ReturnType<typeof resolveNotionParent>>,
	requestId: string,
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
			requestId,
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

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function serializeError(error: unknown) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			...(typeof error === "object" ? error : {}),
		};
	}

	return error;
}

export { app };

export default {
	fetch: app.fetch,
};
