import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ProviderConfig,
	ProviderModelConfig,
} from "@mariozechner/pi-coding-agent";

const DEFAULT_PROVIDER = "axonhub";
const DEFAULT_CONFIG_FILE = "axonhub.json";
const TRACE_HEADER = "AH-Trace-Id";
const THREAD_HEADER = "AH-Thread-Id";
const SUPPORTED_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

type SupportedApi = (typeof SUPPORTED_APIS)[number];

type AxonHubConfig = {
	baseUrl?: string;
	apiKey?: string;
	provider?: string;
	api?: SupportedApi;
	modelApis?: Record<string, SupportedApi>;
	traceProviders?: string[];
};

type RawAxonHubConfig = {
	baseUrl?: unknown;
	apiKey?: unknown;
	provider?: unknown;
	api?: unknown;
	modelApis?: unknown;
	traceProviders?: unknown;
};

type PiSettings = {
	defaultProvider?: string;
	defaultModel?: string;
};

type ModelsJson = {
	providers?: Record<
		string,
		{
			apiKey?: unknown;
			authHeader?: unknown;
			baseUrl?: unknown;
			headers?: Record<string, unknown>;
		}
	>;
};

type TraceState = {
	config: AxonHubConfig;
	providers: string[];
	threadId: string;
	traceId: string;
	requestsInTrace: number;
	dynamicProvider?: DynamicProviderState;
};

type DynamicProviderState = {
	name: string;
	baseUrl: string;
	models: number;
	error?: string;
};

type AxonHubModelsResponse = {
	data?: AxonHubModel[];
};

type AxonHubModel = {
	id?: unknown;
	name?: unknown;
	context_length?: unknown;
	max_output_tokens?: unknown;
	capabilities?: {
		vision?: unknown;
		tool_call?: unknown;
		reasoning?: unknown;
	};
	pricing?: {
		input?: unknown;
		output?: unknown;
		cache_read?: unknown;
		cache_write?: unknown;
	};
	type?: unknown;
};

export default async function axonhub(pi: ExtensionAPI) {
	const config = loadAxonHubConfig();
	const state: TraceState = {
		config,
		providers: resolveProviders(config),
		threadId: resolveThreadId(),
		traceId: createTraceId("turn"),
		requestsInTrace: 0,
	};

	state.dynamicProvider = await registerDynamicAxonHubProvider(pi, state.config);
	if (state.dynamicProvider && !state.providers.includes(state.dynamicProvider.name)) {
		state.providers = [...state.providers, state.dynamicProvider.name].sort();
	}

	applyTraceHeaders(pi, state);

	pi.on("session_start", async (event, ctx) => {
		state.threadId = resolveThreadId(ctx.sessionManager.getSessionId());
		if (event.reason === "reload") {
			state.config = loadAxonHubConfig();
			state.providers = resolveProviders(state.config);
			state.dynamicProvider = await registerDynamicAxonHubProvider(pi, state.config);
			if (state.dynamicProvider && !state.providers.includes(state.dynamicProvider.name)) {
				state.providers = [...state.providers, state.dynamicProvider.name].sort();
			}
		}
		applyTraceHeaders(pi, state);
		updateStatus(ctx, state);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		state.traceId = createTraceId("turn");
		state.requestsInTrace = 0;
		applyTraceHeaders(pi, state);
		updateStatus(ctx, state);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		state.traceId = createTraceId("compact");
		state.requestsInTrace = 0;
		applyTraceHeaders(pi, state);
		updateStatus(ctx, state);
	});

	pi.on("before_provider_request", (event, ctx) => {
		state.requestsInTrace += 1;
		updateStatus(ctx, state);
		return event.payload;
	});

	pi.on("model_select", async (event) => {
		if (event.source === "set") {
			const providerName = state.config.provider ?? DEFAULT_PROVIDER;
			if (event.model.provider === providerName) {
				savePiDefaultModel(providerName, event.model.id);
			}
		}
	});

	pi.registerCommand("axonhub", {
		description: "Show AxonHub status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatStatus(state), "info");
		},
	});
}

