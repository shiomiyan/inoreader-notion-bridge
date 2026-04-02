## Overview

Inoreader保存（後で読む）した記事を、Notionの data source に追加するためのCloudflare Workersです。

## Flow

```mermaid
sequenceDiagram
    participant Inoreader
    participant Workers
    participant Queues
    participant NotionDatabase as Notion Database

    Inoreader->>Workers: 記事保存時にWebhookをPOST
    Workers->>Queues: itemごとにenqueue
    Workers-->>Inoreader: 202 Accepted
    Queues->>Workers: queue consumerとしてitemを配信
    Workers->>NotionDatabase: 記事をupsert
    NotionDatabase-->>Workers: 保存完了
```

## Tech Stack

| Layer | Details |
| --- | --- |
| Platform, Framework | Cloudflare Workers (using Hono) and various Cloudflare services |
| Language | TypeScript 6 |
| Linting, Formatting | Biome |
