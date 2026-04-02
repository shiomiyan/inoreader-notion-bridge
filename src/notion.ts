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

export const getDataSourceId = (env: Pick<Env, "NOTION_DATA_SOURCE_ID">): string => {
	if (!env.NOTION_DATA_SOURCE_ID) {
		throw new Error("Missing NOTION_DATA_SOURCE_ID");
	}

	return env.NOTION_DATA_SOURCE_ID;
};

export const getPageIdByUrl = async (
	fetchImpl: typeof fetch,
	notionApiKey: string,
	dataSourceId: string,
	url: string,
): Promise<string | null> => {
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
};

export const upsertPage = async (
	fetchImpl: typeof fetch,
	notionApiKey: string,
	dataSourceId: string,
	item: ParsedInoreaderItem,
	markdown: string,
	existingPageId: string | null,
): Promise<NotionWriteResult> => {
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
};

const query = async (
	fetchImpl: typeof fetch,
	notionApiKey: string,
	dataSourceId: string,
	body: Record<string, unknown>,
): Promise<QueryResult> => {
	return await request<QueryResult>(
		fetchImpl,
		notionApiKey,
		`/v1/data_sources/${dataSourceId}/query`,
		{
			method: "POST",
			body: JSON.stringify(body),
		},
	);
};

const request = async <T>(
	fetchImpl: typeof fetch,
	notionApiKey: string,
	path: string,
	init: RequestInit,
): Promise<T> => {
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
	const cloudflareRayId = response.headers.get("cf-ray");
	const wafBlocked = isCloudflareWafResponse(response.status, text, cloudflareRayId);
	const body = text ? parseJson(text) : undefined;

	if (text && body === undefined) {
		console.error("Invalid Notion response", {
			status: response.status,
			path,
			cloudflareRayId: cloudflareRayId ?? undefined,
		});

		throw new NotionApiError(
			"Invalid response",
			response.status,
			path,
			NOTION_VERSION,
			undefined,
			wafBlocked,
			cloudflareRayId ?? undefined,
		);
	}

	if (!response.ok) {
		throw new NotionApiError(
			`Request failed: ${response.status}`,
			response.status,
			path,
			NOTION_VERSION,
			body,
			wafBlocked,
			cloudflareRayId ?? undefined,
		);
	}

	return body as T;
};

export const isCloudflareWafBlock = (error: unknown): error is NotionApiError => {
	return error instanceof NotionApiError && error.wafBlocked;
};

const createFallbackPage = async (
	fetchImpl: typeof fetch,
	notionApiKey: string,
	dataSourceId: string,
	item: ParsedInoreaderItem,
	updatedAt: string,
): Promise<void> => {
	await request(fetchImpl, notionApiKey, "/v1/pages", {
		method: "POST",
		body: JSON.stringify({
			parent: { data_source_id: dataSourceId },
			properties: buildProperties(item, updatedAt),
			markdown: "本文保存が Cloudflare WAF によりブロックされました。",
		}),
	});
};

const buildProperties = (item: ParsedInoreaderItem, updatedAt: string) => {
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
};

const getPageId = (page: Record<string, unknown> | undefined): string | undefined => {
	return typeof page?.id === "string" ? page.id : undefined;
};

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

const isCloudflareWafResponse = (
	status: number,
	bodyText: string,
	cloudflareRayId: string | null,
): boolean => {
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
};
