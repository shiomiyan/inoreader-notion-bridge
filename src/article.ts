import { parseDocument, stringify } from "yaml";
import type { ParsedInoreaderItem } from "./inoreader";

export type MarkdownAi = Pick<Env["AI"], "toMarkdown">;

export type ArticleHtml = {
	html: string;
	hostname: string;
};

const ARTICLE_FETCH_TIMEOUT_MS = 10_000;

export async function resolveArticleMarkdown(
	item: ParsedInoreaderItem,
	ai: MarkdownAi,
	fetchImpl: typeof fetch,
): Promise<string> {
	try {
		const articleHtml = await fetchArticleHtml(item.url, fetchImpl);
		return await convertHtmlToMarkdown(ai, articleHtml.html, articleHtml.hostname);
	} catch (error) {
		if (!item.summaryHtml) {
			throw error;
		}

		const hostname = new URL(item.url).hostname;
		return await convertHtmlToMarkdown(ai, item.summaryHtml, hostname);
	}
}

export async function fetchArticleHtml(url: string, fetchImpl: typeof fetch): Promise<ArticleHtml> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), ARTICLE_FETCH_TIMEOUT_MS);

	try {
		const response = await fetchImpl(url, {
			redirect: "follow",
			signal: controller.signal,
			headers: {
				accept: "text/html,application/xhtml+xml",
			},
		});

		if (!response.ok) {
			throw new Error(`received ${response.status}`);
		}

		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
			throw new Error(`unsupported content type: ${contentType || "unknown"}`);
		}

		const html = await response.text();
		if (!html.trim()) {
			throw new Error("empty HTML body");
		}

		return {
			html,
			hostname: new URL(response.url || url).hostname,
		};
	} catch (error) {
		throw new Error(`Failed to fetch article HTML: ${toErrorMessage(error)}`);
	} finally {
		clearTimeout(timeoutId);
	}
}

export async function convertHtmlToMarkdown(
	ai: MarkdownAi,
	html: string,
	hostname: string,
): Promise<string> {
	const result = await ai.toMarkdown(
		{
			name: "article.html",
			blob: new Blob([html], { type: "text/html" }),
		},
		{
			conversionOptions: {
				html: {
					hostname,
				},
			},
		},
	);

	if (result.format === "error") {
		throw new Error(`Markdown conversion failed: ${result.error}`);
	}

	const markdown = result.data.trim();
	if (!markdown) {
		throw new Error("Markdown conversion returned empty content");
	}

	return markdown;
}

/**
 * Formats article markdown as an Obsidian-friendly document with frontmatter
 * that can also be sent to Notion as the page body.
 */
export function buildNotionMarkdown(
	item: ParsedInoreaderItem,
	markdown: string,
	savedAt: Date = new Date(),
): string {
	const extracted = extractLeadingFrontmatter(markdown);
	const content = removeLeadingDuplicateHeading(extracted.content, item.title);
	const metadata = mergeFrontmatter(extracted.data, {
		title: item.title,
		source: item.url,
		created: savedAt.toISOString(),
		tags: ["clippings"],
		cover: "",
		categories: ["[[Clippings]]"],
	});
	const frontmatter = stringify(metadata).trimEnd();

	return `---\n${frontmatter}\n---\n\n${content}`.trim();
}

function removeLeadingDuplicateHeading(markdown: string, title: string): string {
	const trimmed = markdown.trim();
	const match = trimmed.match(/^#\s+(.+?)\s*(?:\r?\n)+/);

	if (!match) {
		return trimmed;
	}

	if (normalizeHeading(match[1]) !== normalizeHeading(title)) {
		return trimmed;
	}

	return trimmed.slice(match[0].length).trim();
}

function normalizeHeading(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[`"'“”‘’]/g, "")
		.replace(/\s+/g, " ");
}

function extractLeadingFrontmatter(markdown: string): {
	content: string;
	data: Record<string, unknown> | null;
} {
	const trimmed = markdown.trim();
	const match = trimmed.match(/^---\s*\r?\n([\s\S]*?)\r?\n(?:---|\.{3})\s*(?:\r?\n|$)/);

	if (!match) {
		return {
			content: trimmed,
			data: null,
		};
	}

	const data = parseFrontmatter(match[1]);

	return {
		content: trimmed.slice(match[0].length).trim(),
		data,
	};
}

function parseFrontmatter(source: string): Record<string, unknown> | null {
	const document = parseDocument(source);
	if (document.errors.length > 0) {
		return null;
	}

	const parsed = document.toJS();
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}

	return parsed as Record<string, unknown>;
}

function mergeFrontmatter(
	aiMetadata: Record<string, unknown> | null,
	defaults: {
		title: string;
		source: string;
		created: string;
		tags: string[];
		cover: string;
		categories: string[];
	},
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...(aiMetadata ?? {}) };
	const image = typeof merged.image === "string" ? merged.image : null;
	delete merged.image;

	for (const [key, value] of Object.entries({
		title: defaults.title,
		source: defaults.source,
		created: defaults.created,
	})) {
		if (merged[key] === undefined) {
			merged[key] = value;
		}
	}

	if (merged.cover === undefined) {
		merged.cover = image ?? defaults.cover;
	}

	merged.tags = mergeStringArray(merged.tags, defaults.tags);
	merged.categories = defaults.categories;

	return merged;
}

function mergeStringArray(value: unknown, defaults: string[]): string[] {
	const items = Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];

	for (const defaultValue of defaults) {
		if (!items.includes(defaultValue)) {
			items.push(defaultValue);
		}
	}

	return items;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
