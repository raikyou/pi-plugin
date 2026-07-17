import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { resolvePiAiCompat } from "./compat.ts";

const DEFAULT_PROVIDER = "axonhub";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const TRACE_HEADER = "AH-Trace-Id";
const THREAD_HEADER = "AH-Thread-Id";
const SUPPORTED_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;

type SupportedApi = (typeof SUPPORTED_APIS)[number];

/** AxonHub developer IDs that have a corresponding first-party Pi AI provider. */
const AXONHUB_DEVELOPER_PROVIDERS: Record<string, BuiltinProvider> = {
	anthropic: "anthropic",
	deepseek: "deepseek",
	google: "google",
	minimax: "minimax",
	mistral: "mistral",
	moonshot: "moonshotai",
	nvidia: "nvidia",
	openai: "openai",
	xai: "xai",
	xiaomi: "xiaomi",
	zai: "zai",
};

const builtinModelCache = new Map<BuiltinProvider, Map<string, Model<Api>>>();

type AxonHubConfig = {
	baseUrl?: string;
	apiKey?: string;
	provider?: string;
	api?: SupportedApi;
	modelApis?: Record<string, SupportedApi>;
	traceProviders?: string[];
	requestTimeoutMs?: number;
};

type RawAxonHubConfig = {
	baseUrl?: unknown;
	apiKey?: unknown;
	provider?: unknown;
	api?: unknown;
	modelApis?: unknown;
	traceProviders?: unknown;
	requestTimeoutMs?: unknown;
};

type PiSettings = {
	defaultProvider?: string;
	defaultModel?: string;
	axonhub?: RawAxonHubConfig;
};

type ModelsJson = {
	providers?: Record<
		string,
		{
			apiKey?: unknown;
			authHeader?: unknown;
		}
	>;
};

type TraceState = {
	config: AxonHubConfig;
	providers: string[];
	threadId: string;
	traceId: string;
	requestsInTrace: number;
	traceBeforeCompaction?: string;
	requestsBeforeCompaction?: number;
	dynamicProvider?: DynamicProviderState;
};

type DynamicProviderState = {
	name: string;
	baseUrl: string;
	models: number;
	error?: string;
};

type SelectedModelStatus = {
	provider: string;
	id: string;
	api: string;
	baseUrl: string;
};

type AxonHubModel = {
	id?: unknown;
	name?: unknown;
	owned_by?: unknown;
	context_length?: unknown;
	max_output_tokens?: unknown;
	modalities?: {
		input?: unknown;
	};
	capabilities?: {
		vision?: unknown;
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

export default async function piAxonHub(pi: ExtensionAPI) {
	const config = loadAxonHubConfig();
	const state: TraceState = {
		config,
		providers: resolveProviders(config),
		threadId: resolveThreadId(),
		traceId: createTraceId("turn"),
		requestsInTrace: 0,
	};

	state.dynamicProvider = await registerDynamicAxonHubProvider(pi, config);
	if (state.dynamicProvider && !state.providers.includes(state.dynamicProvider.name)) {
		state.providers = [...state.providers, state.dynamicProvider.name].sort();
	}

	pi.on("session_start", (_event, ctx) => {
		state.threadId = resolveThreadId(ctx.sessionManager.getSessionId());
	});

	pi.on("before_agent_start", () => {
		state.traceId = createTraceId("turn");
		state.requestsInTrace = 0;
		state.traceBeforeCompaction = undefined;
		state.requestsBeforeCompaction = undefined;
	});

	pi.on("session_before_compact", () => {
		state.traceBeforeCompaction = state.traceId;
		state.requestsBeforeCompaction = state.requestsInTrace;
		state.traceId = createTraceId("compact");
		state.requestsInTrace = 0;
	});

	pi.on("session_compact", () => {
		state.traceId = state.traceBeforeCompaction ?? createTraceId("turn");
		state.requestsInTrace = state.requestsBeforeCompaction ?? 0;
		state.traceBeforeCompaction = undefined;
		state.requestsBeforeCompaction = undefined;
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isTracedProvider(ctx.model?.provider, state)) return;

		event.headers[TRACE_HEADER] = state.traceId;
		event.headers[THREAD_HEADER] = state.threadId;
		state.requestsInTrace += 1;
	});

	pi.registerCommand("pi-axonhub", {
		description: "Show pi-axonhub status",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			ctx.ui.notify(
				formatStatus(
					state,
					model
						? { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl }
						: undefined,
				),
				"info",
			);
		},
	});
}

