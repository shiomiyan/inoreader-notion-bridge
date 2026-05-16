import type { ParsedInoreaderItem } from "./inoreader";

/**
 * Persists the rendered clipping markdown to R2 using the canonical archive key
 * for the article URL and save date.
 */
export async function saveArchiveMarkdown(
	bucket: R2Bucket,
	item: ParsedInoreaderItem,
	markdown: string,
	savedAt: Date,
): Promise<string> {
	const key = await buildArchiveObjectKey(item.url, savedAt);

	await bucket.put(key, markdown, {
		httpMetadata: {
			contentType: "text/markdown; charset=utf-8",
		},
	});

	return key;
}

/**
 * Builds the archive object key from the save date/time and a stable SHA-256
 * hash of the source URL.
 */
export async function buildArchiveObjectKey(url: string, savedAt: Date): Promise<string> {
	const timestamp = [
		savedAt.getUTCFullYear().toString().padStart(4, "0"),
		(savedAt.getUTCMonth() + 1).toString().padStart(2, "0"),
		savedAt.getUTCDate().toString().padStart(2, "0"),
		savedAt.getUTCHours().toString().padStart(2, "0") +
			savedAt.getUTCMinutes().toString().padStart(2, "0"),
	].join("-");

	const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
	const hash = Array.from(new Uint8Array(hashBuffer), (byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 7);

	return `clippings/${timestamp}-${hash}.md`;
}
