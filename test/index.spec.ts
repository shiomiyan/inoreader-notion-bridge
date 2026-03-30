import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildNotionMarkdown } from "../src/article";
import { app } from "../src/index";
import type { InoreaderWebhookRequestBody } from "../src/inoreader";
import samplePayload from "./inoreader.req.json";

type MockFetch = typeof fetch & {
	mock: ReturnType<typeof vi.fn>;
};

type MockExecutionContext = ExecutionContext & {
	flush: () => Promise<void>;
};

describe("inoreader notion bridge", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-29T01:02:03.000Z"));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns 403 when rule header does not match", async () => {
		const executionContext = createExecutionContext();
		const response = await app.fetch(
			new Request("https://example.com/", {
				method: "POST",
				body: JSON.stringify(samplePayload),
				headers: { "Content-Type": "application/json" },
			}),
			createEnv(),
			executionContext,
		);

		expect(response.status).toBe(403);
		await executionContext.flush();
	});

	it("creates pages for multiple items and converts fetched HTML with AI", async () => {
		const payload: InoreaderWebhookRequestBody = {
			...samplePayload,
			items: [
				samplePayload.items[0],
				{
					...samplePayload.items[0],
					title: "2本目の記事",
					canonical: [{ href: "https://example.com/second" }],
				},
			],
		};

		const fetchMock = createFetchMock(async (input, init) => {
			const url = getUrl(input);

			if (url === "https://api.notion.com/v1/data_sources/notion-ds") {
				return jsonResponse({ id: "notion-ds" });
			}

			if (url.startsWith("https://api.notion.com/v1/data_sources/notion-ds/query")) {
				return jsonResponse({ results: [], has_more: false, next_cursor: null });
			}

			if (url === "https://api.notion.com/v1/pages" && init?.method === "POST") {
				return jsonResponse({ id: "created-page" });
			}

			if (url === "https://example.com/" || url === "https://example.com/second") {
				return new Response("<html><body><h1>Ignored</h1><p>Article body</p></body></html>", {
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}

			throw new Error(`Unhandled fetch for ${url}`);
		});

		const ai = {
			toMarkdown: vi
				.fn()
				.mockResolvedValueOnce({
					format: "markdown",
					data: "# テストテストテスト\n\n本文A",
				})
				.mockResolvedValueOnce({
					format: "markdown",
					data: "# 2本目の記事\n\n本文B",
				}),
		};

		vi.stubGlobal("fetch", fetchMock);
		const executionContext = createExecutionContext();

		const response = await app.fetch(
			createRequest(payload),
			createEnv({ AI: ai }),
			executionContext,
		);
		const body = (await response.json()) as {
			accepted: boolean;
			queued: number;
			requestId: string;
		};

		expect(response.status).toBe(202);
		expect(body).toMatchObject({
			accepted: true,
			queued: 2,
		});
		await executionContext.flush();
		expect(ai.toMarkdown).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://example.com/",
			expect.objectContaining({
				redirect: "follow",
				headers: expect.objectContaining({
					accept: "text/html,application/xhtml+xml",
				}),
			}),
		);

		const firstDocument = ai.toMarkdown.mock.calls[0][0];
		expect(firstDocument.name).toBe("article.html");
		expect(firstDocument.blob.type).toBe("text/html");
		expect(await firstDocument.blob.text()).toContain("Article body");
		expect(ai.toMarkdown.mock.calls[0][1]).toEqual({
			conversionOptions: {
				html: {
					hostname: "example.com",
				},
			},
		});
	});

	it("falls back to summary HTML when fetching article HTML fails", async () => {
		const fetchMock = createFetchMock(async (input, init) => {
			const url = getUrl(input);

			if (url === "https://api.notion.com/v1/data_sources/notion-ds") {
				return jsonResponse({ id: "notion-ds" });
			}

			if (url.startsWith("https://api.notion.com/v1/data_sources/notion-ds/query")) {
				return jsonResponse({ results: [], has_more: false, next_cursor: null });
			}

			if (url === "https://api.notion.com/v1/pages" && init?.method === "POST") {
				return jsonResponse({ id: "created-page" });
			}

			if (url === "https://example.com/") {
				return new Response("boom", { status: 500 });
			}

			throw new Error(`Unhandled fetch for ${url}`);
		});

		const ai = {
			toMarkdown: vi.fn().mockResolvedValue({
				format: "markdown",
				data: "# テストテストテスト\n\nsummary body",
			}),
		};

		vi.stubGlobal("fetch", fetchMock);
		const executionContext = createExecutionContext();

		const response = await app.fetch(
			createRequest(samplePayload),
			createEnv({ AI: ai }),
			executionContext,
		);

		expect(response.status).toBe(202);
		await executionContext.flush();
		const firstDocument = ai.toMarkdown.mock.calls[0][0];
		expect(await firstDocument.blob.text()).toContain("Webhook summary body");
	});

	it("updates existing page instead of creating a new one", async () => {
		const fetchMock = createFetchMock(async (input, init) => {
			const url = getUrl(input);

			if (url === "https://api.notion.com/v1/data_sources/notion-ds") {
				return jsonResponse({ id: "notion-ds" });
			}

			if (url.startsWith("https://api.notion.com/v1/data_sources/notion-ds/query")) {
				return jsonResponse({
					results: [
						{
							id: "page-123",
							properties: {
								URL: { url: "https://example.com/" },
							},
						},
					],
					has_more: false,
					next_cursor: null,
				});
			}

			if (url === "https://api.notion.com/v1/pages/page-123" && init?.method === "PATCH") {
				return jsonResponse({ id: "page-123" });
			}

			if (url === "https://api.notion.com/v1/pages/page-123/markdown" && init?.method === "PATCH") {
				return jsonResponse({ id: "page-123", markdown: "updated" });
			}

			if (url === "https://example.com/") {
				return new Response("<html><body><p>Article body</p></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			}

			throw new Error(`Unhandled fetch for ${url}`);
		});

		const ai = {
			toMarkdown: vi.fn().mockResolvedValue({
				format: "markdown",
				data: "# テストテストテスト\n\n本文A",
			}),
		};

		vi.stubGlobal("fetch", fetchMock);
		const executionContext = createExecutionContext();

		const response = await app.fetch(
			createRequest(samplePayload),
			createEnv({ AI: ai }),
			executionContext,
		);

		expect(response.status).toBe(202);
		await executionContext.flush();
		expect(fetchMock).not.toHaveBeenCalledWith(
			"https://api.notion.com/v1/pages",
			expect.anything(),
		);
	});

	it("returns 500 and aggregates failures per item", async () => {
		const payload: InoreaderWebhookRequestBody = {
			...samplePayload,
			items: [
				samplePayload.items[0],
				{
					...samplePayload.items[0],
					title: "成功する記事",
					canonical: [{ href: "https://example.com/success" }],
				},
			],
		};

		const fetchMock = createFetchMock(async (input, init) => {
			const url = getUrl(input);

			if (url === "https://api.notion.com/v1/data_sources/notion-ds") {
				return jsonResponse({ id: "notion-ds" });
			}

			if (url.startsWith("https://api.notion.com/v1/data_sources/notion-ds/query")) {
				return jsonResponse({ results: [], has_more: false, next_cursor: null });
			}

			if (url === "https://api.notion.com/v1/pages" && init?.method === "POST") {
				const body = parseJson(init?.body);
				if (body?.properties?.Title?.title?.[0]?.text?.content === "テストテストテスト") {
					return new Response(JSON.stringify({ message: "failure" }), { status: 500 });
				}

				return jsonResponse({ id: "created-page" });
			}

			if (url === "https://example.com/" || url === "https://example.com/success") {
				return new Response("<html><body><p>Article body</p></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			}

			throw new Error(`Unhandled fetch for ${url}`);
		});

		const ai = {
			toMarkdown: vi.fn().mockResolvedValue({
				format: "markdown",
				data: "# テストテストテスト\n\n本文A",
			}),
		};

		vi.stubGlobal("fetch", fetchMock);
		const executionContext = createExecutionContext();

		const response = await app.fetch(
			createRequest(payload),
			createEnv({ AI: ai }),
			executionContext,
		);

		expect(response.status).toBe(202);
		await executionContext.flush();
		expect(console.error).toHaveBeenCalledWith(
			"Webhook processing completed with failures",
			expect.objectContaining({
				created: 1,
				updated: 0,
				failed: 1,
				results: [
					expect.objectContaining({
						status: "failed",
						error: expect.stringContaining("Notion API request failed"),
					}),
					expect.objectContaining({
						status: "created",
					}),
				],
			}),
		);
	});

	it("builds readable notion markdown and strips duplicated title heading", () => {
		const markdown = buildNotionMarkdown(
			{
				title: "記事タイトル",
				url: "https://example.com/article",
				author: "Jane Doe",
				published: 1_711_676_800,
				feedTitle: "Example Feed",
			},
			"# 記事タイトル\n\n本文です。",
			new Date("2026-03-29T01:02:03.000Z"),
		);

		expect(markdown).toContain("- Source: [example.com](https://example.com/article)");
		expect(markdown).toContain("- Author: Jane Doe");
		expect(markdown).toContain("- Feed: Example Feed");
		expect(markdown).toContain("本文です。");
		expect(markdown).not.toContain("# 記事タイトル");
	});

	it("resolves a database parent to its first data source", async () => {
		const databaseId = "123456781234123412341234567890ab";
		const dataSourceId = "abcdefabcdefabcdefabcdefabcdefab";
		const fetchMock = createFetchMock(async (input, init) => {
			const url = getUrl(input);

			if (url === `https://api.notion.com/v1/databases/${databaseId}` && init?.method === "GET") {
				return jsonResponse({
					id: databaseId,
					data_sources: [{ id: dataSourceId }],
				});
			}

			if (url === `https://api.notion.com/v1/data_sources/${dataSourceId}/query`) {
				return jsonResponse({ results: [], has_more: false, next_cursor: null });
			}

			if (url === "https://api.notion.com/v1/pages" && init?.method === "POST") {
				const body = parseJson(init?.body);
				expect(body.parent).toEqual({ data_source_id: dataSourceId });
				return jsonResponse({ id: "created-page" });
			}

			if (url === "https://example.com/") {
				return new Response("<html><body><p>Article body</p></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			}

			throw new Error(`Unhandled fetch for ${url}`);
		});

		const ai = {
			toMarkdown: vi.fn().mockResolvedValue({
				format: "markdown",
				data: "# テストテストテスト\n\n本文A",
			}),
		};

		vi.stubGlobal("fetch", fetchMock);
		const executionContext = createExecutionContext();

		const response = await app.fetch(
			createRequest(samplePayload),
			createEnv({
				AI: ai,
				NOTION_DATA_SOURCE_ID: undefined,
				NOTION_DATABASE_ID: `https://www.notion.so/My-DB-${databaseId}?v=test`,
			}),
			executionContext,
		);

		expect(response.status).toBe(202);
		await executionContext.flush();
	});
});

function createRequest(body: unknown): Request {
	return new Request("https://example.com/", {
		method: "POST",
		body: JSON.stringify(body),
		headers: {
			"Content-Type": "application/json",
			"x-inoreader-rule-name": "MASKED",
		},
	});
}

function createEnv(overrides?: Partial<{
	AI: { toMarkdown: ReturnType<typeof vi.fn> };
	NOTION_API_KEY: string;
	NOTION_DATA_SOURCE_ID: string;
	NOTION_DATABASE_ID: string;
	INOREADER_RULE_NAME: string;
}>) {
	return {
		AI: {
			toMarkdown: vi.fn(),
		},
		NOTION_API_KEY: "notion-secret",
		NOTION_DATA_SOURCE_ID: "notion-ds",
		INOREADER_RULE_NAME: "MASKED",
		...overrides,
	};
}

function createFetchMock(
	implementation: Parameters<typeof vi.fn<typeof fetch>>[0],
): MockFetch {
	const mock = vi.fn(implementation);
	return mock as unknown as MockFetch;
}

function createExecutionContext(): MockExecutionContext {
	const promises: Promise<unknown>[] = [];

	return {
		waitUntil(promise) {
			promises.push(Promise.resolve(promise));
		},
		passThroughOnException() {},
		props: {},
		async flush() {
			await Promise.allSettled(promises);
		},
	} as MockExecutionContext;
}

function getUrl(input: Parameters<typeof fetch>[0]): string {
	return input instanceof Request ? input.url : String(input);
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function parseJson(body: BodyInit | null | undefined): any {
	if (typeof body !== "string") {
		return undefined;
	}

	return JSON.parse(body);
}
