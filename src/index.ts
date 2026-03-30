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

export type Bindings = Env & {
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

	const parent = await resolveNotionParent(fetch, c.env.NOTION_API_KEY, c.env);
	const results: ProcessResult[] = [];

	for (const item of items) {
		results.push(await processItem(item, c.env, parent));
	}

	const created = results.filter((result) => result.status === "created").length;
	const updated = results.filter((result) => result.status === "updated").length;
	const failed = results.filter((result) => result.status === "failed").length;

	return Response.json(
		{
			success: failed === 0,
			created,
			updated,
			failed,
			results,
		},
		{ status: failed === 0 ? 200 : 500 },
	);
});

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
		console.error("Failed to process item", { item, error });

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

export { app };

export default {
	fetch: app.fetch,
};
