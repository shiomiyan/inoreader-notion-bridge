## Inoreader API

- InoreaderのAPIドキュメントは https://www.inoreader.com/developers/ を参照する
- InoreaderからフックされるWebhookリクエストフォーマットは https://www.inoreader.com/blog/2019/03/introducing-a-new-rule-action-webhooks.html を参照する

## Notion API

- NotionのAPIドキュメントは https://developers.notion.com/reference/intro を参照する

## Current Spec

- `x-inoreader-rule-name` ヘッダーに `INOREADER_RULE_NAME` が含まれないリクエストは `403 Forbidden` を返す。
- リクエストボディが JSON として不正な場合は `400 Bad Request` を返す。
- `title` と有効な記事 URL を持つ item が 1 件もない場合は `400 Bad Request` を返す。
- 有効な webhook は詳細な結果を返さず常に `202 Accepted` を返す。
- `ExecutionContext` が使える場合の保存処理は `waitUntil` で非同期実行する。
- 記事本文の取得では元 URL に対してリダイレクト追従付きで HTML を取得する。
- 記事 HTML の取得に失敗しても `summary.content` があればその HTML を代替入力に使う。
- 記事 HTML または summary HTML は Workers AI の `AI.toMarkdown()` で Markdown に変換する。
- Notion の保存先は `NOTION_DATABASE_ID` から解決し、database ID が指定された場合は先頭の data source を使う。
- Notion に同じ `URL` プロパティを持つページがあれば更新し、なければ新規作成する。
- Notion に保存する本文はソース URL、著者、公開日時、Feed 名、保存日時のメタデータと記事 Markdown で構成する。
- 記事タイトルと同じ先頭見出しが Markdown に含まれる場合はその重複見出しを除去する。
- 個別 item の保存失敗や webhook 全体の処理失敗はレスポンスではなくログに記録する。
