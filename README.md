# pi-plugin

Personal Pi package. It currently contains the `pi-axonhub` extension; skills, prompts, and themes can be added later.

## Extensions

### pi-axonhub

Discovers and caches AxonHub models dynamically and adds AxonHub trace/thread headers to provider requests. Requires Pi 0.81.0 or newer.

See [`extensions/axonhub/README.md`](extensions/axonhub/README.md) for configuration and behavior.

## Install

```bash
pi install git:github.com/raikyou/pi-plugin
```

For local development:

```bash
npm install
npm run check
pi -e ./extensions/axonhub/index.ts
```

Only existing resources are declared in `package.json`. Add `skills`, `prompts`, or `themes` to the Pi manifest when those directories are created.
