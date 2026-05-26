import { beforeEach, describe, expect, it, vi } from "vitest";

const { launchMock } = vi.hoisted(() => ({
	launchMock: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => ({
	default: {
		launch: launchMock,
	},
}));

import {
	buildArchiveMarkdown,
	buildNotionMarkdown,
	fetchArticleHtml,
	resolveArticleMarkdown,
} from "./article";
import type { ParsedInoreaderItem } from "./inoreader";

const NOW = new Date("2026-03-29T01:02:03.000Z");
const ARTICLE = createItem();

describe("article", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("builds notion markdown body and strips a duplicate title heading", () => {
		const markdown = buildNotionMarkdown(ARTICLE, "# 記事タイトル\n\n本文です。");

		expect(markdown).toBe("本文です。");
	});

	it("merges AI frontmatter into the archive markdown frontmatter block", () => {
		const markdown = buildArchiveMarkdown(
			ARTICLE,
			`---
description: AI generated summary
title: AI title
image: https://example.com/cover.png
tags:
  - security
---

# 記事タイトル

本文です。`,
			NOW,
		);

		expect(markdown.match(/^---$/gm)).toHaveLength(2);
		expect(markdown).toContain("description: AI generated summary");
		expect(markdown).toContain("title: 記事タイトル");
		expect(markdown).toContain("cover: https://example.com/cover.png");
		expect(markdown).toContain("tags:\n  - security\n  - clippings");
		expect(markdown).toContain('categories:\n  - "[[Clippings]]"');
		expect(markdown).not.toContain("image: https://example.com/cover.png");
		expect(markdown).not.toContain("# 記事タイトル");
	});

	it("uses Browser Rendering for x.com links", async () => {
		const closeMock = vi.fn().mockResolvedValue(undefined);
		const gotoMock = vi.fn().mockResolvedValue(undefined);
		launchMock.mockResolvedValue({
			newPage: vi.fn().mockResolvedValue({
				goto: gotoMock,
				content: vi.fn().mockResolvedValue(htmlResponseBody("Rendered post")),
				title: vi.fn().mockResolvedValue("Rendered title"),
			}),
			close: closeMock,
		});

		const article = await fetchArticleHtml(
			"https://x.com/example/status/1",
			vi.fn<typeof fetch>(),
			{} as Fetcher,
		);

		expect(article.hostname).toBe("x.com");
		expect(article.html).toContain("Rendered post");
		expect(article.title).toBe("Rendered title");
		expect(gotoMock).toHaveBeenCalledWith("https://x.com/example/status/1", {
			waitUntil: "networkidle0",
			timeout: 30_000,
		});
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it("passes extracted article HTML to AI markdown conversion", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => htmlResponse("Article body"));
		const ai = {
			toMarkdown: vi.fn().mockResolvedValue({
				format: "markdown",
				data: "# 記事タイトル\n\n本文です。",
			}),
		};

		const article = await resolveArticleMarkdown(ARTICLE, ai, fetchMock);

		const firstDocument = ai.toMarkdown.mock.calls[0]?.[0];
		expect(firstDocument.name).toBe("article.html");
		expect(firstDocument.blob.type).toBe("text/html");
		expect(article.title).toBe("記事タイトル");
		expect(article.markdown).toBe("# 記事タイトル\n\n本文です。");

		const html = await firstDocument.blob.text();
		expect(html).toContain("Article body");
		expect(html).toContain("readability-page-1");
		expect(html).not.toContain("Navigation links");
		expect(html).not.toContain("Related links");
		expect(html).not.toContain("Footer links");
	});

	it("falls back to raw HTML when Readability returns empty content", async () => {
		vi.resetModules();
		vi.doMock("@cloudflare/puppeteer", () => ({
			default: {
				launch: launchMock,
			},
		}));
		vi.doMock("@mozilla/readability", () => ({
			Readability: class {
				parse() {
					return { content: "   " };
				}
			},
		}));

		const { resolveArticleMarkdown: resolveArticleMarkdownWithFallback } = await import(
			"./article"
		);
		const fetchMock = vi.fn<typeof fetch>(async () => htmlResponse("Article body"));
		const ai = {
			toMarkdown: vi.fn().mockResolvedValue({
				format: "markdown",
				data: "# 記事タイトル\n\n本文です。",
			}),
		};

		await resolveArticleMarkdownWithFallback(ARTICLE, ai, fetchMock);

		const html = await ai.toMarkdown.mock.calls[0]?.[0].blob.text();
		expect(html).toContain("Navigation links");
		expect(html).toContain("Related links");
		expect(html).toContain("Footer links");
		expect(html).toContain("Article body");

		vi.doUnmock("@mozilla/readability");
		vi.doUnmock("@cloudflare/puppeteer");
	});

	it("falls back to direct fetch when Browser Rendering fails", async () => {
		launchMock.mockRejectedValue(new Error("browser down"));
		const fetchMock = vi.fn<typeof fetch>(async () => htmlResponse("Direct article"));

		const article = await fetchArticleHtml(
			"https://x.com/example/status/1",
			fetchMock,
			{} as Fetcher,
		);

		expect(article.hostname).toBe("x.com");
		expect(article.html).toContain("Direct article");
		expect(article.title).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("uses direct fetch for non-browser hosts", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => htmlResponse("Article body"));

		const article = await fetchArticleHtml("https://example.com/article", fetchMock, {} as Fetcher);

		expect(article.hostname).toBe("example.com");
		expect(article.html).toContain("Article body");
		expect(launchMock).not.toHaveBeenCalled();
	});

	it("fails when both Browser Rendering and direct fetch fail", async () => {
		launchMock.mockRejectedValue(new Error("browser down"));
		const fetchMock = vi.fn<typeof fetch>(async () => new Response("boom", { status: 500 }));
		const ai = {
			toMarkdown: vi.fn(),
		};

		await expect(
			resolveArticleMarkdown(
				{
					title: "タイトル",
					url: "https://x.com/example/status/1",
				},
				ai,
				fetchMock,
				{} as Fetcher,
			),
		).rejects.toThrow("Failed to fetch article HTML");
		expect(ai.toMarkdown).not.toHaveBeenCalled();
	});
});

function createItem(overrides: Partial<ParsedInoreaderItem> = {}): ParsedInoreaderItem {
	return {
		title: "記事タイトル",
		url: "https://example.com/article",
		author: "Jane Doe",
		published: 1_711_676_800,
		feedTitle: "Example Feed",
		...overrides,
	};
}

function htmlResponseBody(body: string): string {
	return `<!DOCTYPE html><html><body><header><nav>Navigation links</nav></header><main><article><h1>Example title</h1><p>${body}</p><p>Second paragraph with more detail for scoring.</p></article><aside>Related links</aside></main><footer>Footer links</footer></body></html>`;
}

function htmlResponse(body: string): Response {
	return new Response(htmlResponseBody(body), {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}
