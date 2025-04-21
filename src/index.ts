import { Hono } from "hono";

interface InoreaderWebhookRequestBody {
	items: {
		title: string;
		categories: string[];
		canonical: {
			href: string;
		}[];
	}[];
}

type Bindings = {
	NOTION_API_KEY: string;
	NOTION_DATABASE_ID: string;
	INOREADER_RULE_NAME: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.post("/", async (c) => {
	if (!c.req.header("x-inoreader-rule-name")?.includes(c.env.INOREADER_RULE_NAME)) {
		return new Response("Forbidden", { status: 403 });
	}

	const inoreader = await c.req.json<InoreaderWebhookRequestBody>();
	const item = inoreader.items[0];

	const { title, canonical } = item;
	const { href: url } = canonical[0];
	const body = {
		parent: { database_id: c.env.NOTION_DATABASE_ID },
		properties: {
			Title: { title: [{ type: "text", text: { content: title } }] },
			URL: { url },
			Tags: { multi_select: [{ name: "inotion", color: "blue" }] },
		},
	};

	try {
		const response = await fetch("https://api.notion.com/v1/pages", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${c.env.NOTION_API_KEY}`,
				"Content-Type": "application/json",
				"Notion-Version": "2022-06-28",
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			throw new Error(`Failed to create Notion page: ${response.status}`);
		}

		return Response.json({ success: true });
	} catch (error) {
		console.error(error);
		return Response.json({ success: false, error: "Something went wrong" }, { status: 500 });
	}
});

export default {
	fetch: app.fetch,
};
