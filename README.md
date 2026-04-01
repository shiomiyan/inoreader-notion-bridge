## Overview

Inoreader保存（後で読む）した記事を、Notionのデータベースに追加するためのCloudflare Workersです。

## Flow

```mermaid
sequenceDiagram
    participant Inoreader
    participant Worker as Cloudflare Workers
    participant Queue as Cloudflare Queues
    participant NotionAPI as Notion API
    participant Database as Notion Database

    Inoreader->>Worker: 記事保存時にWebhookをPOST
    Worker->>Worker: x-inoreader-rule-name を検証
    Worker->>Worker: title / canonical URL を抽出
    Worker->>Queue: itemごとにenqueue
    Worker-->>Inoreader: 202 Accepted
    Queue->>Worker: queue consumerとしてitemを配信
    Worker->>Worker: 記事URLをfetchしてHTML取得
    Worker->>Worker: Workers AI toMarkdownで本文をMarkdown化
    Worker->>NotionAPI: data source query / pages.create / pages.markdown update
    NotionAPI->>Database: Title / URL / 本文をupsert
    Database-->>Worker: 作成または更新結果を返却
```

## Tech Stack

| Layer | Details |
| --- | --- |
| Server | Hono |
| Deploy | Cloudflare Workers |
| Markdown Conversion | Workers AI `AI.toMarkdown()` |
