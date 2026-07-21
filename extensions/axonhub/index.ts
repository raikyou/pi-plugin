import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { join } from "node:path";
import {
	createProvider,
	type Api,
	type ApiKeyAuth,
	type Credential,
	type Model,
	type Provider,
	type ProviderStreams,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import {
	builtinProviders,
	getBuiltinModels,
	getBuiltinProviders,
	type BuiltinProvider,
} from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePiAiCompat } from "./compat.ts";

const DEFAULT_PROVIDER = "axonhub";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const TRACE_HEADER = "AH-Trace-Id";
const THREAD_HEADER = "AH-Thread-Id";

// Headers to drop from Codex-passthrough requests so they match a real native
// Codex call on the wire (a genuine Codex request uses raw fetch/WebSocket and
// carries none of these; AxonHub forwards inbound headers upstream). Pi's
// OpenAI SDK injects `x-stainless-*` telemetry after `before_provider_headers`
// runs, so they are absent from `event.headers` there and can only be removed
// by name: a null value lands in the SDK's defaultHeaders, which drops null
// entries. `session_id` is Pi's OpenAI session-affinity header (underscore);
// Codex uses the hyphenated `session-id`, and AxonHub's Codex reader prefers the
// underscore form, so it must go too. The list tracks the OpenAI SDK's headers
// and may need updating if the SDK adds new telemetry headers.
const CODEX_STRIPPED_HEADERS = [
	"session_id",
	"x-stainless-arch",
	"x-stainless-async",
	"x-stainless-lang",
	"x-stainless-os",
	"x-stainless-package-version",
	"x-stainless-read-timeout",
	"x-stainless-retry-count",
	"x-stainless-runtime",
	"x-stainless-runtime-version",
	"x-stainless-timeout",
] as const;
const SUPPORTED_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;

type SupportedApi = (typeof SUPPORTED_APIS)[number];

