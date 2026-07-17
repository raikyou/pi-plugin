# pi-axonhub

Adds AxonHub tracing headers to Pi provider requests and registers AxonHub models dynamically from `/v1/models?include=all`.

## Behavior

- `AH-Thread-Id` defaults to Pi's persisted session ID, so `pi --continue` and `pi --resume` keep the same thread for the same session.
- `AH-Trace-Id` uses a `pi-` prefix (e.g. `pi-turn-<uuid>`, `pi-compact-<uuid>`) and is refreshed before each user prompt starts an agent loop.
- Compaction calls get a separate `compact` trace ID.
- The extension registers headers on every provider listed in `traceProviders`.
- When `baseUrl` is configured, the extension fetches `GET /v1/models?include=all` and registers those models as a Pi provider.
- Models whose `id` and `owned_by` developer match a first-party model in Pi AI inherit that model's protocol, thinking-level map, and effective API compatibility settings, including settings Pi AI normally infers from the original provider or base URL.

## Configuration

Configure AxonHub in the `"axonhub"` object of project `.pi/settings.json` or global `~/.pi/agent/settings.json`:

```json
{
  "axonhub": {
    "baseUrl": "https://your-axonhub-instance",
    "apiKey": "$AXONHUB_API_KEY",
    "provider": "axonhub",
    "traceProviders": ["axonhub", "anthropic"],
    "requestTimeoutMs": 15000
  }
}
```

All fields are optional except `baseUrl`. `baseUrl` may include a `/v1` suffix or omit it; the extension targets `/v1/models` either way, so the same value works for both Anthropic and OpenAI runtime calls.

`traceProviders` is a list of provider names to receive tracing headers (`AH-Trace-Id`, `AH-Thread-Id`). The main `provider` is always included. Use this to trace requests across multiple backends (e.g. `["axonhub", "anthropic"]`).

Supported `api` values:

- `openai-completions`: OpenAI Chat Completions, calls `/chat/completions`.
- `openai-responses`: OpenAI Responses, calls `/responses`.
- `anthropic-messages`: Anthropic Messages, calls the Anthropic messages endpoint.
- `google-generative-ai`: Google Generative AI, calls `/v1beta/models/{model}:streamGenerateContent`.

The extension treats AxonHub's `owned_by` field as the model developer and uses it with the model ID to find the corresponding first-party Pi AI model. For example, `deepseek/deepseek-v4-pro`, `zai/glm-5.2`, and `openai/gpt-5.6-sol` inherit their respective Pi AI model settings. Developer values are matched against AxonHub's fixed Web UI options; no free-form developer aliases are applied.

AxonHub's curated developer list currently maps to Pi AI as follows:

| AxonHub developer | Pi AI provider | Conversion |
| --- | --- | --- |
| `anthropic` | `anthropic` | first-party exact-ID match |
| `deepseek` | `deepseek` | first-party exact-ID match |
| `google` | `google` | first-party exact-ID match |
| `minimax` | `minimax` | first-party exact-ID match |
| `mistral` | `mistral` | metadata match; `mistral-conversations` is not an AxonHub extension protocol, so API falls back |
| `moonshot` | `moonshotai` | renamed provider, exact-ID match |
| `nvidia` | `nvidia` | first-party exact-ID match |
| `openai` | `openai` | first-party exact-ID match |
| `xai` | `xai` | first-party exact-ID match |
| `xiaomi` | `xiaomi` | first-party exact-ID match |
| `zai` | `zai` | first-party exact-ID match |
| `alibaba`, `bytedance`, `ibm`, `kwaipilot`, `longcat`, `meta`, `stepfun` | none | AxonHub metadata plus configured API fallback |

The lookup is deliberately restricted to the mapped first-party provider and an exact model ID. It does not borrow OpenRouter, Vercel, or another gateway's compatibility settings, because those settings describe that gateway rather than the underlying model developer.

For a matched model, the extension uses Pi AI's protocol when AxonHub supports it and copies Pi AI's model-specific `thinkingLevelMap`. It also materializes Pi AI's effective `compat` settings before replacing the original provider and base URL with AxonHub. This includes explicit model metadata and implicit provider/URL defaults, preserving differences such as fixed/high-only reasoning, extended `xhigh`/`max` levels, adaptive thinking, developer-role support, token-field selection, and native deferred-tool support.

Native dynamic tool loading is therefore inherited when the matched Pi AI model and selected protocol support it. For example, OpenAI Responses models retain `supportsToolSearch`, Anthropic Claude 4.5+ Sonnet/Opus/Fable models retain the inferred `supportsToolReferences` behavior, and Kimi models retain `deferredToolsMode`. If `modelApis` changes a model to a different protocol, protocol-specific compatibility is not copied.

If no Pi AI model matches, the model uses the top-level `api` (defaults to `openai-completions`). There is no separate developer-based API fallback.

`modelApis` provides the highest-priority per-model override, so it can correct custom model aliases or force a different protocol. The selection order is `modelApis` -> matched Pi AI model -> top-level `api` fallback.

`apiKey` can be a literal key, `$ENV_VAR`, `${ENV_VAR}`, or a legacy bare environment-variable name. A bare uppercase value resolves from the environment when that variable exists and otherwise remains a literal key for backward compatibility. If unset, the extension falls back to `AXONHUB_API_KEY` and then to the matching provider entry in `~/.pi/agent/models.json`.

`requestTimeoutMs` controls the model-catalog request timeout and must be between 1,000 and 120,000 milliseconds. It defaults to 15,000.

Optional environment override:

- `AXONHUB_API_KEY`: API key override.

## Dynamic Models

Use AxonHub without static `models.json` model entries:

```bash
pi --model axonhub/gpt-4
```

The `/v1/models` response is mapped as follows:

- `id` -> Pi model ID.
- `name` -> Pi display name.
- `owned_by` + `id` -> Pi AI model lookup for protocol, thinking levels, compatibility, and missing metadata.
- `context_length` -> context window (Pi AI value is the fallback).
- `max_output_tokens` -> max output tokens (Pi AI value is the fallback).
- `modalities.input` or `capabilities.vision` -> image input support (Pi AI value is the fallback).
- `capabilities.reasoning` -> thinking support. Supported effort levels come from the matched Pi AI model; unmatched models use Pi's standard reasoning-level behavior.
- `pricing.input`, `pricing.output`, `pricing.cache_read`, `pricing.cache_write` -> Pi cost metadata (Pi AI values fill missing fields).

Only models with no `type` or `type: "chat"` are registered.

## Commands

- `/pi-axonhub`: show active providers, trace ID, thread ID, provider-request count, and the selected model's protocol and endpoint base URL.

The provider-request count is diagnostic information: it is the number of traced LLM API requests made in the current trace. A turn with tool calls usually has more than one provider request. Use the native `/reload` to reload configuration and refetch models from AxonHub.
