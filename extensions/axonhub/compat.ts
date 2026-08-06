import type {
	AnthropicMessagesCompat,
	Api,
	Model,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "@earendil-works/pi-ai";

type SupportedCompat = AnthropicMessagesCompat | OpenAICompletionsCompat | OpenAIResponsesCompat;

/**
 * Materialize Pi AI's effective compatibility settings before changing the
 * model provider and base URL to AxonHub. Pi AI normally resolves some of
 * these settings implicitly from the first-party provider/base URL, which are
 * no longer available after the model is registered under `axonhub`.
 */
export function resolvePiAiCompat(
	model: Model<Api> | undefined,
	targetApi: "openai-completions",
): OpenAICompletionsCompat | undefined;
export function resolvePiAiCompat(
	model: Model<Api> | undefined,
	targetApi: "openai-responses",
): OpenAIResponsesCompat | undefined;
export function resolvePiAiCompat(
	model: Model<Api> | undefined,
	targetApi: "anthropic-messages",
): AnthropicMessagesCompat | undefined;
export function resolvePiAiCompat(
	model: Model<Api> | undefined,
	targetApi: Api,
): SupportedCompat | undefined;
export function resolvePiAiCompat(model: Model<Api> | undefined, targetApi: Api): SupportedCompat | undefined {
	if (!model) return undefined;

	if (
		targetApi === "openai-responses" &&
		(model.api === "openai-responses" || model.api === "openai-codex-responses")
	) {
		return resolveOpenAIResponsesCompat(
			model as Model<"openai-responses" | "openai-codex-responses">,
		);
	}
	if (model.api !== targetApi) return undefined;

	switch (targetApi) {
		case "openai-completions":
			return resolveOpenAICompletionsCompat(model as Model<"openai-completions">);
		case "anthropic-messages":
			return resolveAnthropicMessagesCompat(model as Model<"anthropic-messages">);
		default:
			// google-generative-ai has no Model.compat settings in Pi AI.
			return undefined;
	}
}

function resolveOpenAIResponsesCompat(
	model: Model<"openai-responses" | "openai-codex-responses">,
): OpenAIResponsesCompat {
	const explicit = model.compat;
	return {
		...explicit,
		supportsDeveloperRole: explicit?.supportsDeveloperRole ?? true,
		sessionAffinityFormat:
			explicit?.sessionAffinityFormat ??
			(model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai"),
		supportsLongCacheRetention: explicit?.supportsLongCacheRetention ?? true,
		supportsStrictMode: explicit?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: explicit?.supportsOpenAIGrammarTools ?? false,
		supportsToolSearch: explicit?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: explicit?.supportsExplicitPromptCacheMode ?? false,
	};
}

function resolveAnthropicMessagesCompat(model: Model<"anthropic-messages">): AnthropicMessagesCompat {
	const explicit = model.compat;
	return {
		...explicit,
		supportsEagerToolInputStreaming: explicit?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: explicit?.supportsLongCacheRetention ?? true,
		sendSessionAffinityHeaders: explicit?.sendSessionAffinityHeaders ?? false,
		supportsCacheControlOnTools: explicit?.supportsCacheControlOnTools ?? true,
		supportsTemperature: explicit?.supportsTemperature ?? true,
		allowEmptySignature: explicit?.allowEmptySignature ?? false,
		supportsStrictTools: explicit?.supportsStrictTools ?? false,
		supportsToolReferences: explicit?.supportsToolReferences ?? defaultSupportsToolReferences(model),
	};
}

/** Mirrors Pi AI's first-party Anthropic default. */
function defaultSupportsToolReferences(model: Model<"anthropic-messages">): boolean {
	if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;

	const version = model.id.match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
	if (!version) return false;

	const major = Number(version[1]);
	const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
	return major > 4 || (major === 4 && minor >= 5);
}

function resolveOpenAICompletionsCompat(model: Model<"openai-completions">): OpenAICompletionsCompat {
	const detected = detectOpenAICompletionsCompat(model);
	const explicit = model.compat;
	if (!explicit) return detected;

	return withoutUndefined<OpenAICompletionsCompat>({
		...explicit,
		supportsStore: explicit.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole: explicit.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsReasoningEffort: explicit.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		supportsUsageInStreaming: explicit.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		supportsFinishReason: explicit.supportsFinishReason ?? detected.supportsFinishReason,
		maxTokensField: explicit.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: explicit.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			explicit.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText: explicit.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		requiresReasoningContentOnAssistantMessages:
			explicit.requiresReasoningContentOnAssistantMessages ??
			detected.requiresReasoningContentOnAssistantMessages,
		thinkingFormat: explicit.thinkingFormat ?? detected.thinkingFormat,
		// Routing is read directly from model.compat by Pi AI. Preserve only an
		// explicit value; materializing the implicit empty object would make Pi
		// send an otherwise absent provider/routing field.
		openRouterRouting: explicit.openRouterRouting,
		vercelGatewayRouting: explicit.vercelGatewayRouting,
		chatTemplateKwargs: explicit.chatTemplateKwargs ?? detected.chatTemplateKwargs,
		chatTemplateArgs: explicit.chatTemplateArgs ?? detected.chatTemplateArgs,
		zaiToolStream: explicit.zaiToolStream ?? detected.zaiToolStream,
		supportsThinkingTokenBudget:
			explicit.supportsThinkingTokenBudget ?? detected.supportsThinkingTokenBudget,
		supportsStrictMode: explicit.supportsStrictMode ?? detected.supportsStrictMode,
		supportsOpenAIGrammarTools:
			explicit.supportsOpenAIGrammarTools ?? detected.supportsOpenAIGrammarTools,
		cacheControlFormat: explicit.cacheControlFormat ?? detected.cacheControlFormat,
		sendSessionAffinityHeaders:
			explicit.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
		deferredToolsMode: explicit.deferredToolsMode ?? detected.deferredToolsMode,
		sessionAffinityFormat: explicit.sessionAffinityFormat ?? detected.sessionAffinityFormat,
		supportsLongCacheRetention:
			explicit.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
	});
}

/** Mirrors Pi AI's provider/base-URL compatibility detection. */
function detectOpenAICompletionsCompat(model: Model<"openai-completions">): OpenAICompletionsCompat {
	const provider = model.provider;
	const baseUrl = model.baseUrl;
	const isZai =
		provider === "zai" ||
		provider === "zai-coding-cn" ||
		baseUrl.includes("api.z.ai") ||
		baseUrl.includes("open.bigmodel.cn");
	const isTogether =
		provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
	const isMoonshot =
		provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	const isCloudflareAiGateway =
		provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
	const isNonStandard =
		isNvidia ||
		provider === "cerebras" ||
		baseUrl.includes("cerebras.ai") ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		isTogether ||
		baseUrl.includes("chutes.ai") ||
		baseUrl.includes("deepseek.com") ||
		isZai ||
		isMoonshot ||
		provider === "opencode" ||
		baseUrl.includes("opencode.ai") ||
		isCloudflareWorkersAI ||
		isCloudflareAiGateway ||
		isAntLing;
	const useMaxTokens =
		baseUrl.includes("chutes.ai") ||
		isMoonshot ||
		isCloudflareAiGateway ||
		isTogether ||
		isNvidia ||
		isAntLing ||
		isZai;
	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isDeepSeek = provider === "deepseek" || baseUrl.includes("deepseek.com");
	const isOpenRouterDeveloperRoleModel =
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));

	return withoutUndefined<OpenAICompletionsCompat>({
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
		supportsReasoningEffort:
			!isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
		supportsUsageInStreaming: true,
		supportsFinishReason: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: isDeepSeek,
		thinkingFormat: isDeepSeek
			? "deepseek"
			: isZai
				? "zai"
				: isTogether
					? "together"
					: isAntLing
						? "ant-ling"
						: isOpenRouter
							? "openrouter"
							: "openai",
		chatTemplateKwargs: {},
		chatTemplateArgs: {},
		zaiToolStream: false,
		supportsThinkingTokenBudget: false,
		supportsStrictMode: !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia,
		supportsOpenAIGrammarTools: false,
		cacheControlFormat:
			provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : undefined,
		sendSessionAffinityHeaders: false,
		deferredToolsMode: undefined,
		sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
		supportsLongCacheRetention:
			!(isTogether || isCloudflareWorkersAI || isCloudflareAiGateway || isNvidia || isAntLing),
	});
}

function withoutUndefined<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
