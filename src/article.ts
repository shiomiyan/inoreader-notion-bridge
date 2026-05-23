import puppeteer from "@cloudflare/puppeteer";
import { Readability } from "@mozilla/readability";
import { DOMParser } from "linkedom";
import { parseDocument, stringify } from "yaml";
import type { ParsedInoreaderItem } from "./inoreader";

export type MarkdownAi = Pick<Env["AI"], "toMarkdown">;

export type ArticleHtml = {
	html: string;
	hostname: string;
};

const ARTICLE_FETCH_TIMEOUT_MS = 10_000;
const BROWSER_RENDERING_TIMEOUT_MS = 30_000;
const BROWSER_RENDERING_HOSTS = ["x.com"];

type BrowserRenderingContext = AsyncDisposable & {
	browser: Awaited<ReturnType<typeof puppeteer.launch>>;
	page: Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>;
};

export async function resolveArticleMarkdown(
	inoreader: ParsedInoreaderItem,
	ai: MarkdownAi,
	fetchImpl: typeof fetch,
	fetcher?: Fetcher,
): Promise<string> {
	const articleHtml = await fetchArticleHtml(inoreader.url, fetchImpl, fetcher);
	const markdownSourceHtml = extractArticleContentHtml(articleHtml.html) ?? articleHtml.html;
	const result = await ai.toMarkdown(
		{
			name: "article.html",
			blob: new Blob([markdownSourceHtml], { type: "text/html" }),
		},
		{
			conversionOptions: {
				html: {
					hostname: articleHtml.hostname,
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

function extractArticleContentHtml(html: string): string | null {
	const document = parseHtmlDocument(html);
	if (!document) {
		return null;
	}

	try {
		const article = new Readability(document).parse();
		const content = article?.content?.trim();

		if (!content) {
			return null;
		}

		return wrapArticleHtml(content);
	} catch {
		return null;
	}
}

function parseHtmlDocument(html: string) {
	try {
		return new DOMParser().parseFromString(html, "text/html");
	} catch {
		return null;
	}
}

function wrapArticleHtml(content: string): string {
	return `<!DOCTYPE html><html><body>${content}</body></html>`;
}

export async function fetchArticleHtml(
	url: string,
	fetchImpl: typeof fetch,
	browserBinding?: Fetcher,
): Promise<ArticleHtml> {
	if (shouldUseBrowserRendering(url) && browserBinding) {
		try {
			return await fetchArticleHtmlWithBrowserRendering(url, browserBinding);
		} catch {}
	}

	return await fetchArticleHtmlDirect(url, fetchImpl);
}

async function fetchArticleHtmlDirect(url: string, fetchImpl: typeof fetch): Promise<ArticleHtml> {
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

async function fetchArticleHtmlWithBrowserRendering(
	url: string,
	fetcher: Fetcher,
): Promise<ArticleHtml> {
	try {
		await using ctx = await useBrowserContext(fetcher);

		await ctx.page.goto(url, {
			waitUntil: "networkidle0",
			timeout: BROWSER_RENDERING_TIMEOUT_MS,
		});

		const html = await ctx.page.content();
		if (!html.trim()) {
			throw new Error("empty HTML body");
		}

		return {
			html,
			hostname: new URL(url).hostname,
		};
	} catch (error) {
		throw new Error(
			`Failed to fetch article HTML with Browser Rendering: ${toErrorMessage(error)}`,
		);
	}
}

async function useBrowserContext(browserBinding: Fetcher): Promise<BrowserRenderingContext> {
	const browser = await puppeteer.launch(browserBinding);

	try {
		const page = await browser.newPage();

		return {
			browser,
			page,
			async [Symbol.asyncDispose]() {
				await browser.close().catch(() => undefined);
			},
		};
	} catch (error) {
		await browser.close().catch(() => undefined);
		throw error;
	}
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

function shouldUseBrowserRendering(url: string): boolean {
	try {
		return BROWSER_RENDERING_HOSTS.includes(new URL(url).hostname);
	} catch {
		return false;
	}
}