async function registerDynamicAxonHubProvider(
	pi: ExtensionAPI,
	config: AxonHubConfig,
): Promise<DynamicProviderState | undefined> {
	if (!config.baseUrl) return undefined;

	const providerName = config.provider ?? DEFAULT_PROVIDER;
	let baseUrl = config.baseUrl;

	try {
		baseUrl = normalizeBaseUrl(config.baseUrl);
		const api = config.api ?? "openai-completions";
		const piSettings = loadPiSettings();
		const defaultModel =
			piSettings.defaultProvider === providerName ? piSettings.defaultModel : undefined;
		const models = await fetchAxonHubModels(
			baseUrl,
			resolveApiKeyForFetch(providerName, config),
			api,
			config.modelApis ?? {},
			defaultModel,
			config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		);
		const modelsProviderConfig = readModelsJsonProviderConfig(providerName);

		pi.registerProvider(providerName, {
			name: "pi-axonhub",
			baseUrl: stripVersionSuffix(baseUrl),
			apiKey: resolveProviderApiKey(providerName, config),
			authHeader: modelsProviderConfig.authHeader,
			api,
			models,
		});

		return { name: providerName, baseUrl: stripVersionSuffix(baseUrl), models: models.length };
	} catch (error) {
		return {
			name: providerName,
			baseUrl,
			models: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function resolveProviderApiKey(providerName: string, config: AxonHubConfig): string {
	if (process.env.AXONHUB_API_KEY) return "$AXONHUB_API_KEY";

	const configured = config.apiKey ?? readModelsJsonProviderConfig(providerName).apiKey;
	if (!configured) return "$AXONHUB_API_KEY";

	const envName = parseEnvReference(configured);
	if (envName) return `$${envName}`;

	// Preserve support for the legacy bare environment-variable form.
	if (isEnvironmentName(configured) && process.env[configured] !== undefined) {
		return `$${configured}`;
	}

	return configured;
}

function resolveApiKeyForFetch(providerName: string, config: AxonHubConfig): string | undefined {
	if (process.env.AXONHUB_API_KEY) return process.env.AXONHUB_API_KEY;

	const configured = config.apiKey ?? readModelsJsonProviderConfig(providerName).apiKey;
	if (!configured || configured.startsWith("!")) return undefined;

	const envName = parseEnvReference(configured);
	if (envName) return process.env[envName];

	if (isEnvironmentName(configured)) {
		// A configured bare name resolves from the environment when present;
		// otherwise preserve backward compatibility by treating it as a literal.
		return process.env[configured] ?? configured;
	}

	return configured;
}

function parseEnvReference(value: string): string | undefined {
	const trimmed = value.trim();
	const braced = trimmed.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
	if (braced) return braced[1];

	return trimmed.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
}

function isEnvironmentName(value: string): boolean {
	return /^[A-Z_][A-Z0-9_]*$/.test(value.trim());
}

function readModelsJsonProviderConfig(providerName: string): { apiKey?: string; authHeader?: boolean } {
	const modelsPath = join(getAgentDir(), "models.json");
	if (!existsSync(modelsPath)) return {};

	try {
		const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as ModelsJson;
		const providerConfig = parsed.providers?.[providerName];
		return {
			apiKey: typeof providerConfig?.apiKey === "string" ? providerConfig.apiKey.trim() : undefined,
			authHeader: typeof providerConfig?.authHeader === "boolean" ? providerConfig.authHeader : undefined,
		};
	} catch {
		return {};
	}
}

async function fetchAxonHubModels(
	baseUrl: string,
	apiKey: string | undefined,
	defaultApi: SupportedApi,
	modelApis: Record<string, SupportedApi>,
	defaultModel: string | undefined,
	timeoutMs: number,
): Promise<ProviderModelConfig[]> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const url = buildModelsUrl(baseUrl);
	const response = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		throw new Error(`GET ${url} failed with HTTP ${response.status}`);
	}

	const payload = (await response.json()) as unknown;
	const data = objectConfig(payload)?.data;
	if (!Array.isArray(data)) {
		throw new Error(`GET ${url} returned an invalid model catalog`);
	}

	const modelsById = new Map<string, ProviderModelConfig>();
	for (const rawModel of data) {
		const model = toProviderModel(objectConfig(rawModel) as AxonHubModel | undefined, defaultApi, modelApis, baseUrl);
		if (model) modelsById.set(model.id, model);
	}

	const models = [...modelsById.values()].sort((a, b) => {
		if (a.id === defaultModel) return -1;
		if (b.id === defaultModel) return 1;
		return a.id.localeCompare(b.id);
	});

	if (models.length === 0) {
		throw new Error(`GET ${url} returned no chat models`);
	}

	return models;
}

function buildModelsUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	const path = url.pathname.replace(/\/+$/, "");
	url.pathname = /\/v\d+$/.test(path) ? `${path}/models` : `${path}/v1/models`;
	url.search = "";
	url.searchParams.set("include", "all");
	return url.toString();
}

