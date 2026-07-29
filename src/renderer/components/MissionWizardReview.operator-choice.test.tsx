/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Squad, SquadAgent } from "../../shared/orch-types";
import type { AdapterInfo } from "../../shared/types";
import type { ProviderSettingsInfo } from "../../shared/provider-settings-types";
import { MissionWizardReview } from "./MissionWizardReview";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  (
    window as unknown as {
      nexus: {
        settings: {
          orchGet: () => Promise<{ squadCliPolicy: string }>;
        };
      };
    }
  ).nexus = {
    settings: {
      orchGet: async () => ({ squadCliPolicy: "operator-choice" }),
    },
  };
});

afterEach(() => {
  document.body.replaceChildren();
});

const orchestrator: SquadAgent = {
  id: "orch",
  agentName: "Maestro",
  category: "orchestrator",
  cli: "codex",
  model: "gpt-5.4",
  effort: "high",
  allowedTools: null,
};

const squad: Squad = {
  id: "squad-1",
  name: "Operação",
  createdAt: "1",
  builtin: false,
  orchestratorInstructions: "",
  agents: [orchestrator],
};

const codex: AdapterInfo = {
  id: "codex",
  kind: "cli-pty",
  label: "Codex",
  icon: "◇",
  models: { list: ["gpt-5.4"], default: "gpt-5.4" },
  installed: true,
  orchestratorCapable: true,
  orchestrationEvidence: "verified",
  autonomousWorkspaceWriteCapable: true,
  capabilities: {
    launchable: true,
    promptInjectable: true,
    statusObservable: true,
    resumable: true,
    autonomousReadOnly: true,
    governedWriter: true,
    verifiedMaestro: true,
  },
  installCommand: "",
  idleTimeoutMs: 800,
};

const kimi: AdapterInfo = {
  ...codex,
  id: "kimi",
  label: "Kimi",
  models: {
    list: ["kimi-code/kimi-for-coding"],
    default: "kimi-code/kimi-for-coding",
  },
  orchestrationEvidence: "unsupported",
  autonomousWorkspaceWriteCapable: false,
  capabilities: {
    launchable: true,
    promptInjectable: true,
    statusObservable: true,
    resumable: true,
    autonomousReadOnly: false,
    governedWriter: false,
    verifiedMaestro: false,
  },
};

const grok: AdapterInfo = {
  ...codex,
  id: "grok",
  label: "Grok",
  models: { list: ["grok-code"], default: "grok-code" },
  orchestrationEvidence: "unsupported",
  autonomousWorkspaceWriteCapable: false,
  capabilities: {
    launchable: true,
    promptInjectable: true,
    statusObservable: true,
    resumable: true,
    autonomousReadOnly: true,
    governedWriter: false,
    verifiedMaestro: false,
  },
};

function provider(
  adapter: AdapterInfo,
  overrides: Partial<ProviderSettingsInfo> = {},
): ProviderSettingsInfo {
  return {
    adapterId: adapter.id,
    label: adapter.label,
    icon: adapter.icon,
    kind: adapter.kind,
    enabled: true,
    installed: adapter.installed,
    canAutoInstall: false,
    binPath: "",
    detectedBin: adapter.id,
    defaultModel: adapter.models.default,
    models: adapter.models.list,
    authReadyModels: adapter.models.list,
    extraArgs: [],
    keyEnvVar: null,
    hasKey: false,
    keyMasked: null,
    authMethod: "oauth",
    secureStorageAvailable: true,
    authStrategy: "subscription",
    upstream: adapter.id,
    routable: false,
    upstreams: [],
    permissionMode: "",
    permissionModes: [],
    effort: "",
    efforts: [],
    verbose: false,
    supportsVerbose: false,
    customModels: [],
    ...overrides,
  };
}

function renderWorkerDropdown(input: {
  adapters: AdapterInfo[];
  providers: ProviderSettingsInfo[];
  worker?: SquadAgent;
}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const worker: SquadAgent =
    input.worker ??
    ({
      id: "worker",
      agentName: "Executor",
      category: "executor",
      cli: "codex",
      model: "gpt-5.4",
      effort: "high",
      allowedTools: ["Bash", "Read", "Edit"],
    } satisfies SquadAgent);
  act(() => {
    root.render(
      <MissionWizardReview
        squadCliPolicy="operator-choice"
        squad={{ ...squad, agents: [orchestrator, worker] }}
        roster={[orchestrator, worker]}
        adapters={input.adapters}
        providers={input.providers}
        highlightedAgentId={null}
        error={null}
        spawning={false}
        rosterSaved={false}
        rosterInvalidAgent={null}
        onSaveRoster={vi.fn()}
        onUpdateAgent={vi.fn()}
        onError={vi.fn()}
        onBack={vi.fn()}
        onCancel={vi.fn()}
        onLaunch={vi.fn()}
      />,
    );
  });
  return {
    host,
    root,
    options: () =>
      [
        ...host.querySelectorAll<HTMLOptionElement>(
          'select[aria-label="Provider de Executor"] option',
        ),
      ],
    cleanup() {
      act(() => root.unmount());
    },
  };
}

describe("MissionWizardReview operator-choice", () => {
  it("nunca mostra labels governed (escrita/leitura/manual) sob escolha livre", () => {
    const view = renderWorkerDropdown({
      adapters: [codex, kimi, grok],
      providers: [provider(codex), provider(kimi), provider(grok)],
    });
    const texts = view.options().map((option) => option.text);
    expect(texts).toContain("Codex · pronta · Seatbelt");
    expect(texts).toContain("Grok · pronta · Seatbelt");
    expect(texts).toContain("Kimi · pronta · Seatbelt");
    for (const text of texts) {
      expect(text).not.toMatch(
        /escrita confinada|leitura supervisionada|somente manual/,
      );
    }
    view.cleanup();
  });

  it("libera Kimi autenticada como executor com label Seatbelt", () => {
    const view = renderWorkerDropdown({
      adapters: [codex, kimi],
      providers: [provider(codex), provider(kimi)],
    });
    const kimiOption = view
      .options()
      .find((option) => option.text.includes("Kimi"));
    expect(kimiOption?.text).toBe("Kimi · pronta · Seatbelt");
    expect(kimiOption?.disabled).toBe(false);
    view.cleanup();
  });

  it("mostra login necessário — nunca 'somente manual' — quando deslogada", () => {
    const view = renderWorkerDropdown({
      adapters: [codex, kimi],
      providers: [
        provider(codex),
        provider(kimi, {
          authStrategy: "login-needed",
          authReadyModels: [],
        }),
      ],
    });
    const kimiOption = view
      .options()
      .find((option) => option.text.includes("Kimi"));
    expect(kimiOption?.text).toBe("Kimi · login necessário");
    expect(kimiOption?.disabled).toBe(true);
    expect(kimiOption?.text).not.toContain("somente manual");
    view.cleanup();
  });
});
