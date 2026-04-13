---
sidebar_position: 5
title: HTTP Requests
---

# HTTP Requests

Route any HTTP request through the mixnet. The destination server sees the exit node, not you.

## Basic usage

```ts
const response = await client.httpRequest(method, url, headers, body);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `method` | `string` | HTTP method (`GET`, `POST`, etc.) |
| `url` | `string` | Target URL |
| `headers` | `[string, string][]` | Request headers as key-value tuples |
| `body` | `Uint8Array` | Request body (empty `Uint8Array` for GET) |
| `opts` | `object?` | Optional timeout and response size hints |

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeoutMs` | `number?` | config default | Override the per-request timeout for this call |
| `expectedResponseBytes` | `number?` | auto | Hint for SURB allocation  - set this if you expect a large response |

**Returns:** `Uint8Array` - bincode-encoded HTTP response containing status code, headers, and body. The response body is embedded within the binary framing. For simple text/JSON responses, you can search for the body content within the decoded bytes.

## Examples

### GET request

```ts
const response = await client.httpRequest(
  "GET",
  "https://api.example.com/price/eth",
  [["Accept", "application/json"]],
  new Uint8Array(0)
);

// Response is bincode-encoded (status + headers + body).
// For text/JSON payloads, decode and extract the body content:
const text = new TextDecoder().decode(response);
```

### POST with JSON body

```ts
const body = new TextEncoder().encode(
  JSON.stringify({ symbol: "ETH", interval: "1h" })
);

const response = await client.httpRequest(
  "POST",
  "https://api.example.com/candles",
  [["Content-Type", "application/json"]],
  body
);
```

### Large response with options

When you know the response will be large, pass `expectedResponseBytes` so the SDK allocates enough SURBs:

```ts
const response = await client.httpRequest(
  "GET",
  "https://api.example.com/historical-data",
  [["Accept", "application/json"]],
  new Uint8Array(0),
  { expectedResponseBytes: 100_000, timeoutMs: 60_000 }
);
```

Each SURB carries ~30 KB of response data. If you expect a 100 KB response, the SDK needs at least 4 SURBs (plus FEC overhead). Without the hint, the SDK uses adaptive budgeting based on past responses  - but the first call to a new endpoint won't have history to draw on.

## Use cases

- **Price feeds**  - fetch token prices without revealing which assets you're tracking
- **Oracle queries**  - query off-chain data sources privately
- **API calls**  - interact with any HTTP service through the mixnet
- **Webhook triggers**  - fire webhooks without exposing your server's IP