function toProviderModel(
	model: AxonHubModel | undefined,
	defaultApi: SupportedApi,
	modelApis: Record<string, SupportedApi>,
	baseUrl: string,
): ProviderModelConfig | undefined {
	if (!model || typeof model.id !== "string") return undefined;
	const id = model.id.trim();
	if (!id || (typeof model.type === "string" && model.type !== "chat")) return undefined;

	const capabilities = objectConfig(model.capabilities) ?? {};
	const pricing = objectConfig(model.pricing) ?? {};
	const piAiModel = findPiAiModel(id, model.owned_by);
	const inheritedApi = parseSupportedApi(piAiModel?.api);
	const modelApi = modelApis[id] ?? inheritedApi ?? defaultApi;

	return {
		id,
		name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : (piAiModel?.name ?? id),
		api: modelApi,
		baseUrl: baseUrlForApi(baseUrl, modelApi),
		reasoning:
			typeof capabilities.reasoning === "boolean" ? capabilities.reasoning : (piAiModel?.reasoning ?? false),
		thinkingLevelMap: piAiModel?.thinkingLevelMap ? { ...piAiModel.thinkingLevelMap } : undefined,
		input: resolveModelInput(model, piAiModel),
		cost: {
			input: nonNegativeNumberOrDefault(pricing.input, piAiModel?.cost.input ?? 0),
			output: nonNegativeNumberOrDefault(pricing.output, piAiModel?.cost.output ?? 0),
			cacheRead: nonNegativeNumberOrDefault(pricing.cache_read, piAiModel?.cost.cacheRead ?? 0),
			cacheWrite: nonNegativeNumberOrDefault(pricing.cache_write, piAiModel?.cost.cacheWrite ?? 0),
		},
		contextWindow: positiveIntegerOrDefault(model.context_length, piAiModel?.contextWindow ?? 128_000),
		maxTokens: positiveIntegerOrDefault(model.max_output_tokens, piAiModel?.maxTokens ?? 16_384),
		compat: resolvePiAiCompat(piAiModel, modelApi),
	};
}

function findPiAiModel(modelId: string, developer: unknown): Model<Api> | undefined {
	const provider = piAiProviderForDeveloper(developer);
	if (!provider) return undefined;

	let models = builtinModelCache.get(provider);
	if (!models) {
		models = new Map(getBuiltinModels(provider).map((model) => [model.id, model as Model<Api>]));
		builtinModelCache.set(provider, models);
	}
	return models.get(modelId);
}

function piAiProviderForDeveloper(developer: unknown): BuiltinProvider | undefined {
	if (typeof developer !== "string") return undefined;
	return AXONHUB_DEVELOPER_PROVIDERS[developer.trim().toLowerCase()];
}

function resolveModelInput(model: AxonHubModel, piAiModel: Model<Api> | undefined): ("text" | "image")[] {
	if (Array.isArray(model.modalities?.input)) {
		const input = model.modalities.input.filter(
			(modality): modality is "text" | "image" => modality === "text" || modality === "image",
		);
		if (input.length > 0) return [...new Set(input)];
	}

	if (typeof model.capabilities?.vision === "boolean") {
		return model.capabilities.vision ? ["text", "image"] : ["text"];
	}

	return piAiModel ? [...piAiModel.input] : ["text"];
}

function resolveProviders(config: AxonHubConfig): string[] {
	const providers = new Set<string>([config.provider ?? DEFAULT_PROVIDER]);
	for (const provider of config.traceProviders ?? []) providers.add(provider);
	return [...providers].sort();
}

function isTracedProvider(provider: string | undefined, state: TraceState): boolean {
	return provider !== undefined && state.providers.includes(provider);
}

function resolveThreadId(sessionId?: string): string {
	return `pi-${sessionId?.trim() || randomUUID()}`;
}

function createTraceId(reason: "turn" | "compact"): string {
	return `pi-${reason}-${randomUUID()}`;
}