async function registerDynamicAxonHubProvider(
	pi: ExtensionAPI,
	config: AxonHubConfig,
): Promise<DynamicProviderState | undefined> {
	const baseUrl = normalizeBaseUrl(config.baseUrl ?? "");
	if (!baseUrl) return undefined;

	const providerName = config.provider ?? DEFAULT_PROVIDER;
	const apiKey = resolveApiKey(providerName, config);
	const api = config.api ?? "openai-completions";

	try {
		const piSettings = loadPiSettings();
		const defaultModel =
			piSettings.defaultProvider === providerName ? piSettings.defaultModel : undefined;
		const models = await fetchAxonHubModels(baseUrl, apiKey || undefined, api, config.modelApis ?? {}, defaultModel);
		const providerBaseUrl = baseUrlForApi(baseUrl, api);
		pi.registerProvider(providerName, {
			name: "AxonHub",
			baseUrl: providerBaseUrl,
			apiKey: apiKey || config.apiKey || "AXONHUB_API_KEY",
			api,
			models,
		});

		return { name: providerName, baseUrl: providerBaseUrl, models: models.length };
	} catch (error) {
		return {
			name: providerName,
			baseUrl,
			models: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function resolveApiKey(providerName: string, config: AxonHubConfig): string {
	const directOverride = process.env.AXONHUB_API_KEY;
	if (directOverride) return directOverride;

	if (config.apiKey) {
		return process.env[config.apiKey] ?? config.apiKey;
	}

	const modelsJsonApiKey = readModelsJsonApiKey(providerName);
	if (modelsJsonApiKey) {
		return process.env[modelsJsonApiKey] ?? modelsJsonApiKey;
	}

	return "";
}

function readModelsJsonApiKey(providerName: string): string | undefined {
	const modelsPath = join(getAgentDir(), "models.json");
	if (!existsSync(modelsPath)) return undefined;

	try {
		const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as ModelsJson;
		const providerConfig = parsed.providers?.[providerName];
		return typeof providerConfig?.apiKey === "string" ? providerConfig.apiKey : undefined;
	} catch {
		return undefined;
	}
}

async function fetchAxonHubModels(
	baseUrl: string,
	apiKey: string | undefined,
	defaultApi: SupportedApi,
	modelApis: Record<string, SupportedApi>,
	defaultModel?: string,
): Promise<ProviderModelConfig[]> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const url = buildModelsUrl(baseUrl);
	const response = await fetch(url, { headers });
	if (!response.ok) {
		throw new Error(`GET ${url} failed with HTTP ${response.status}`);
	}

	const payload = (await response.json()) as AxonHubModelsResponse;
	const models = (payload.data ?? [])
		.map((model) => toProviderModel(model, defaultApi, modelApis))
		.filter((model): model is ProviderModelConfig => model !== undefined);

	if (models.length === 0) {
		throw new Error(`GET ${url} returned no chat models`);
	}

	if (defaultModel) {
		models.sort((a, b) => {
			if (a.id === defaultModel) return -1;
			if (b.id === defaultModel) return 1;
			return 0;
		});
	}

	return models;
}

function buildModelsUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	return /\/v\d+$/.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

function toProviderModel(
	model: AxonHubModel,
	defaultApi: SupportedApi,
	modelApis: Record<string, SupportedApi>,
): ProviderModelConfig | undefined {
	if (typeof model.id !== "string" || !model.id.trim()) return undefined;
	if (typeof model.type === "string" && model.type !== "chat") return undefined;

	const capabilities = model.capabilities ?? {};
	const pricing = model.pricing ?? {};

	return {
		id: model.id,
		name: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
		api: modelApis[model.id] ?? defaultApi,
		reasoning: capabilities.reasoning === true,
		input: capabilities.vision === true ? ["text", "image"] : ["text"],
		cost: {
			input: numberOrDefault(pricing.input, 0),
			output: numberOrDefault(pricing.output, 0),
			cacheRead: numberOrDefault(pricing.cache_read, 0),
			cacheWrite: numberOrDefault(pricing.cache_write, 0),
		},
		contextWindow: integerOrDefault(model.context_length, 128000),
		maxTokens: integerOrDefault(model.max_output_tokens, 16384),
	};
}

function applyTraceHeaders(pi: ExtensionAPI, state: TraceState) {
	const headers = {
		[TRACE_HEADER]: state.traceId,
		[THREAD_HEADER]: state.threadId,
	};

	for (const provider of state.providers) {
		const config: ProviderConfig = {
			headers,
			...resolveProviderRequestConfig(provider, state),
		};
		pi.registerProvider(provider, config);
	}
}

function resolveProviderRequestConfig(provider: string, state: TraceState): Pick<ProviderConfig, "apiKey" | "authHeader"> {
	if (state.dynamicProvider?.name === provider) {
		return { apiKey: state.config.apiKey ?? "AXONHUB_API_KEY" };
	}

	return resolveModelsJsonProviderRequestConfig(provider);
}

function resolveModelsJsonProviderRequestConfig(provider: string): Pick<ProviderConfig, "apiKey" | "authHeader"> {
	const modelsPath = join(getAgentDir(), "models.json");
	if (!existsSync(modelsPath)) return {};

	try {
		const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as ModelsJson;
		const providerConfig = parsed.providers?.[provider];
		return {
			apiKey: typeof providerConfig?.apiKey === "string" ? providerConfig.apiKey : undefined,
			authHeader: typeof providerConfig?.authHeader === "boolean" ? providerConfig.authHeader : undefined,
		};
	} catch {
		return {};
	}
}

function resolveProviders(config: AxonHubConfig): string[] {
	const providers = new Set<string>([config.provider ?? DEFAULT_PROVIDER]);
	for (const provider of config.traceProviders ?? []) {
		providers.add(provider);
	}
	return [...providers].sort();
}

function resolveThreadId(sessionId?: string) {
	return `pi-${sessionId?.trim() || randomUUID()}`;
}

function createTraceId(reason: string) {
	return `pi-${reason}-${randomUUID()}`;
}

function loadAxonHubConfig(): AxonHubConfig {
	const explicitPath = process.env.PI_AXONHUB_CONFIG?.trim();
	const paths = explicitPath
		? [explicitPath]
		: [join(process.cwd(), ".pi", DEFAULT_CONFIG_FILE), join(getAgentDir(), DEFAULT_CONFIG_FILE)];

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			return normalizeConfig(JSON.parse(readFileSync(path, "utf8")) as RawAxonHubConfig);
		} catch {
			return {};
		}
	}

	return {};
}

