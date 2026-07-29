import fs from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = fs.readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const bootstrapSource = mainSource.slice(
  mainSource.indexOf("function bootstrap(): void"),
  mainSource.indexOf("function isAutomatedReleaseTest"),
);

describe("main bootstrap settings migration order", () => {
  it("migrates retired provider defaults before any orchestration runtime is configured", () => {
    const settings = bootstrapSource.indexOf("registerSettingsIpc();");
    const adapters = bootstrapSource.indexOf("initAdapterRegistry();");
    const providers = bootstrapSource.indexOf(
      "initializeProviderConfigStore();",
    );
    const migration = bootstrapSource.indexOf(
      "migrateRetiredOrchestratorSettings({",
    );
    const runtime = bootstrapSource.indexOf(
      "projectRuntimeManager = new ProjectRuntimeManager",
    );
    const scheduler = bootstrapSource.indexOf("configureMissionScheduler(");
    const orchestrationIpc = bootstrapSource.indexOf("registerOrchIpc();");

    expect([
      settings,
      adapters,
      providers,
      migration,
      runtime,
      scheduler,
      orchestrationIpc,
    ]).not.toContain(-1);
    expect(settings).toBeLessThan(adapters);
    expect(adapters).toBeLessThan(providers);
    expect(providers).toBeLessThan(migration);
    expect(migration).toBeLessThan(runtime);
    expect(migration).toBeLessThan(scheduler);
    expect(migration).toBeLessThan(orchestrationIpc);
  });

  it("keeps an atomic migration write failure non-fatal to desktop bootstrap", () => {
    expect(bootstrapSource).toMatch(
      /try\s*\{\s*migrateRetiredOrchestratorSettings\(\{[\s\S]*?\}\);\s*\}\s*catch\s*\(error\)\s*\{[\s\S]*?console\.warn/um,
    );
  });
});
