import type { ParsedInoreaderItem } from "./inoreader";

const NOTION_VERSION = "2026-03-11";

type NotionParent =
	| {
			type: "data_source";
			id: string;
	  }
	| {
			type: "database";
			id: string;
	  };

type QueryResult = {
	results: Array<Record<string, unknown>>;
	has_more?: boolean;
	next_cursor?: string | null;
};

export class NotionApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body?: unknown,
	) {
		super(message);
		this.name = "NotionApiError";
	}
}

export function resolveNotionParent(env: {
	NOTION_DATA_SOURCE_ID?: string;
	NOTION_DATABASE_ID?: string;
}): NotionParent {
	if (env.NOTION_DATA_SOURCE_ID) {
		return {
			type: "data_source",
			id: env.NOTION_DATA_SOURCE_ID,
		};
	}

	if (env.NOTION_DATABASE_ID) {
		return {
			type: "database",
			id: env.NOTION_DATABASE_ID,
		};
	}

	throw new Error("NOTION_DATA_SOURCE_ID or NOTION_DATABASE_ID is required");
}

export async function findExistingNotionPageByUrl(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	parent: NotionParent,
	url: string,
): Promise<string | null> {
	try {
		const result = await queryPages(fetchImpl, notionApiKey, parent, {
			filter: {
				property: "URL",
				url: {
					equals: url,
				},
			},
			page_size: 1,
		});

		return getPageId(result.results[0]) ?? null;
	} catch (error) {
		if (!(error instanceof NotionApiError) || error.status !== 400) {
			throw error;
		}
	}

	let nextCursor: string | null | undefined;

	do {
		const result = await queryPages(fetchImpl, notionApiKey, parent, {
			page_size: 100,
			start_cursor: nextCursor ?? undefined,
		});

		for (const page of result.results) {
			if (readUrlProperty(page) === url) {
				return getPageId(page) ?? null;
			}
		}

		nextCursor = result.has_more ? result.next_cursor : null;
	} while (nextCursor);

	return null;
}

export async function createOrUpdateNotionPage(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	parent: NotionParent,
	item: ParsedInoreaderItem,
	markdown: string,
	existingPageId: string | null,
): Promise<"created" | "updated"> {
	if (!existingPageId) {
		await notionRequest(fetchImpl, notionApiKey, "/v1/pages", {
			method: "POST",
			body: JSON.stringify({
				parent:
					parent.type === "data_source"
						? { data_source_id: parent.id }
						: { database_id: parent.id },
				properties: buildPageProperties(item),
				markdown,
			}),
		});

		return "created";
	}

	await notionRequest(fetchImpl, notionApiKey, `/v1/pages/${existingPageId}`, {
		method: "PATCH",
		body: JSON.stringify({
			properties: buildPageProperties(item),
		}),
	});

	await notionRequest(fetchImpl, notionApiKey, `/v1/pages/${existingPageId}/markdown`, {
		method: "PATCH",
		body: JSON.stringify({
			type: "replace_content",
			replace_content: {
				new_str: markdown,
			},
		}),
	});

	return "updated";
}

async function queryPages(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	parent: NotionParent,
	body: Record<string, unknown>,
): Promise<QueryResult> {
	const path =
		parent.type === "data_source"
			? `/v1/data_sources/${parent.id}/query`
			: `/v1/databases/${parent.id}/query`;

	return await notionRequest<QueryResult>(fetchImpl, notionApiKey, path, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

async function notionRequest<T>(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	path: string,
	init: RequestInit,
): Promise<T> {
	const response = await fetchImpl(`https://api.notion.com${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${notionApiKey}`,
			"Content-Type": "application/json",
			"Notion-Version": NOTION_VERSION,
			...(init.headers ?? {}),
		},
	});

	const text = await response.text();
	const body = text ? safeJsonParse(text) : undefined;

	if (!response.ok) {
		throw new NotionApiError(
			`Notion API request failed with status ${response.status}`,
			response.status,
			body,
		);
	}

	return body as T;
}

function buildPageProperties(item: ParsedInoreaderItem) {
	return {
		Title: {
			title: [
				{
					type: "text",
					text: {
						content: item.title,
						link: { url: item.url },
					},
				},
			],
		},
		URL: {
			url: item.url,
		},
	};
}

function getPageId(page: Record<string, unknown> | undefined): string | undefined {
	return typeof page?.id === "string" ? page.id : undefined;
}

function readUrlProperty(page: Record<string, unknown>): string | undefined {
	const properties = page.properties;
	if (!properties || typeof properties !== "object") {
		return undefined;
	}

	const urlProperty = (properties as Record<string, unknown>).URL;
	if (!urlProperty || typeof urlProperty !== "object") {
		return undefined;
	}

	return typeof (urlProperty as { url?: unknown }).url === "string"
		? ((urlProperty as { url: string }).url ?? undefined)
		: undefined;
}

function safeJsonParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}
