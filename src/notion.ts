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

export type NotionWriteResult = {
	outcome: "created" | "updated";
	usedWafFallback: boolean;
	wafBlock?: {
		status: number;
		path: string;
		notionVersion: string;
		cloudflareRayId?: string;
	};
};

export class NotionApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly path: string,
		readonly notionVersion: string,
		readonly body?: unknown,
		readonly wafBlocked: boolean = false,
		readonly cloudflareRayId?: string,
	) {
		super(message);
		this.name = "NotionApiError";
	}
}

export async function resolveParent(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	env: NotionParentEnv,
): Promise<NotionParent> {
	if (env.NOTION_DATABASE_ID) {
		return await resolveDataSourceParent(fetchImpl, notionApiKey, {
			type: "database",
			id: env.NOTION_DATABASE_ID,
		});
	}

	throw new Error("NOTION_DATABASE_ID is required");
}

export async function getPageIdByUrl(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	parent: NotionParent,
	url: string,
): Promise<string | null> {
	try {
		const result = await query(fetchImpl, notionApiKey, parent, {
			filter: {
				property: "url",
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
		const result = await query(fetchImpl, notionApiKey, parent, {
			page_size: 100,
			start_cursor: nextCursor ?? undefined,
		});

		for (const page of result.results) {
			if (getUrl(page) === url) {
				return getPageId(page) ?? null;
			}
		}

		nextCursor = result.has_more ? result.next_cursor : null;
	} while (nextCursor);

	return null;
}

export async function upsertPage(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	parent: NotionParent,
	item: ParsedInoreaderItem,
	markdown: string,
	existingPageId: string | null,
): Promise<NotionWriteResult> {
	const updatedAt = new Date().toISOString();

	if (!existingPageId) {
		try {
			await request(fetchImpl, notionApiKey, "/v1/pages", NOTION_CONTENT_VERSION, {
				method: "POST",
				body: JSON.stringify({
					parent:
						parent.type === "data_source"
							? { data_source_id: parent.id }
							: { database_id: parent.id },
					properties: buildProperties(item, updatedAt),
					markdown,
				}),
			});
		} catch (error) {
			if (!isCloudflareWafBlock(error)) {
				throw error;
			}

			await createFallbackPage(fetchImpl, notionApiKey, parent, item, updatedAt);

			return {
				outcome: "created",
				usedWafFallback: true,
				wafBlock: {
					status: error.status,
					path: error.path,
					notionVersion: error.notionVersion,
					cloudflareRayId: error.cloudflareRayId,
				},
			};
		}

		return {
			outcome: "created",
			usedWafFallback: false,
		};
	}

	await request(
		fetchImpl,
		notionApiKey,
		`/v1/pages/${existingPageId}`,
		NOTION_CONTENT_VERSION,
		{
			method: "PATCH",
			body: JSON.stringify({
				properties: buildProperties(item, updatedAt),
			}),
		},
	);

	try {
		await request(
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
	} catch (error) {
		if (!isCloudflareWafBlock(error)) {
			throw error;
		}

		return {
			outcome: "updated",
			usedWafFallback: true,
			wafBlock: {
				status: error.status,
				path: error.path,
				notionVersion: error.notionVersion,
				cloudflareRayId: error.cloudflareRayId,
			},
		};
	}

	return {
		outcome: "updated",
		usedWafFallback: false,
	};
}

async function query(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	parent: NotionParent,
	body: Record<string, unknown>,
): Promise<QueryResult> {
	const path =
		parent.type === "data_source"
			? `/v1/data_sources/${parent.id}/query`
			: `/v1/databases/${parent.id}/query`;

	return await request<QueryResult>(fetchImpl, notionApiKey, path, NOTION_QUERY_VERSION, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

async function request<T>(
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
			"User-Agent": "Inoreader-Notion-Bridge/1.0",
			...(init.headers ?? {}),
		},
	});

	const text = await response.text();
	const body = text ? safeJsonParse(text) : undefined;
	const cloudflareRayId = response.headers.get("cf-ray");
	const wafBlocked = isCloudflareWafResponse(response.status, text, cloudflareRayId);

	if (!response.ok) {
		throw new NotionApiError(
			`Notion API request failed with status ${response.status} for ${path} (${notionVersion})`,
			response.status,
			path,
			notionVersion,
			body,
			wafBlocked,
			cloudflareRayId ?? undefined,
		);
	}

	return body as T;
}

export function isCloudflareWafBlock(error: unknown): error is NotionApiError {
	return error instanceof NotionApiError && error.wafBlocked;
}

async function resolveDataSourceParent(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	parent: NotionParent,
): Promise<NotionParent> {
	if (parent.type === "database") {
		return await getPrimaryDataSource(fetchImpl, notionApiKey, parent.id);
	}

	try {
		await request(
			fetchImpl,
			notionApiKey,
			`/v1/data_sources/${parent.id}`,
			NOTION_QUERY_VERSION,
			{ method: "GET" },
		);

		return parent;
	} catch (error) {
		if (!isWrongParentError(error)) {
			throw error;
		}

		return await getPrimaryDataSource(fetchImpl, notionApiKey, parent.id);
	}
}

async function getPrimaryDataSource(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	databaseId: string,
): Promise<NotionParent> {
	const database = await request<{
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
		id: dataSourceId,
	};
}

async function createFallbackPage(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	parent: NotionParent,
	item: ParsedInoreaderItem,
	updatedAt: string,
): Promise<void> {
	await request(fetchImpl, notionApiKey, "/v1/pages", NOTION_CONTENT_VERSION, {
		method: "POST",
		body: JSON.stringify({
			parent:
				parent.type === "data_source"
					? { data_source_id: parent.id }
					: { database_id: parent.id },
			properties: buildProperties(item, updatedAt),
			markdown: "本文保存が Cloudflare WAF によりブロックされました。",
		}),
	});
}

function buildProperties(item: ParsedInoreaderItem, updatedAt: string) {
	return {
		title: {
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
		url: {
			url: item.url,
		},
		updated: {
			date: {
				start: updatedAt,
			},
		},
	};
}

function getPageId(page: Record<string, unknown> | undefined): string | undefined {
	return typeof page?.id === "string" ? page.id : undefined;
}

function getUrl(page: Record<string, unknown>): string | undefined {
	const properties = page.properties;
	if (!properties || typeof properties !== "object") {
		return undefined;
	}

	const urlProperty = (properties as Record<string, unknown>).url;
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

function isCloudflareWafResponse(
	status: number,
	bodyText: string,
	cloudflareRayId: string | null,
): boolean {
	if (status !== 403) {
		return false;
	}

	if (!cloudflareRayId) {
		return false;
	}

	return (
		bodyText.includes("Attention Required! | Cloudflare") ||
		bodyText.includes("Sorry, you have been blocked")
	);
}

function isWrongParentError(error: unknown): error is NotionApiError {
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
