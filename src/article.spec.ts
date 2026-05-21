import { beforeEach, describe, expect, it, vi } from "vitest";

const { launchMock } = vi.hoisted(() => ({
	launchMock: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => ({
	default: {
		launch: launchMock,
	},
}));

import { buildNotionMarkdown, fetchArticleHtml, resolveArticleMarkdown } from "./article";

describe("article", () => {
	beforeEach(() => {
		vi.clearAllMocks();
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

		expect(markdown).toContain("---\n");
		expect(markdown).toContain("title: 記事タイトル");
		expect(markdown).toContain("source: https://example.com/article");
		expect(markdown).toContain("created: 2026-03-29T01:02:03.000Z");
		expect(markdown).toContain("tags:\n  - clippings");
		expect(markdown).toContain('cover: ""');
		expect(markdown).toContain('categories:\n  - "[[Clippings]]"');
		expect(markdown).toContain("本文です。");
		expect(markdown).not.toContain("# 記事タイトル");
	});

	it("merges AI frontmatter into a single frontmatter block", () => {
		const markdown = buildNotionMarkdown(
			{
				title: "記事タイトル",
				url: "https://example.com/article",
				author: "Jane Doe",
				published: 1_711_676_800,
				feedTitle: "Example Feed",
			},
			`---
description: AI generated summary
title: AI title
image: https://example.com/cover.png
tags:
  - security
  - clippings
categories:
  - "[[AI]]"
---

# 記事タイトル

本文です。`,
			new Date("2026-03-29T01:02:03.000Z"),
		);

		expect(markdown.match(/^---$/gm)).toHaveLength(2);
		expect(markdown).toContain("description: AI generated summary");
		expect(markdown).toContain("title: AI title");
		expect(markdown).toContain("cover: https://example.com/cover.png");
		expect(markdown).toContain("source: https://example.com/article");
		expect(markdown).toContain("created: 2026-03-29T01:02:03.000Z");
		expect(markdown).toContain("tags:\n  - security\n  - clippings");
		expect(markdown).toContain('categories:\n  - "[[Clippings]]"');
		expect(markdown).not.toContain("image: https://example.com/cover.png");
		expect(markdown).not.toContain('  - "[[AI]]"');
		expect(markdown).toContain("本文です。");
		expect(markdown).not.toContain("# 記事タイトル");
	});

	it("falls back to self frontmatter when AI frontmatter is invalid", () => {
		const markdown = buildNotionMarkdown(
			{
				title: "記事タイトル",
				url: "https://example.com/article",
				author: "Jane Doe",
				published: 1_711_676_800,
				feedTitle: "Example Feed",
			},
			`---
title: [unterminated
---

本文です。`,
			new Date("2026-03-29T01:02:03.000Z"),
		);

		expect(markdown.match(/^---$/gm)).toHaveLength(2);
		expect(markdown).toContain("title: 記事タイトル");
		expect(markdown).toContain("source: https://example.com/article");
		expect(markdown).toContain("created: 2026-03-29T01:02:03.000Z");
		expect(markdown).toContain("tags:\n  - clippings");
		expect(markdown).toContain('categories:\n  - "[[Clippings]]"');
		expect(markdown).not.toContain("unterminated");
		expect(markdown).toContain("本文です。");
	});

	it("uses Browser Rendering for x.com links", async () => {
		const closeMock = vi.fn().mockResolvedValue(undefined);
		const gotoMock = vi.fn().mockResolvedValue(undefined);
		const contentMock = vi
			.fn()
			.mockResolvedValue("<html><body><article>Rendered post</article></body></html>");
		launchMock.mockResolvedValue({
			newPage: vi.fn().mockResolvedValue({
				goto: gotoMock,
				content: contentMock,
			}),
			close: closeMock,
		});
		const fetchMock = vi.fn<typeof fetch>();
		const browserBinding = {} as Fetcher;

		const article = await fetchArticleHtml(
			"https://x.com/example/status/1",
			fetchMock,
			browserBinding,
		);

		expect(article.hostname).toBe("x.com");
		expect(article.html).toContain("Rendered post");
		expect(launchMock).toHaveBeenCalledWith(browserBinding);
		expect(gotoMock).toHaveBeenCalledWith("https://x.com/example/status/1", {
			waitUntil: "networkidle0",
			timeout: 30_000,
		});
		expect(closeMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("falls back to direct fetch when Browser Rendering fails for x.com", async () => {
		launchMock.mockRejectedValue(new Error("browser down"));
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			const url = getUrl(input);

			if (url === "https://x.com/example/status/1") {
				return new Response("<html><body><p>Direct article</p></body></html>", {
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}

			throw new Error(`Unhandled fetch for ${url}`);
		});

		const article = await fetchArticleHtml(
			"https://x.com/example/status/1",
			fetchMock,
			{} as Fetcher,
		);

		expect(article.hostname).toBe("x.com");
		expect(article.html).toContain("Direct article");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("falls back to summary HTML when Browser Rendering and direct fetch both fail for x.com", async () => {
		launchMock.mockRejectedValue(new Error("browser down"));
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			const url = getUrl(input);

			if (url === "https://x.com/example/status/1") {
				return new Response("boom", { status: 500 });
			}

			throw new Error(`Unhandled fetch for ${url}`);
		});
		const ai = {
			toMarkdown: vi.fn().mockResolvedValue({
				format: "markdown",
				data: "# タイトル\n\nsummary body",
			}),
		};

		const markdown = await resolveArticleMarkdown(
			{
				title: "タイトル",
				url: "https://x.com/example/status/1",
				summaryHtml: "<p>Summary fallback</p>",
			},
			ai,
			fetchMock,
			{} as Fetcher,
		);

		expect(markdown).toContain("summary body");
		expect(await ai.toMarkdown.mock.calls[0]?.[0].blob.text()).toContain("Summary fallback");
	});

	it("falls back to direct fetch when Browser Rendering binding is missing", async () => {
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			const url = getUrl(input);

			if (url === "https://x.com/example/status/1") {
				return new Response("<html><body><p>Direct article</p></body></html>", {
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}

			throw new Error(`Unhandled fetch for ${url}`);
		});

		const article = await fetchArticleHtml("https://x.com/example/status/1", fetchMock);

		expect(article.html).toContain("Direct article");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://x.com/example/status/1",
			expect.objectContaining({
				redirect: "follow",
			}),
		);
	});

	it("does not use Browser Rendering for non-x.com links", async () => {
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			const url = getUrl(input);

			if (url === "https://example.com/article") {
				return new Response("<html><body><p>Article body</p></body></html>", {
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}

			throw new Error(`Unhandled fetch for ${url}`);
		});

		const article = await fetchArticleHtml("https://example.com/article", fetchMock, {} as Fetcher);

		expect(article.hostname).toBe("example.com");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(launchMock).not.toHaveBeenCalled();
	});
});

function getUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") {
		return input;
	}

	if (input instanceof URL) {
		return input.toString();
	}

	return input.url;
}
