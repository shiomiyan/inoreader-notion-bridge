import { describe, expect, it } from "vitest";

import { buildNotionMarkdown } from "./article";

describe("article", () => {
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
		expect(markdown).toContain('title: "記事タイトル"');
		expect(markdown).toContain('source: "https://example.com/article"');
		expect(markdown).toContain("created: 2026-03-29T01:02:03.000Z");
		expect(markdown).toContain("tags:\n  - clippings");
		expect(markdown).toContain('cover: ""');
		expect(markdown).toContain("categories:\n  - '[[Clippings]]'");
		expect(markdown).toContain("本文です。");
		expect(markdown).not.toContain("# 記事タイトル");
	});
});
