export type StreamContentsLink = {
	href: string;
};

export type StreamContentsItem = {
	categories?: string[];
	title?: string;
	published?: number;
	canonical?: StreamContentsLink[];
	alternate?: StreamContentsLink[];
	summary?: {
		content?: string;
	};
	author?: string;
	origin?: {
		title?: string;
	};
};

export type StreamContents = {
	items?: StreamContentsItem[];
};

export type ParsedInoreaderItem = {
	title: string;
	url: string;
	author?: string;
	published?: number;
	feedTitle?: string;
};

export function parseWebhookPayload(body: StreamContents): ParsedInoreaderItem[] {
	// Logging for traceability in Cloudflare logs
	console.log(body);

	const items = body.items ?? [];

	return items.flatMap((item) => {
		const title = item.title?.trim();
		const url = firstValidLink(item.canonical) ?? firstValidLink(item.alternate);

		if (!title || !url) {
			return [];
		}

		return [
			{
				title,
				url,
				author: item.author?.trim() || undefined,
				published: item.published,
				feedTitle: item.origin?.title?.trim() || undefined,
			},
		];
	});
}

function firstValidLink(links?: StreamContentsLink[]): string | undefined {
	for (const link of links ?? []) {
		const href = link.href?.trim();
		if (!href) {
			continue;
		}

		try {
			return new URL(href).toString();
		} catch {}
	}

	return undefined;
}
