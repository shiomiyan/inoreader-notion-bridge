import type { ParsedInoreaderItem } from "./inoreader";

const NOTION_QUERY_VERSION = "2025-09-03";
const NOTION_CONTENT_VERSION = "2026-03-11";

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

type NotionParentEnv = Pick<Env, "NOTION_DATABASE_ID">;

export class NotionApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly path: string,
		readonly notionVersion: string,
		readonly body?: unknown,
	) {
		super(message);
		this.name = "NotionApiError";
	}
}

export async function resolveNotionParent(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	env: NotionParentEnv,
): Promise<NotionParent> {
	if (env.NOTION_DATABASE_ID) {
		return await ensureDataSourceParent(fetchImpl, notionApiKey, {
			type: "database",
			id: normalizeNotionId(env.NOTION_DATABASE_ID),
		});
	}

	throw new Error("NOTION_DATABASE_ID is required");
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
		await notionRequest(fetchImpl, notionApiKey, "/v1/pages", NOTION_CONTENT_VERSION, {
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

	await notionRequest(
		fetchImpl,
		notionApiKey,
		`/v1/pages/${existingPageId}`,
		NOTION_CONTENT_VERSION,
		{
			method: "PATCH",
			body: JSON.stringify({
				properties: buildPageProperties(item),
			}),
		},
	);

	await notionRequest(
		fetchImpl,
		notionApiKey,
		`/v1/pages/${existingPageId}/markdown`,
		NOTION_CONTENT_VERSION,
		{
			method: "PATCH",
			body: JSON.stringify({
				type: "replace_content",
				replace_content: {
					new_str: markdown,
				},
			}),
		},
	);

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

	return await notionRequest<QueryResult>(fetchImpl, notionApiKey, path, NOTION_QUERY_VERSION, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

async function notionRequest<T>(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	path: string,
	notionVersion: string,
	init: RequestInit,
): Promise<T> {
	const response = await fetchImpl(`https://api.notion.com${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${notionApiKey}`,
			"Content-Type": "application/json",
			"Notion-Version": notionVersion,
			...(init.headers ?? {}),
		},
	});

	const text = await response.text();
	const body = text ? safeJsonParse(text) : undefined;

	if (!response.ok) {
		throw new NotionApiError(
			`Notion API request failed with status ${response.status} for ${path} (${notionVersion})`,
			response.status,
			path,
			notionVersion,
			body,
		);
	}

	return body as T;
}

async function ensureDataSourceParent(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	parent: NotionParent,
): Promise<NotionParent> {
	if (parent.type === "database") {
		return await discoverDataSourceParent(fetchImpl, notionApiKey, parent.id);
	}

	try {
		await notionRequest(
			fetchImpl,
			notionApiKey,
			`/v1/data_sources/${parent.id}`,
			NOTION_QUERY_VERSION,
			{ method: "GET" },
		);

		return parent;
	} catch (error) {
		if (!looksLikeWrongParentId(error)) {
			throw error;
		}

		return await discoverDataSourceParent(fetchImpl, notionApiKey, parent.id);
	}
}

async function discoverDataSourceParent(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	databaseId: string,
): Promise<NotionParent> {
	const database = await notionRequest<{
		data_sources?: Array<{ id?: string }>;
	}>(fetchImpl, notionApiKey, `/v1/databases/${databaseId}`, NOTION_QUERY_VERSION, {
		method: "GET",
	});

	const dataSourceId = database.data_sources?.[0]?.id;
	if (!dataSourceId) {
		throw new Error(`No data source found for database ${databaseId}`);
	}

	return {
		type: "data_source",
		id: normalizeNotionId(dataSourceId),
	};
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

function normalizeNotionId(value: string): string {
	const trimmed = value.trim();
	const directMatch = trimmed.match(/^[0-9a-fA-F-]{32,36}$/);
	if (directMatch) {
		return trimmed;
	}

	const extracted = trimmed.match(
		/([0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})/,
	);
	if (extracted) {
		return extracted[1];
	}

	return trimmed;
}

function looksLikeWrongParentId(error: unknown): error is NotionApiError {
	if (!(error instanceof NotionApiError)) {
		return false;
	}

	if (error.status !== 400 && error.status !== 404) {
		return false;
	}

	const code =
		error.body && typeof error.body === "object" && "code" in error.body
			? (error.body as { code?: unknown }).code
			: undefined;

	return code === "invalid_request_url" || code === "object_not_found";
}
