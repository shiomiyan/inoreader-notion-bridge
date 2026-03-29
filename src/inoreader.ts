export type InoreaderWebhookLink = {
	href: string;
	type?: string;
};

export type InoreaderWebhookRequestBody = {
	rule?: {
		name?: string;
	};
	items?: InoreaderWebhookItem[];
};

export type InoreaderWebhookItem = {
	title?: string;
	categories?: string[];
	canonical?: InoreaderWebhookLink[];
	alternate?: InoreaderWebhookLink[];
	summary?: {
		content?: string;
	};
	author?: string;
	published?: number;
	origin?: {
		title?: string;
	};
};

export type ParsedInoreaderItem = {
	title: string;
	url: string;
	summaryHtml?: string;
	author?: string;
	published?: number;
	feedTitle?: string;
};

export function parseWebhookPayload(body: InoreaderWebhookRequestBody): ParsedInoreaderItem[] {
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
				summaryHtml: item.summary?.content?.trim() || undefined,
				author: item.author?.trim() || undefined,
				published: item.published,
				feedTitle: item.origin?.title?.trim() || undefined,
			},
		];
	});
}

function firstValidLink(links?: InoreaderWebhookLink[]): string | undefined {
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
