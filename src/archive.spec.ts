import { describe, expect, it, vi } from "vitest";

import { buildArchiveObjectKey, saveArchiveMarkdown } from "./archive";

describe("archive", () => {
	it("builds a clipping key from the save timestamp and URL hash", async () => {
		const key = await buildArchiveObjectKey(
			"https://example.com/articles/123",
			new Date("2026-03-29T01:02:03.000Z"),
		);

		expect(key).toMatch(/^clippings\/2026-03-29-0102-[a-f0-9]{7}\.md$/);
	});

	it("writes markdown to R2 with text/markdown metadata", async () => {
		const bucket = {
			put: vi.fn().mockResolvedValue(null),
		} as unknown as R2Bucket;

		const key = await saveArchiveMarkdown(
			bucket,
			{
				title: "記事タイトル",
				url: "https://example.com/articles/123",
			},
			"# markdown",
			new Date("2026-03-29T01:02:03.000Z"),
		);

		expect(bucket.put).toHaveBeenCalledWith(
			key,
			"# markdown",
			expect.objectContaining({
				httpMetadata: {
					contentType: "text/markdown; charset=utf-8",
				},
			}),
		);
	});
});
