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
