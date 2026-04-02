import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildNotionMarkdown } from "../src/article";
import { app, processWebhookBatch } from "../src/index";
import type { Bindings } from "../src/index";
import type { ParsedInoreaderItem, StreamContents } from "../src/inoreader";
import samplePayload from "./inoreader.req.json";

type MockFetch = typeof fetch & {
	mock: ReturnType<typeof vi.fn>;
};

type QueueMessageStub = Message<ParsedInoreaderItem> & {
	ack: ReturnType<typeof vi.fn<() => void>>;
	retry: ReturnType<typeof vi.fn<(options?: QueueRetryOptions) => void>>;
};

type QueueBatchStub = MessageBatch<ParsedInoreaderItem> & {
	messages: QueueMessageStub[];
	retryAll: ReturnType<typeof vi.fn<(options?: QueueRetryOptions) => void>>;
	ackAll: ReturnType<typeof vi.fn<() => void>>;
};

describe("inoreader notion bridge", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-29T01:02:03.000Z"));
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns 403 when rule header does not match", async () => {
		const response = await app.fetch(
			new Request("https://example.com/", {
				method: "POST",
				body: JSON.stringify(samplePayload),
				headers: { "Content-Type": "application/json" },
			}),
			createEnv(),
		);

		expect(response.status).toBe(403);
	});

	it("returns 202 and enqueues valid items", async () => {
		const payload: StreamContents = {
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

		const queue = createQueueBinding();
		const response = await app.fetch(
			createRequest(payload),
			createEnv({ inoreader_notion_bridge_queue: queue }),
		);

		expect(response.status).toBe(202);
		expect(queue.sendBatch).toHaveBeenCalledWith([
			{
				body: {
					title: "テストテストテスト",
					url: "https://example.com/",
					summaryHtml: "<div><p>Webhook summary body</p></div>",
					author: "Example Author",
					published: 1_711_676_800,
					feedTitle: "Example Feed",
				},
			},
			{
				body: {
					title: "2本目の記事",
					url: "https://example.com/second",
					summaryHtml: "<div><p>Webhook summary body</p></div>",
					author: "Example Author",
					published: 1_711_676_800,
					feedTitle: "Example Feed",
				},
			},
		]);
	});

	it("returns 500 when queue enqueue fails", async () => {
		const queue = createQueueBinding({
			sendBatch: vi.fn().mockRejectedValue(new Error("queue down")),
		});

		const response = await app.fetch(
			createRequest(samplePayload),
			createEnv({ inoreader_notion_bridge_queue: queue }),
		);

		expect(response.status).toBe(500);
		expect(console.error).toHaveBeenCalledWith(
			"Failed to enqueue webhook items",
			expect.objectContaining({
				error: expect.objectContaining({
					message: "queue down",
				}),
			}),
		);
	});

	it("creates pages for multiple queued items and converts fetched HTML with AI", async () => {
		const items: ParsedInoreaderItem[] = [
			{
				title: "テストテストテスト",
				url: "https://example.com/",
				summaryHtml: "<p>Webhook summary body</p>",
			},
			{
				title: "2本目の記事",
				url: "https://example.com/second",
				summaryHtml: "<p>Webhook summary body</p>",
			},
		];

		const fetchMock = createFetchMock(async (input, init) => {
			const url = getUrl(input);

			if (url.startsWith("https://api.notion.com/")) {
				expectNotionVersion(init);
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
		const batch = createMessageBatch(items);

		await processWebhookBatch(batch, createEnv({ AI: ai }));

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
		expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
		expect(batch.messages[1].ack).toHaveBeenCalledTimes(1);
		expect(batch.messages[0].retry).not.toHaveBeenCalled();
	});

	it("falls back to summary HTML when fetching article HTML fails", async () => {
		const fetchMock = createFetchMock(async (input, init) => {
			const url = getUrl(input);

			if (url.startsWith("https://api.notion.com/")) {
				expectNotionVersion(init);
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
		const batch = createMessageBatch([
			{
				title: "テストテストテスト",
				url: "https://example.com/",
				summaryHtml: "<p>Webhook summary body</p>",
			},
		]);

		await processWebhookBatch(batch, createEnv({ AI: ai }));

		const firstDocument = ai.toMarkdown.mock.calls[0][0];
		expect(await firstDocument.blob.text()).toContain("Webhook summary body");
		expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
	});

	it("updates existing page instead of creating a new one", async () => {
		const fetchMock = createFetchMock(async (input, init) => {
			const url = getUrl(input);

			if (url.startsWith("https://api.notion.com/")) {
				expectNotionVersion(init);
			}

			if (url.startsWith("https://api.notion.com/v1/data_sources/notion-ds/query")) {
				return jsonResponse({
					results: [
						{
							id: "page-123",
							properties: {
								url: { url: "https://example.com/" },
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
		const batch = createMessageBatch([
			{
				title: "テストテストテスト",
				url: "https://example.com/",
				summaryHtml: "<p>Webhook summary body</p>",
			},
		]);

		await processWebhookBatch(batch, createEnv({ AI: ai }));

		expect(fetchMock).not.toHaveBeenCalledWith(
			"https://api.notion.com/v1/pages",
			expect.anything(),
		);
		expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
	});

	it("retries only the failed queued item", async () => {
		const items: ParsedInoreaderItem[] = [
			{
				title: "テストテストテスト",
				url: "https://example.com/",
				summaryHtml: "<p>Webhook summary body</p>",
			},
			{
				title: "成功する記事",
				url: "https://example.com/success",
				summaryHtml: "<p>Webhook summary body</p>",
			},
		];

		const fetchMock = createFetchMock(async (input, init) => {
			const url = getUrl(input);

			if (url.startsWith("https://api.notion.com/")) {
				expectNotionVersion(init);
			}

			if (url.startsWith("https://api.notion.com/v1/data_sources/notion-ds/query")) {
				return jsonResponse({ results: [], has_more: false, next_cursor: null });
			}

			if (url === "https://api.notion.com/v1/pages" && init?.method === "POST") {
				const body = parseJson(init?.body);
				if (body?.properties?.title?.title?.[0]?.text?.content === "テストテストテスト") {
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
		const batch = createMessageBatch(items);

		await processWebhookBatch(batch, createEnv({ AI: ai }));

		expect(batch.messages[0].retry).toHaveBeenCalledTimes(1);
		expect(batch.messages[0].ack).not.toHaveBeenCalled();
		expect(batch.messages[1].ack).toHaveBeenCalledTimes(1);
		expect(console.error).toHaveBeenCalledWith(
			"Failed to process queued item",
			expect.objectContaining({
				messageId: batch.messages[0].id,
				attempts: batch.messages[0].attempts,
				error: expect.objectContaining({
					message: "Request failed: 500",
				}),
			}),
		);
	});

	it("logs and retries when Notion returns a non-JSON response", async () => {
		const fetchMock = createFetchMock(async (input, init) => {
			const url = getUrl(input);

			if (url.startsWith("https://api.notion.com/")) {
				expectNotionVersion(init);
			}

			if (url.startsWith("https://api.notion.com/v1/data_sources/notion-ds/query")) {
				return new Response("<html><body>upstream error</body></html>", {
					status: 502,
					headers: { "content-type": "text/html" },
				});
			}

			throw new Error(`Unhandled fetch for ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);
		const batch = createMessageBatch([
			{
				title: "テストテストテスト",
				url: "https://example.com/",
			},
		]);

		await processWebhookBatch(batch, createEnv());

		expect(batch.messages[0].retry).toHaveBeenCalledTimes(1);
		expect(batch.messages[0].ack).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(
			"Invalid Notion response",
			expect.objectContaining({
				status: 502,
				path: "/v1/data_sources/notion-ds/query",
			}),
		);
		expect(console.error).toHaveBeenCalledWith(
			"Failed to process queued item",
			expect.objectContaining({
				messageId: batch.messages[0].id,
				attempts: batch.messages[0].attempts,
				error: expect.objectContaining({
					message: "Invalid response",
				}),
			}),
		);
	});

	it("falls back to a title-only page when page creation is blocked by Cloudflare WAF", async () => {
		const fetchMock = createFetchMock(async (input, init) => {
			const url = getUrl(input);

			if (url.startsWith("https://api.notion.com/")) {
				expectNotionVersion(init);
			}

			if (url.startsWith("https://api.notion.com/v1/data_sources/notion-ds/query")) {
				return jsonResponse({ results: [], has_more: false, next_cursor: null });
			}

			if (url === "https://api.notion.com/v1/pages" && init?.method === "POST") {
				const body = parseJson(init?.body);
				if (body?.markdown?.includes("本文A")) {
					return new Response(
						'<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body><h1>Sorry, you have been blocked</h1><p>Cloudflare Ray ID: <strong>ray-create-123</strong></p></body></html>',
						{
							status: 403,
							headers: {
								"content-type": "text/html",
								"cf-ray": "ray-create-123",
							},
						},
					);
				}

				expect(body.properties).toEqual({
					title: {
						title: [
							{
								type: "text",
								text: {
									content: "テストテストテスト",
									link: { url: "https://example.com/" },
								},
							},
						],
					},
					url: {
						url: "https://example.com/",
					},
					updated: {
						date: {
							start: "2026-03-29T01:02:03.000Z",
						},
					},
				});
				expect(body.markdown).toBe("本文保存が Cloudflare WAF によりブロックされました。");
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
		const batch = createMessageBatch([
			{
				title: "テストテストテスト",
				url: "https://example.com/",
			},
		]);

		await processWebhookBatch(batch, createEnv({ AI: ai }));

		expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
		expect(batch.messages[0].retry).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(
			"Notion request blocked by Cloudflare WAF; saved fallback page",
			expect.objectContaining({
				messageId: batch.messages[0].id,
				attempts: batch.messages[0].attempts,
				wafBlock: expect.objectContaining({
					status: 403,
					path: "/v1/pages",
					notionVersion: "2026-03-11",
					cloudflareRayId: "ray-create-123",
				}),
			}),
		);
	});

	it("keeps existing markdown and only updates lowercase properties when markdown update is blocked by Cloudflare WAF", async () => {
		const fetchMock = createFetchMock(async (input, init) => {
			const url = getUrl(input);

			if (url.startsWith("https://api.notion.com/")) {
				expectNotionVersion(init);
			}

			if (url.startsWith("https://api.notion.com/v1/data_sources/notion-ds/query")) {
				return jsonResponse({
					results: [
						{
							id: "page-123",
							properties: {
								url: { url: "https://example.com/" },
							},
						},
					],
					has_more: false,
					next_cursor: null,
				});
			}

			if (url === "https://api.notion.com/v1/pages/page-123" && init?.method === "PATCH") {
				const body = parseJson(init?.body);
				expect(body.properties).toEqual({
					title: {
						title: [
							{
								type: "text",
								text: {
									content: "テストテストテスト",
									link: { url: "https://example.com/" },
								},
							},
						],
					},
					url: {
						url: "https://example.com/",
					},
					updated: {
						date: {
							start: "2026-03-29T01:02:03.000Z",
						},
					},
				});
				return jsonResponse({ id: "page-123" });
			}

			if (url === "https://api.notion.com/v1/pages/page-123/markdown" && init?.method === "PATCH") {
				return new Response(
					'<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body><h1>Sorry, you have been blocked</h1><p>Cloudflare Ray ID: <strong>ray-update-456</strong></p></body></html>',
					{
						status: 403,
						headers: {
							"content-type": "text/html",
							"cf-ray": "ray-update-456",
						},
					},
				);
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
		const batch = createMessageBatch([
			{
				title: "テストテストテスト",
				url: "https://example.com/",
			},
		]);

		await processWebhookBatch(batch, createEnv({ AI: ai }));

		expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
		expect(batch.messages[0].retry).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(
			"Notion request blocked by Cloudflare WAF; saved fallback page",
			expect.objectContaining({
				wafBlock: expect.objectContaining({
					status: 403,
					path: "/v1/pages/page-123/markdown",
					notionVersion: "2026-03-11",
					cloudflareRayId: "ray-update-456",
				}),
			}),
		);
	});

	it("retries the whole batch when notion data source id is missing", async () => {
		const fetchMock = createFetchMock(async (input) => {
			throw new Error(`Unhandled fetch for ${getUrl(input)}`);
		});

		vi.stubGlobal("fetch", fetchMock);
		const batch = createMessageBatch([
			{
				title: "テストテストテスト",
				url: "https://example.com/",
			},
		]);

		await processWebhookBatch(
			batch,
			createEnv({
				NOTION_DATA_SOURCE_ID: "",
			}),
		);

		expect(batch.retryAll).toHaveBeenCalledTimes(1);
		expect(batch.messages[0].ack).not.toHaveBeenCalled();
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

	it("uses the configured data source id directly for page creation", async () => {
		const dataSourceId = "abcdefabcdefabcdefabcdefabcdefab";
		const fetchMock = createFetchMock(async (input, init) => {
			const url = getUrl(input);

			if (url.startsWith("https://api.notion.com/")) {
				expectNotionVersion(init);
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
		const batch = createMessageBatch([
			{
				title: "テストテストテスト",
				url: "https://example.com/",
			},
		]);

		await processWebhookBatch(
			batch,
			createEnv({
				AI: ai,
				NOTION_DATA_SOURCE_ID: dataSourceId,
			}),
		);

		expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
	});

	it("returns 400 when payload JSON is invalid", async () => {
		const response = await app.fetch(
			new Request("https://example.com/", {
				method: "POST",
				body: "{invalid json",
				headers: {
					"Content-Type": "application/json",
					"x-inoreader-rule-name": "MASKED",
				},
			}),
			createEnv(),
		);

		expect(response.status).toBe(400);
	});

	it("returns 400 when payload has no valid items", async () => {
		const response = await app.fetch(
			createRequest({ items: [{ title: "missing url" }] }),
			createEnv(),
		);

		expect(response.status).toBe(400);
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

function createEnv(
	overrides?: Partial<{
		AI: { toMarkdown: ReturnType<typeof vi.fn> };
		inoreader_notion_bridge_queue: Bindings["inoreader_notion_bridge_queue"];
		NOTION_API_KEY: string;
		NOTION_DATA_SOURCE_ID: string;
		INOREADER_RULE_NAME: string;
	}>,
): Bindings {
	return {
		AI: {
			toMarkdown: vi.fn(),
		},
		inoreader_notion_bridge_queue: createQueueBinding(),
		NOTION_API_KEY: "notion-secret",
		NOTION_DATA_SOURCE_ID: "notion-ds",
		INOREADER_RULE_NAME: "MASKED",
		...overrides,
	} as unknown as Bindings;
}

function createQueueBinding(
	overrides?: Partial<Bindings["inoreader_notion_bridge_queue"]>,
): Bindings["inoreader_notion_bridge_queue"] {
	const send = vi
		.fn<(message: ParsedInoreaderItem, options?: QueueSendOptions) => Promise<void>>()
		.mockResolvedValue(undefined);
	const sendBatch = vi
		.fn<
			(
				messages: Iterable<MessageSendRequest<ParsedInoreaderItem>>,
				options?: QueueSendBatchOptions,
			) => Promise<void>
		>()
		.mockResolvedValue(undefined);

	return {
		send,
		sendBatch,
		...overrides,
	};
}

function createFetchMock(
	implementation: Parameters<typeof vi.fn<typeof fetch>>[0],
): MockFetch {
	const mock = vi.fn(implementation);
	return mock as unknown as MockFetch;
}

function createMessageBatch(items: ParsedInoreaderItem[]): QueueBatchStub {
	const messages = items.map(
		(item, index) =>
			({
				id: `message-${index + 1}`,
				timestamp: new Date("2026-03-29T01:02:03.000Z"),
				body: item,
				attempts: 1,
				ack: vi.fn<() => void>(),
				retry: vi.fn<(options?: QueueRetryOptions) => void>(),
			}) as QueueMessageStub,
	);

	return {
		queue: "inoreader-notion-bridge-queue",
		messages,
		retryAll: vi.fn<(options?: QueueRetryOptions) => void>(),
		ackAll: vi.fn<() => void>(),
	};
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

function expectNotionVersion(init: RequestInit | undefined) {
	expect(init?.headers).toEqual(
		expect.objectContaining({
			"Notion-Version": "2026-03-11",
		}),
	);
}