function loadAxonHubConfig(): AxonHubConfig {
	return normalizeConfig(loadPiSettings().axonhub ?? {});
}

function normalizeConfig(raw: RawAxonHubConfig): AxonHubConfig {
	return {
		baseUrl: stringConfig(raw.baseUrl),
		apiKey: stringConfig(raw.apiKey),
		provider: stringConfig(raw.provider),
		api: parseSupportedApi(raw.api),
		modelApis: recordConfig(raw.modelApis, parseSupportedApi),
		traceProviders: stringArrayConfig(raw.traceProviders),
		requestTimeoutMs: boundedIntegerConfig(raw.requestTimeoutMs, 1_000, 120_000),
	};
}

function parseSupportedApi(value: unknown): SupportedApi | undefined {
	return typeof value === "string" && SUPPORTED_APIS.includes(value as SupportedApi)
		? (value as SupportedApi)
		: undefined;
}

function stringConfig(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayConfig(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
	return items.length > 0 ? [...new Set(items)] : undefined;
}

function recordConfig<T>(
	value: unknown,
	parseValue: (value: unknown) => T | undefined,
): Record<string, T> | undefined {
	if (!objectConfig(value)) return undefined;

	const entries = Object.entries(value as Record<string, unknown>)
		.map(([key, rawValue]) => [key.trim(), parseValue(rawValue)] as const)
		.filter((entry): entry is readonly [string, T] => Boolean(entry[0]) && entry[1] !== undefined);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function boundedIntegerConfig(value: unknown, minimum: number, maximum: number): number | undefined {
	const parsed = typeof value === "number" ? value : Number.NaN;
	return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function normalizeBaseUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Unsupported AxonHub URL protocol: ${url.protocol}`);
	}
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/$/, "");
}

/** Remove trailing slashes and a terminal /vN API version segment. */
function stripVersionSuffix(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/v\d+$/, "");
}

function baseUrlForApi(baseUrl: string, api: SupportedApi): string {
	const clean = stripVersionSuffix(baseUrl);
	if (api === "anthropic-messages") return clean;
	if (api === "google-generative-ai") return `${clean}/v1beta`;
	return `${clean}/v1`;
}

function finiteNumber(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

function nonNegativeNumberOrDefault(value: unknown, fallback: number): number {
	const parsed = finiteNumber(value);
	return parsed !== undefined && parsed >= 0 ? parsed : fallback;
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
	const parsed = finiteNumber(value);
	return parsed !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

function loadPiSettings(): PiSettings {
	const raw = loadSettingsJson();
	return {
		defaultProvider: typeof raw.defaultProvider === "string" ? raw.defaultProvider : undefined,
		defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : undefined,
		axonhub: objectConfig(raw.axonhub) as RawAxonHubConfig | undefined,
	};
}

function loadSettingsJson(): Record<string, unknown> {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(process.cwd(), CONFIG_DIR_NAME, "settings.json");
	let settings: Record<string, unknown> = {};

	for (const path of [globalPath, projectPath]) {
		if (!existsSync(path)) continue;
		try {
			const next = objectConfig(JSON.parse(readFileSync(path, "utf8")));
			if (!next) continue;

			const previousAxonHub = objectConfig(settings.axonhub) ?? {};
			const nextAxonHub = objectConfig(next.axonhub);
			settings = { ...settings, ...next };
			if (nextAxonHub) settings.axonhub = { ...previousAxonHub, ...nextAxonHub };
		} catch {
			// Ignore malformed settings here; Pi reports its own settings errors.
		}
	}

	return settings;
}

function objectConfig(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function formatStatus(state: TraceState, model?: SelectedModelStatus): string {
	const lines = [
		`pi-axonhub tracing: ${state.providers.join(", ")}`,
		`Trace: ${state.traceId}`,
		`Thread: ${state.threadId}`,
		`Requests in trace: ${state.requestsInTrace}`,
	];

	if (model) {
		lines.push(
			`Selected model: ${model.provider}/${model.id}`,
			`Protocol: ${model.api}`,
			`Endpoint base: ${model.baseUrl}`,
		);
	}

	if (state.dynamicProvider) {
		lines.push(
			state.dynamicProvider.error
				? `Dynamic provider: ${state.dynamicProvider.name} failed (${state.dynamicProvider.error})`
				: `Dynamic provider: ${state.dynamicProvider.name} (${state.dynamicProvider.models} models)`,
		);
	}

	return lines.join("\n");
}
