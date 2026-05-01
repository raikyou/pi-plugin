# Personal Pi Plugin

Personal Pi package for extensions, skills, prompts, and themes.

## Layout

- `extensions/`: TypeScript Pi extensions.
- `skills/`: reusable skills.
- `prompts/`: prompt templates.
- `themes/`: Pi themes.

## Install

From another checkout, install this package with Pi:

```bash
pi install git:github.com/raikyou/pi-plugin
```

For local development, run Pi with the extension directly:

```bash
pi -e ./extensions/axonhub/index.ts
```

## Extensions

### AxonHub

`extensions/axonhub` dynamically registers AxonHub models from `/v1/models` and injects trace headers into configured provider requests:

- `AH-Trace-Id`
- `AH-Thread-Id`

Configure `.pi/axonhub.json` or `~/.pi/agent/axonhub.json` to use AxonHub without static `models.json` model entries. The extension supports Pi API modes `openai-completions`, `openai-responses`, and `anthropic-messages`, including per-model overrides.
