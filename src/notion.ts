import type { ParsedInoreaderItem } from "./inoreader";

const NOTION_VERSION = "2026-03-11";

type QueryResult = {
	results: Array<Record<string, unknown>>;
};

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

export function getDataSourceId(env: Pick<Env, "NOTION_DATA_SOURCE_ID">): string {
	if (!env.NOTION_DATA_SOURCE_ID) {
		throw new Error("NOTION_DATA_SOURCE_ID is required");
	}

	return env.NOTION_DATA_SOURCE_ID;
}

export async function getPageIdByUrl(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	dataSourceId: string,
	url: string,
): Promise<string | null> {
	const result = await query(fetchImpl, notionApiKey, dataSourceId, {
		filter: {
			property: "url",
			url: {
				equals: url,
			},
		},
		page_size: 1,
	});

	return getPageId(result.results[0]) ?? null;
}

export async function upsertPage(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	dataSourceId: string,
	item: ParsedInoreaderItem,
	markdown: string,
	existingPageId: string | null,
): Promise<NotionWriteResult> {
	const updatedAt = new Date().toISOString();

	if (!existingPageId) {
		try {
			await request(fetchImpl, notionApiKey, "/v1/pages", {
				method: "POST",
				body: JSON.stringify({
					parent: { data_source_id: dataSourceId },
					properties: buildProperties(item, updatedAt),
					markdown,
				}),
			});
		} catch (error) {
			if (!isCloudflareWafBlock(error)) {
				throw error;
			}

			await createFallbackPage(fetchImpl, notionApiKey, dataSourceId, item, updatedAt);

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

	await request(fetchImpl, notionApiKey, `/v1/pages/${existingPageId}`, {
		method: "PATCH",
		body: JSON.stringify({
			properties: buildProperties(item, updatedAt),
		}),
	});

	try {
		await request(fetchImpl, notionApiKey, `/v1/pages/${existingPageId}/markdown`, {
			method: "PATCH",
			body: JSON.stringify({
				type: "replace_content",
				replace_content: {
					new_str: markdown,
				},
			}),
		});
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
	dataSourceId: string,
	body: Record<string, unknown>,
): Promise<QueryResult> {
	return await request<QueryResult>(
		fetchImpl,
		notionApiKey,
		`/v1/data_sources/${dataSourceId}/query`,
		{
			method: "POST",
			body: JSON.stringify(body),
		},
	);
}

async function request<T>(
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
			`Notion API request failed with status ${response.status} for ${path} (${NOTION_VERSION})`,
			response.status,
			path,
			NOTION_VERSION,
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

async function createFallbackPage(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	dataSourceId: string,
	item: ParsedInoreaderItem,
	updatedAt: string,
): Promise<void> {
	await request(fetchImpl, notionApiKey, "/v1/pages", {
		method: "POST",
		body: JSON.stringify({
			parent: { data_source_id: dataSourceId },
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
