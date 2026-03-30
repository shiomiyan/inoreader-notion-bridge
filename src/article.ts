import type { ParsedInoreaderItem } from "./inoreader";

export type AiMarkdownResponse =
	| {
			format: "markdown";
			data: string;
	  }
	| {
			format: "error";
			error: string;
	  };

export type AiBinding = {
	toMarkdown: (
		document: {
			name: string;
			blob: Blob;
		},
		options?: {
			conversionOptions?: {
				html?: {
					hostname?: string;
					cssSelector?: string;
				};
			};
		},
	) => Promise<AiMarkdownResponse>;
};

export type ArticleHtml = {
	html: string;
	hostname: string;
};

const ARTICLE_FETCH_TIMEOUT_MS = 5_000;
const AI_MARKDOWN_TIMEOUT_MS = 7_000;

export async function resolveArticleMarkdown(
	item: ParsedInoreaderItem,
	ai: AiBinding,
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
		try {
			return await convertHtmlToMarkdown(ai, item.summaryHtml, hostname);
		} catch {
			return fallbackMarkdownFromHtml(item.summaryHtml);
		}
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
	ai: AiBinding,
	html: string,
	hostname: string,
): Promise<string> {
	const result = await withTimeout(
		ai.toMarkdown(
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
		),
		AI_MARKDOWN_TIMEOUT_MS,
		"Markdown conversion timed out",
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

function fallbackMarkdownFromHtml(html: string): string {
	const text = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|li|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/\r/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();

	if (!text) {
		throw new Error("Summary HTML fallback returned empty content");
	}

	return text;
}

export function buildNotionMarkdown(
	item: ParsedInoreaderItem,
	markdown: string,
	savedAt: Date = new Date(),
): string {
	const content = removeLeadingDuplicateHeading(markdown, item.title);
	const metadata = [
		`- Source: [${new URL(item.url).hostname}](${item.url})`,
		item.author ? `- Author: ${item.author}` : undefined,
		item.published ? `- Published: ${new Date(item.published * 1000).toISOString()}` : undefined,
		item.feedTitle ? `- Feed: ${item.feedTitle}` : undefined,
		`- Saved at: ${savedAt.toISOString()}`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");

	return [metadata, content].filter(Boolean).join("\n\n---\n\n").trim();
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

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	timeoutMessage: string,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	}
}
