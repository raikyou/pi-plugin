# pi-axonhub

Adds AxonHub tracing to Pi requests and registers models from `GET /v1/models?include=all`.

## Setup

Configure project `.pi/settings.json` or global `~/.pi/agent/settings.json`:

```json
{
  "axonhub": {
    "baseUrl": "https://your-axonhub-instance",
    "apiKey": "$AXONHUB_API_KEY",
    "provider": "axonhub",
    "traceProviders": ["axonhub", "anthropic"],
    "providerMap": {
      "openai": "openai-codex",
      "zai": "opencode-go",
      "nvidia": null
    },
    "modelApis": {
      "custom-model": "openai-responses"
    },
    "requestTimeoutMs": 15000
  }
}
```

`baseUrl` may include `/v1`. It is required for model discovery, but not for tracing existing providers.

| Field | Purpose | Default |
| --- | --- | --- |
| `baseUrl` | AxonHub URL | none |
| `apiKey` | AxonHub key | resolution below |
| `provider` | Name of the registered Pi provider | `axonhub` |
| `api` | Protocol for unmatched models | `openai-completions` |
| `modelApis` | Per-model protocol override | none |
| `providerMap` | Maps AxonHub `owned_by` to a Pi AI provider | defaults below |
| `traceProviders` | Extra providers that receive trace headers | none |
| `requestTimeoutMs` | Catalog timeout, 1,000–120,000 ms | `15000` |

Supported protocols are `openai-completions`, `openai-responses`, `anthropic-messages`, and `google-generative-ai`. They use AxonHub's `/v1/chat/completions`, `/v1/responses`, Anthropic Messages, and `/v1beta/models/{model}:streamGenerateContent` endpoints respectively.

## Model mapping

Each catalog model is resolved with an exact lookup:

```text
owned_by → providerMap → Pi AI provider → exact model ID
```

`providerMap` extends or overrides these defaults:

| AxonHub | Pi AI | AxonHub | Pi AI |
| --- | --- | --- | --- |
| `anthropic` | `anthropic` | `moonshot` | `moonshotai` |
| `deepseek` | `deepseek` | `nvidia` | `nvidia` |
| `google` | `google` | `openai` | `openai` |
| `minimax` | `minimax` | `xai` | `xai` |
| `mistral` | `mistral` | `xiaomi` | `xiaomi` |
|  |  | `zai` | `zai` |

Keys and values are case-insensitive. Values must be built-in Pi AI provider IDs, such as `openai-codex` or `opencode-go`. Set a value to `null` to disable its default. Unlisted developers remain unmatched; the extension never searches OpenRouter, Vercel, or another gateway automatically.

Protocol priority is:

```text
modelApis[model ID] → matched Pi AI protocol → top-level api
```

If a Pi protocol is unsupported, selection falls through. For example, a matched Mistral model cannot use `mistral-conversations` here. If `modelApis` changes the protocol, incompatible Pi AI compatibility settings are not copied.

## Metadata priority

The catalog always supplies the model ID. Its name is used when present, otherwise the Pi AI name or ID is used.

For an exact match, Pi AI wins for:

```text
protocol, pricing, context window, max tokens, reasoning,
input modalities, thinking levels, and effective compatibility
```

For an unmatched model, AxonHub supplies:

| AxonHub field | Used as |
| --- | --- |
| `context_length` | context window |
| `max_output_tokens` | max tokens |
| `modalities.input` or `capabilities.vision` | input modalities |
| `capabilities.reasoning` | reasoning support |
| `pricing.input/output/cache_read/cache_write` | pricing |

Defaults for missing unmatched metadata are 128K context, 16,384 max tokens, text-only input, no reasoning, and zero cost.

Pi AI compatibility inheritance preserves provider behavior such as reasoning levels, developer roles, adaptive thinking, token fields, caching, and deferred tool loading. Only models with no `type` or `type: "chat"` are registered.

## Codex mapping

When AxonHub routes `owned_by: "openai"` to a Codex channel, configure:

```json
{ "providerMap": { "openai": "openai-codex" } }
```

The model inherits Pi AI Codex metadata and uses AxonHub `/v1/responses`. Before sending, the extension makes the standard Responses request match the Codex body:

- moves the system prompt to `instructions`
- forces `store: false`, `stream: true`, and parallel tool calls
- adds low text verbosity, encrypted reasoning output, and automatic tool choice
- sets tool `strict` to `null`
- removes `max_output_tokens`, `prompt_cache_retention`, and the thinking-off `{ "effort": "none" }` block
- removes OpenAI SDK `x-stainless-*` headers
- sends `OpenAI-Beta`, `originator`, Pi `User-Agent`, `session-id`, and `x-client-request-id`

Enable `passThroughBody` on the AxonHub Codex channel so this body and the raw response stream pass through; AxonHub may still patch the routed model ID. Enable `passThroughUserAgent` to forward Pi's user agent. Pi authenticates to AxonHub with the AxonHub key, while AxonHub supplies the selected Codex channel's upstream OAuth credentials.

## Tracing

Traced requests receive `AH-Trace-Id` and `AH-Thread-Id`.

- The thread ID uses Pi's persisted session ID, so continue/resume keeps one thread.
- A new trace ID is created for each user turn.
- Compaction temporarily uses a `pi-compact-...` trace, then restores the turn trace.
- The main `provider` is always traced; `traceProviders` adds more providers.
- `/pi-axonhub` counts provider calls. Tool loops can create several calls; retries reuse headers and are not counted again.

## Authentication

API key resolution order:

```text
AXONHUB_API_KEY
  → axonhub.apiKey
  → matching provider in ~/.pi/agent/models.json
```

`apiKey` accepts a literal, `$ENV_VAR`, `${ENV_VAR}`, or a legacy bare environment-variable name. A bare uppercase value reads the environment when present and otherwise remains literal.

## Usage

```bash
pi --model axonhub/gpt-5.6-sol
```

Use `/reload` after configuration changes. It reloads the extension and refetches the catalog.

`/pi-axonhub` shows traced providers, trace/thread IDs, request count, selected protocol and endpoint, and dynamic-provider status.
