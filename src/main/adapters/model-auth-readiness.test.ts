import { describe, expect, it } from "vitest";
import {
  CREDENTIALLESS_OPENCODE_MODEL_IDS,
  OMP_MODEL_AUTH_ROUTES_17_0_4,
  authReadyModelsForProvider,
  isCredentiallessOpenCodeModel,
  isProviderAuthReadyForModel,
  ompModelAuthRoute,
  ompModelProviderFromRef,
} from "./model-auth-readiness";

describe("OpenCode credentialless model policy", () => {
  it("allows only exact, release-pinned first-party free ids", () => {
    for (const model of CREDENTIALLESS_OPENCODE_MODEL_IDS) {
      expect(isCredentiallessOpenCodeModel("opencode", model)).toBe(true);
    }

    for (const model of [
      "openrouter/openai/gpt-5",
      "opencode/future-paid-model",
      "opencode/unreviewed-free",
      "other/opencode/big-pickle",
      "OPENCODE/big-pickle",
      "",
    ]) {
      expect(isCredentiallessOpenCodeModel("opencode", model)).toBe(false);
    }
  });

  it("does not reinterpret a free OpenCode id as credentialless on another adapter", () => {
    expect(
      isCredentiallessOpenCodeModel("openrouter", "opencode/big-pickle"),
    ).toBe(false);
  });

  it("keeps authenticated catalogs intact but filters login-needed OpenCode exactly", () => {
    const models = [
      "opencode/big-pickle",
      "opencode/north-mini-code-free",
      "openrouter/openai/gpt-5",
      "opencode/unreviewed-free",
    ];
    expect(
      authReadyModelsForProvider(
        { adapterId: "opencode", authStrategy: "login-needed" },
        models,
      ),
    ).toEqual([
      "opencode/big-pickle",
      "opencode/north-mini-code-free",
    ]);
    expect(
      authReadyModelsForProvider(
        { adapterId: "opencode", authStrategy: "subscription" },
        models,
      ),
    ).toBe(models);
    expect(
      authReadyModelsForProvider(
        { adapterId: "codex", authStrategy: "login-needed" },
        models,
      ),
    ).toEqual([]);
  });

  it("never makes an external OpenCode provider route ready without auth", () => {
    expect(
      isProviderAuthReadyForModel(
        { adapterId: "opencode", authStrategy: "login-needed" },
        "opencode/big-pickle",
      ),
    ).toBe(true);
    expect(
      isProviderAuthReadyForModel(
        { adapterId: "opencode", authStrategy: "login-needed" },
        "openrouter/openai/gpt-5",
      ),
    ).toBe(false);
  });
});

describe("OMP provider/model auth policy", () => {
  it("parses only a complete provider/model reference", () => {
    expect(ompModelProviderFromRef("anthropic/claude-sonnet-4-6")).toBe(
      "anthropic",
    );
    expect(ompModelProviderFromRef("openrouter/openai/gpt-5")).toBe(
      "openrouter",
    );
    expect(ompModelProviderFromRef("anthropic")).toBeNull();
    expect(ompModelProviderFromRef("/model")).toBeNull();
    expect(ompModelProviderFromRef("provider/")).toBeNull();
    expect(ompModelProviderFromRef("")).toBeNull();
  });

  it("uses exact release-pinned broker aliases and rejects unknown providers", () => {
    expect(
      ompModelAuthRoute("openai-codex/gpt-5.5")?.brokerProviderIds,
    ).toEqual(["openai-codex", "openai-codex-device"]);
    expect(ompModelAuthRoute("xai/grok-4.5")?.brokerProviderIds).toEqual([]);
    expect(
      ompModelAuthRoute("xai-oauth/grok-4.5")?.brokerProviderIds,
    ).toEqual(["xai-oauth"]);
    expect(ompModelAuthRoute("zai/glm-5")?.launcherProviderId).toBe("glm");
    expect(ompModelAuthRoute("future/model")).toBeNull();
    expect(Object.keys(OMP_MODEL_AUTH_ROUTES_17_0_4)).not.toContain("future");
  });

  it("keeps OMP 17.0.4 selectors separate instead of authorizing neighboring providers", () => {
    expect(ompModelAuthRoute("google/gemini-3")?.brokerProviderIds).toEqual(
      [],
    );
    expect(
      ompModelAuthRoute("google-gemini-cli/gemini-3")?.brokerProviderIds,
    ).toEqual(["google-gemini-cli"]);
    expect(
      ompModelAuthRoute("google-antigravity/gemini-3")?.brokerProviderIds,
    ).toEqual(["google-antigravity"]);

    expect(ompModelAuthRoute("minimax/m2")?.brokerProviderIds).toEqual([]);
    expect(
      ompModelAuthRoute("minimax-code/m2")?.brokerProviderIds,
    ).toEqual(["minimax-code"]);
    expect(
      ompModelAuthRoute("minimax-code-cn/m2")?.brokerProviderIds,
    ).toEqual(["minimax-code-cn"]);

    expect(ompModelAuthRoute("qwen/model")).toBeNull();
    expect(
      ompModelAuthRoute("qwen-portal/model")?.brokerProviderIds,
    ).toEqual(["qwen-portal"]);
    expect(
      ompModelAuthRoute("alibaba-coding-plan/model")?.brokerProviderIds,
    ).toEqual(["alibaba-coding-plan"]);

    expect(ompModelAuthRoute("zai/glm-5")?.envNames).toEqual([
      "ZAI_API_KEY",
    ]);
    expect(
      ompModelAuthRoute("zhipu-coding-plan/glm-5")?.envNames,
    ).toEqual(["ZHIPU_API_KEY"]);
  });

  it("never promotes one ready OMP provider to the whole catalog", () => {
    const provider = {
      adapterId: "omp",
      authStrategy: "subscription",
      authReadyModels: ["anthropic/claude-sonnet-4-6"],
    };
    expect(
      isProviderAuthReadyForModel(
        provider,
        "anthropic/claude-sonnet-4-6",
      ),
    ).toBe(true);
    expect(
      isProviderAuthReadyForModel(provider, "openai-codex/gpt-5.5"),
    ).toBe(false);
    expect(
      authReadyModelsForProvider(provider, [
        "anthropic/claude-sonnet-4-6",
        "openai-codex/gpt-5.5",
      ]),
    ).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("fails closed for OMP snapshots without exact model readiness metadata", () => {
    expect(
      isProviderAuthReadyForModel(
        { adapterId: "omp", authStrategy: "subscription" },
        "anthropic/claude-sonnet-4-6",
      ),
    ).toBe(false);
    expect(
      authReadyModelsForProvider(
        { adapterId: "omp", authStrategy: "subscription" },
        ["anthropic/claude-sonnet-4-6"],
      ),
    ).toEqual([]);
  });
});