function normalizeConfig(raw: RawAxonHubConfig): AxonHubConfig {
	return {
		baseUrl: stringConfig(raw.baseUrl),
		apiKey: stringConfig(raw.apiKey),
		provider: stringConfig(raw.provider),
		api: parseSupportedApi(raw.api),
		modelApis: recordConfig(raw.modelApis, parseSupportedApi),
		traceProviders: stringArrayConfig(raw.traceProviders),
	};
}

function parseSupportedApi(value: unknown): SupportedApi | undefined {
	return typeof value === "string" && SUPPORTED_APIS.includes(value as SupportedApi) ? (value as SupportedApi) : undefined;
}

function stringConfig(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayConfig(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
	return items.length > 0 ? items : undefined;
}

function recordConfig<T>(value: unknown, parseValue: (value: unknown) => T | undefined): Record<string, T> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

	const entries = Object.entries(value)
		.map(([key, rawValue]) => [key, parseValue(rawValue)] as const)
		.filter((entry): entry is readonly [string, T] => entry[1] !== undefined);

	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeBaseUrl(value: string) {
	const trimmed = value.trim();
	if (!trimmed) return "";
	return trimmed.replace(/\/+$/, "");
}

/**
 * Adjust baseUrl for a specific API type.
 *
 * Anthropic SDK expects baseUrl without /v1 (it appends /v1/messages).
 * OpenAI SDK expects baseUrl with /v1 (it appends /chat/completions).
 */
function baseUrlForApi(baseUrl: string, api: SupportedApi): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	const hasVersion = /\/v\d+$/.test(trimmed);

	if (api === "anthropic-messages") {
		return hasVersion ? trimmed.replace(/\/v\d+$/, "") : trimmed;
	}

	// openai-completions and openai-responses expect /v1
	return hasVersion ? trimmed : `${trimmed}/v1`;
}

function numberOrDefault(value: unknown, fallback: number) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function integerOrDefault(value: unknown, fallback: number) {
	const number = numberOrDefault(value, fallback);
	return Number.isInteger(number) && number > 0 ? number : fallback;
}

function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

function loadPiSettings(): PiSettings {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(process.cwd(), ".pi", "settings.json");;

	let raw: Record<string, unknown> = {};

	for (const path of [globalPath, projectPath]) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			raw = { ...raw, ...parsed };
		} catch {
			// ignore
		}
	}

	return {
		defaultProvider: typeof raw.defaultProvider === "string" ? raw.defaultProvider : undefined,
		defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : undefined,
	};
}

function savePiDefaultModel(provider: string, modelId: string) {
	const settingsPath = join(getAgentDir(), "settings.json");
	let raw: Record<string, unknown> = {};

	if (existsSync(settingsPath)) {
		try {
			raw = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		} catch {
			// ignore, overwrite
		}
	}

	raw.defaultProvider = provider;
	raw.defaultModel = modelId;

	try {
		const dir = settingsPath.replace(/[^/\\]+$/, "");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
	} catch {
		// best effort
	}
}

function updateStatus(_ctx: ExtensionContext | ExtensionCommandContext, _state: TraceState) {}

function formatStatus(state: TraceState) {
	const lines = [
		`AxonHub tracing: ${state.providers.join(", ")}`,
		`Trace: ${state.traceId}`,
		`Thread: ${state.threadId}`,
		`Requests in trace: ${state.requestsInTrace}`,
	];

	if (state.dynamicProvider) {
		lines.push(
			state.dynamicProvider.error
				? `Dynamic provider: ${state.dynamicProvider.name} failed (${state.dynamicProvider.error})`
				: `Dynamic provider: ${state.dynamicProvider.name} (${state.dynamicProvider.models} models)`,
		);
	}

	return lines.join("\n");
}
