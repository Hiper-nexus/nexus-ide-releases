import { describe, expect, it } from "vitest";
import {
  CREDENTIALLESS_OPENCODE_MODEL_IDS,
  authReadyModelsForProvider,
  isCredentiallessOpenCodeModel,
  isProviderAuthReadyForModel,
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
      "opencode/nemotron-3-ultra-free",
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
      "opencode/nemotron-3-ultra-free",
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
