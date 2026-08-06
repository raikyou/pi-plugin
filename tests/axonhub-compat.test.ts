import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolvePiAiCompat } from "../extensions/axonhub/compat.ts";

function model<TApi extends Api>(
	api: TApi,
	overrides: Partial<Model<TApi>> = {},
): Model<TApi> {
	return {
		id: "test-model",
		name: "Test model",
		api,
		provider: "test",
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...overrides,
	};
}

test("materializes Pi 0.84 ZAI completion compatibility", () => {
	const compat = resolvePiAiCompat(
		model("openai-completions", {
			provider: "zai",
			baseUrl: "https://api.z.ai/api/paas/v4",
		}),
		"openai-completions",
	);

	assert.equal(compat?.maxTokensField, "max_tokens");
	assert.equal(compat?.supportsFinishReason, true);
	assert.equal(compat?.supportsThinkingTokenBudget, false);
	assert.equal(compat?.supportsOpenAIGrammarTools, false);
	assert.deepEqual(compat?.chatTemplateArgs, {});
});

test("preserves Pi 0.84 OpenAI Responses capabilities", () => {
	const compat = resolvePiAiCompat(
		model("openai-responses", {
			provider: "openai",
			compat: {
				supportsStrictMode: true,
				supportsOpenAIGrammarTools: true,
				supportsToolSearch: true,
				supportsExplicitPromptCacheMode: true,
			},
		}),
		"openai-responses",
	);

	assert.equal(compat?.supportsStrictMode, true);
	assert.equal(compat?.supportsOpenAIGrammarTools, true);
	assert.equal(compat?.supportsToolSearch, true);
	assert.equal(compat?.supportsExplicitPromptCacheMode, true);
});

test("preserves Anthropic strict and deferred tool capabilities", () => {
	const compat = resolvePiAiCompat(
		model("anthropic-messages", {
			provider: "anthropic",
			id: "claude-sonnet-5",
			compat: { supportsStrictTools: true, supportsToolReferences: true },
		}),
		"anthropic-messages",
	);

	assert.equal(compat?.supportsStrictTools, true);
	assert.equal(compat?.supportsToolReferences, true);
});
