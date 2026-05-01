# AxonHub

Adds AxonHub tracing headers to Pi provider requests and registers AxonHub models dynamically from `/v1/models`.

## Behavior

- `AH-Thread-Id` defaults to Pi's persisted session ID, so `pi --continue` and `pi --resume` keep the same thread for the same session.
- `AH-Trace-Id` uses a `pi-` prefix (e.g. `pi-turn-<uuid>`, `pi-compact-<uuid>`) and is refreshed before each user prompt starts an agent loop.
- Compaction calls get a separate `compact` trace ID.
- The extension registers headers on every provider listed in `traceProviders`.
- When `baseUrl` is configured, the extension fetches `GET /v1/models` and registers those models as a Pi provider.

## Configuration

Create `.pi/axonhub.json` in a project or `~/.pi/agent/axonhub.json` globally:

```json
{
  "baseUrl": "https://your-axonhub-instance",
  "apiKey": "AXONHUB_API_KEY",
  "provider": "axonhub",
  "api": "openai-completions",
  "modelApis": {
    "gpt-5": "openai-responses",
    "claude-3-5-sonnet": "anthropic-messages"
  },
  "traceProviders": ["axonhub", "anthropic"]
}
```

All fields are optional except `baseUrl`. `baseUrl` may include a `/v1` suffix or omit it; the extension targets `/v1/models` either way, so the same value works for both Anthropic and OpenAI runtime calls.

`traceProviders` is a list of provider names to receive tracing headers (`AH-Trace-Id`, `AH-Thread-Id`). The main `provider` is always included. Use this to trace requests across multiple backends (e.g. `["axonhub", "anthropic"]`).

Supported `api` values:

- `openai-completions`: OpenAI Chat Completions, calls `/chat/completions`.
- `openai-responses`: OpenAI Responses, calls `/responses`.
- `anthropic-messages`: Anthropic Messages, calls the Anthropic messages endpoint.

`modelApis` lets one AxonHub provider expose mixed protocol models. Entries not listed in `modelApis` use the top-level `api`.

`apiKey` can be either the literal key or an environment variable name. If unset, the extension falls back to `AXONHUB_API_KEY` and then to the matching provider entry in `~/.pi/agent/models.json`.

Optional environment overrides:

- `PI_AXONHUB_CONFIG`: explicit config file path.
- `AXONHUB_API_KEY`: API key override.

## Dynamic Models

Use AxonHub without static `models.json` model entries:

```bash
pi --model axonhub/gpt-4
```

The `/v1/models` response is mapped as follows:

- `id` -> Pi model ID.
- `name` -> Pi display name.
- `context_length` -> context window.
- `max_output_tokens` -> max output tokens.
- `capabilities.vision` -> image input support.
- `capabilities.reasoning` -> thinking support.
- `pricing.input`, `pricing.output`, `pricing.cache_read`, `pricing.cache_write` -> Pi cost metadata.

Only models with no `type` or `type: "chat"` are registered.

## Commands

- `/axonhub`: show active providers, trace ID, thread ID, and request count.

Use the native `/reload` to refetch dynamic models from AxonHub.