/** Default AxonHub developer IDs that have a corresponding first-party Pi AI provider. */
const DEFAULT_PROVIDER_MAP: Readonly<Record<string, BuiltinProvider>> = {
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

const BUILTIN_PROVIDERS = new Set<string>(getBuiltinProviders());

type ProviderMap = Record<string, BuiltinProvider | null>;

const builtinModelCache = new Map<BuiltinProvider, Map<string, Model<Api>>>();
let builtinProviderRuntimes: Map<string, Provider> | undefined;

type AxonHubConfig = {
	baseUrl?: string;
	apiKey?: string;
	provider?: string;
	api?: SupportedApi;
	modelApis?: Record<string, SupportedApi>;
	providerMap?: ProviderMap;
	traceProviders?: string[];
	requestTimeoutMs?: number;
};

type RawAxonHubConfig = {
	baseUrl?: unknown;
	apiKey?: unknown;
	provider?: unknown;
	api?: unknown;
	modelApis?: unknown;
	providerMap?: unknown;
	traceProviders?: unknown;
	requestTimeoutMs?: unknown;
};

type PiSettings = {
	defaultProvider?: string;
	defaultModel?: string;
	axonhub?: RawAxonHubConfig;
};

type ModelsJson = {
	providers?: Record<string, { apiKey?: unknown }>;
};

type TraceState = {
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

type AxonHubProviderModel = Model<SupportedApi> & {
	/** Persisted with Pi's dynamic catalog so Codex passthrough survives restarts. */
	axonhubCodexResponses?: true;
};

type ApiKeyConfig =
	| { kind: "environment"; name: string }
	| { kind: "environment-or-literal"; name: string; fallback: string }
	| { kind: "literal"; value: string };

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

export default function piAxonHub(pi: ExtensionAPI) {
	const piSettings = loadPiSettings();
	const config = normalizeConfig(piSettings.axonhub ?? {});
	const state: TraceState = {
		providers: resolveProviders(config),
		threadId: resolveThreadId(),
		traceId: createTraceId("turn"),
		requestsInTrace: 0,
	};

	state.dynamicProvider = registerDynamicAxonHubProvider(pi, config, piSettings);
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

		if (!isCodexResponsesModel(ctx.model, state)) return;

		for (const header of CODEX_STRIPPED_HEADERS) event.headers[header] = null;
		const codexSessionId = ctx.sessionManager.getSessionId();
		event.headers.accept = "text/event-stream";
		event.headers["OpenAI-Beta"] = "responses=experimental";
		event.headers.originator = "pi";
		event.headers["session-id"] = codexSessionId;
		event.headers["x-client-request-id"] = codexSessionId;
		event.headers["User-Agent"] = `pi (${platform()} ${release()}; ${arch()})`;
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isCodexResponsesModel(ctx.model, state)) return;

		const payload = objectConfig(event.payload);
		if (!payload) return;
		return toCodexResponsesPayload(payload);
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

function registerDynamicAxonHubProvider(
	pi: ExtensionAPI,
	config: AxonHubConfig,
	piSettings: PiSettings,
): DynamicProviderState | undefined {
	if (!config.baseUrl) return undefined;

	const providerName = config.provider ?? DEFAULT_PROVIDER;
	let baseUrl = config.baseUrl;
	const state: DynamicProviderState = {
		name: providerName,
		baseUrl,
		models: 0,
	};

	try {
		baseUrl = normalizeBaseUrl(config.baseUrl);
		state.baseUrl = stripVersionSuffix(baseUrl);
		const defaultApi = config.api ?? "openai-completions";
		const defaultModel =
			piSettings.defaultProvider === providerName ? piSettings.defaultModel : undefined;

		const provider = createProvider<SupportedApi>({
			id: providerName,
			name: "pi-axonhub",
			baseUrl: state.baseUrl,
			auth: { apiKey: createAxonHubApiKeyAuth(config) },
			models: [],
			fetchModels: (context) =>
				fetchAxonHubModels(
					baseUrl,
					resolveApiKeyForFetch(providerName, config, context.credential),
					providerName,
					defaultApi,
					config.modelApis ?? {},
					config.providerMap ?? {},
					defaultModel,
					config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
					context.signal,
				),
			api: {
				"openai-completions": builtinProviderStreams("openrouter"),
				"openai-responses": builtinProviderStreams("openai"),
				"anthropic-messages": builtinProviderStreams("anthropic"),
				"google-generative-ai": builtinProviderStreams("google"),
			},
		});

		pi.registerProvider(trackDynamicProvider(provider, state));
		return state;
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error);
		return state;
	}
}

function builtinProviderStreams(providerId: BuiltinProvider): ProviderStreams {
	builtinProviderRuntimes ??= new Map(builtinProviders().map((provider) => [provider.id, provider]));
	const provider = builtinProviderRuntimes.get(providerId);
	if (!provider) throw new Error(`Missing built-in Pi AI provider: ${providerId}`);

	return {
		stream: (model, context, options) => provider.stream(model, context, options),
		streamSimple: (model, context, options) => provider.streamSimple(model, context, options),
	};
}

function trackDynamicProvider(
	provider: Provider<SupportedApi>,
	state: DynamicProviderState,
): Provider<SupportedApi> {
	const refreshModels = provider.refreshModels;
	if (!refreshModels) return provider;

	return {
		...provider,
		async refreshModels(context: RefreshModelsContext) {
			try {
				await refreshModels(context);
				state.models = provider.getModels().length;
				if (context.allowNetwork && !context.signal?.aborted) state.error = undefined;
			} catch (error) {
				state.error = error instanceof Error ? error.message : String(error);
				throw error;
			}
		},
	};
}

function createAxonHubApiKeyAuth(config: AxonHubConfig): ApiKeyAuth {
	return {
		name: "AxonHub API key",
		async login(interaction) {
			return {
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter AxonHub API key" }),
			};
		},
		async resolve({ ctx, credential }) {
			const envKey = await ctx.env("AXONHUB_API_KEY");
			if (envKey) return { auth: { apiKey: envKey }, source: "AXONHUB_API_KEY" };
			if (credential?.key) {
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			}

			const configured = await resolveConfiguredApiKey(config.apiKey, (name) => ctx.env(name));
			return configured
				? { auth: { apiKey: configured }, source: "axonhub.apiKey" }
				: undefined;
		},
	};
}

function resolveApiKeyForFetch(
	providerName: string,
	config: AxonHubConfig,
	credential?: Credential,
): string | undefined {
	if (process.env.AXONHUB_API_KEY) return process.env.AXONHUB_API_KEY;
	if (credential?.type === "api_key" && credential.key) return credential.key;

	const key = classifyApiKey(config.apiKey ?? readModelsJsonProviderConfig(providerName).apiKey);
	if (!key) return undefined;

	switch (key.kind) {
		case "environment":
			return process.env[key.name];
		case "environment-or-literal":
			return process.env[key.name] ?? key.fallback;
		case "literal":
			return key.value;
	}
}

async function resolveConfiguredApiKey(
	configured: string | undefined,
	getEnv: (name: string) => Promise<string | undefined>,
): Promise<string | undefined> {
	const key = classifyApiKey(configured);
	if (!key) return undefined;

	switch (key.kind) {
		case "environment":
			return getEnv(key.name);
		case "environment-or-literal":
			return (await getEnv(key.name)) ?? key.fallback;
		case "literal":
			return key.value;
	}
}

function classifyApiKey(configured: string | undefined): ApiKeyConfig | undefined {
	if (!configured || configured.startsWith("!")) return undefined;

	const envName = parseEnvReference(configured);
	if (envName) return { kind: "environment", name: envName };

	if (isEnvironmentName(configured)) {
		// Preserve backward compatibility: a bare uppercase name resolves from
		// the environment when present and otherwise remains a literal key.
		return { kind: "environment-or-literal", name: configured, fallback: configured };
	}

	return { kind: "literal", value: configured };
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

function readModelsJsonProviderConfig(providerName: string): { apiKey?: string } {
	const modelsPath = join(getAgentDir(), "models.json");
	if (!existsSync(modelsPath)) return {};

	try {
		const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as ModelsJson;
		const providerConfig = parsed.providers?.[providerName];
		return {
			apiKey: typeof providerConfig?.apiKey === "string" ? providerConfig.apiKey.trim() : undefined,
		};
	} catch {
		return {};
	}
}

async function fetchAxonHubModels(
	baseUrl: string,
	apiKey: string | undefined,
	providerName: string,
	defaultApi: SupportedApi,
	modelApis: Record<string, SupportedApi>,
	providerMap: ProviderMap,
	defaultModel: string | undefined,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AxonHubProviderModel[]> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const url = buildModelsUrl(baseUrl);
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const response = await fetch(url, {
		headers,
		signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
	});
	if (!response.ok) {
		throw new Error(`GET ${url} failed with HTTP ${response.status}`);
	}

	const payload = (await response.json()) as unknown;
	const data = objectConfig(payload)?.data;
	if (!Array.isArray(data)) {
		throw new Error(`GET ${url} returned an invalid model catalog`);
	}

	const modelsById = new Map<string, AxonHubProviderModel>();
	for (const rawModel of data) {
		const model = toProviderModel(
			objectConfig(rawModel) as AxonHubModel | undefined,
			defaultApi,
			modelApis,
			providerMap,
			providerName,
			baseUrl,
		);
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
	providerMap: ProviderMap,
	providerName: string,
	baseUrl: string,
): AxonHubProviderModel | undefined {
	if (!model || typeof model.id !== "string") return undefined;
	const id = model.id.trim();
	if (!id || (typeof model.type === "string" && model.type !== "chat")) return undefined;

	const capabilities = objectConfig(model.capabilities) ?? {};
	const pricing = objectConfig(model.pricing) ?? {};
	const piAiModel = findPiAiModel(id, model.owned_by, providerMap);
	const inheritedApi = resolveInheritedApi(piAiModel?.api);
	const modelApi = modelApis[id] ?? inheritedApi ?? defaultApi;

	const usesCodexResponsesCompatibility =
		piAiModel?.api === "openai-codex-responses" && modelApi === "openai-responses";

	return {
		id,
		name:
			typeof model.name === "string" && model.name.trim()
				? model.name.trim()
				: (piAiModel?.name ?? id),
		api: modelApi,
		provider: providerName,
		baseUrl: baseUrlForApi(baseUrl, modelApi),
		reasoning:
			piAiModel?.reasoning ??
			(typeof capabilities.reasoning === "boolean" ? capabilities.reasoning : false),
		thinkingLevelMap: piAiModel?.thinkingLevelMap ? { ...piAiModel.thinkingLevelMap } : undefined,
		input: resolveModelInput(model, piAiModel),
		cost: piAiModel
			? { ...piAiModel.cost }
			: {
					input: nonNegativeNumberOrDefault(pricing.input, 0),
					output: nonNegativeNumberOrDefault(pricing.output, 0),
					cacheRead: nonNegativeNumberOrDefault(pricing.cache_read, 0),
					cacheWrite: nonNegativeNumberOrDefault(pricing.cache_write, 0),
				},
		contextWindow:
			piAiModel?.contextWindow ?? positiveIntegerOrDefault(model.context_length, 128_000),
		maxTokens: piAiModel?.maxTokens ?? positiveIntegerOrDefault(model.max_output_tokens, 16_384),
		compat: resolvePiAiCompat(piAiModel, modelApi),
		...(usesCodexResponsesCompatibility ? { axonhubCodexResponses: true as const } : {}),
	};
}

function resolveInheritedApi(api: Api | undefined): SupportedApi | undefined {
	// AxonHub exposes Codex-backed routes through its OpenAI Responses endpoint.
	if (api === "openai-codex-responses") return "openai-responses";
	return parseSupportedApi(api);
}

/** Reshape Pi's standard Responses payload to the body expected by the Codex backend. */
function toCodexResponsesPayload(payload: Record<string, unknown>): Record<string, unknown> {
	let instructions: unknown;
	const input = Array.isArray(payload.input)
		? payload.input.filter((item) => {
				const message = objectConfig(item);
				if (
					instructions === undefined &&
					(message?.role === "developer" || message?.role === "system")
				) {
					instructions = message.content;
					return false;
				}
				return true;
			})
		: [];

	const tools = Array.isArray(payload.tools)
		? payload.tools.map((tool) => {
				const definition = objectConfig(tool);
				return definition ? { ...definition, strict: null } : tool;
			})
		: undefined;

	const nextPayload: Record<string, unknown> = {
		...payload,
		store: false,
		stream: true,
		instructions: instructions ?? payload.instructions ?? "You are a helpful assistant.",
		input,
		text: { verbosity: "low", ...objectConfig(payload.text) },
		include: ["reasoning.encrypted_content"],
		tool_choice: payload.tool_choice ?? "auto",
		parallel_tool_calls: true,
	};
	if (tools) nextPayload.tools = tools;

	delete nextPayload.max_output_tokens;
	delete nextPayload.prompt_cache_retention;

	// Codex only carries a reasoning block when an effort is actually requested;
	// Pi's Responses payload instead emits a summary-less reasoning object (e.g.
	// `{ effort: "none" }`) when thinking is off. Drop that to match Codex exactly
	// and to avoid the backend rejecting an `effort: "none"` request.
	const reasoning = objectConfig(nextPayload.reasoning);
	if (reasoning && reasoning.summary === undefined) delete nextPayload.reasoning;

	return nextPayload;
}

function findPiAiModel(
	modelId: string,
	developer: unknown,
	providerMap: ProviderMap,
): Model<Api> | undefined {
	const provider = piAiProviderForDeveloper(developer, providerMap);
	if (!provider) return undefined;

	let models = builtinModelCache.get(provider);
	if (!models) {
		models = new Map(getBuiltinModels(provider).map((model) => [model.id, model as Model<Api>]));
		builtinModelCache.set(provider, models);
	}
	return models.get(modelId);
}

function piAiProviderForDeveloper(
	developer: unknown,
	providerMap: ProviderMap,
): BuiltinProvider | undefined {
	if (typeof developer !== "string") return undefined;
	const developerId = developer.trim().toLowerCase();
	const configuredProvider = providerMap[developerId];
	return configuredProvider === null ? undefined : (configuredProvider ?? DEFAULT_PROVIDER_MAP[developerId]);
}

function resolveModelInput(model: AxonHubModel, piAiModel: Model<Api> | undefined): ("text" | "image")[] {
	if (piAiModel) return [...piAiModel.input];

	if (Array.isArray(model.modalities?.input)) {
		const input = model.modalities.input.filter(
			(modality): modality is "text" | "image" => modality === "text" || modality === "image",
		);
		if (input.length > 0) return [...new Set(input)];
	}

	if (typeof model.capabilities?.vision === "boolean") {
		return model.capabilities.vision ? ["text", "image"] : ["text"];
	}

	return ["text"];
}

function resolveProviders(config: AxonHubConfig): string[] {
	const providers = new Set<string>([config.provider ?? DEFAULT_PROVIDER]);
	for (const provider of config.traceProviders ?? []) providers.add(provider);
	return [...providers].sort();
}

function isTracedProvider(provider: string | undefined, state: TraceState): boolean {
	return provider !== undefined && state.providers.includes(provider);
}

/** A dynamically-registered AxonHub model that must be sent as a native Codex Responses request. */
function isCodexResponsesModel(model: Model<Api> | undefined, state: TraceState): boolean {
	return (
		model?.provider === state.dynamicProvider?.name &&
		(model as AxonHubProviderModel | undefined)?.axonhubCodexResponses === true
	);
}

function resolveThreadId(sessionId?: string): string {
	return `pi-${sessionId?.trim() || randomUUID()}`;
}

function createTraceId(reason: "turn" | "compact"): string {
	return `pi-${reason}-${randomUUID()}`;
}

function normalizeConfig(raw: RawAxonHubConfig): AxonHubConfig {
	return {
		baseUrl: stringConfig(raw.baseUrl),
		apiKey: stringConfig(raw.apiKey),
		provider: stringConfig(raw.provider),
		api: parseSupportedApi(raw.api),
		modelApis: recordConfig(raw.modelApis, parseSupportedApi),
		providerMap: providerMapConfig(raw.providerMap),
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

function providerMapConfig(value: unknown): ProviderMap | undefined {
	const providers = recordConfig(value, parseBuiltinProvider);
	if (!providers) return undefined;

	return Object.fromEntries(
		Object.entries(providers).map(([developer, provider]) => [developer.toLowerCase(), provider]),
	);
}

function parseBuiltinProvider(value: unknown): BuiltinProvider | null | undefined {
	if (value === null) return null;
	const provider = stringConfig(value)?.toLowerCase();
	return provider && BUILTIN_PROVIDERS.has(provider) ? (provider as BuiltinProvider) : undefined;
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
	const path = join(getAgentDir(), "settings.json");
	if (!existsSync(path)) return {};

	try {
		return objectConfig(JSON.parse(readFileSync(path, "utf8"))) ?? {};
	} catch {
		// Ignore malformed settings here; Pi reports its own settings errors.
		return {};
	}
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
