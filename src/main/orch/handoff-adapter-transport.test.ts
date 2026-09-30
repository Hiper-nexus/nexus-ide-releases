import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { adapterSchema } from "../../shared/adapter-types";
import { BUILTIN_ADAPTERS } from "../../adapters/builtin";
import { canUseNexusMcp } from "./cli-mcp-inject";
import { handoffTransportForAdapter } from "./handoff-adapter-transport";

const USER_ADAPTER_DIR = path.join(
  os.homedir(),
  ".nexus",
  "plugins",
  "adapters",
);

const MCP_BUILTIN_IDS = new Set([
  "claude",
  "openclaude",
  "glm",
  "glm-flash",
  "longcat",
  "muse-claude",
  "codex",
  "opencode",
  "kimi",
  "grok",
  "mimo-code",
  "minimax-code",
  // F-696: Muse Code 1.4+ lê o MCP do Nexus pelo settings.json (ponte stdio).
  "muse",
  // F-697: AGY 1.2 lê a ponte stdio registrada por `agy mcp add` no perfil nativo.
  "agy",
  // F-698: Devin lê a ponte stdio registrada no escopo de usuário.
  "devin",
]);

const PTY_FALLBACK_BUILTIN_IDS = new Set(["aider"]);

function loadCliAdapters(
  rawList: readonly unknown[],
): Array<{ id: string; quirks: { mcpAutoload?: boolean; nexusMcp?: unknown } }> {
  const adapters: Array<{
    id: string;
    quirks: { mcpAutoload?: boolean; nexusMcp?: unknown };
  }> = [];
  for (const raw of rawList) {
    const parsed = adapterSchema.safeParse(raw);
    if (!parsed.success || parsed.data.kind !== "cli-pty") continue;
    adapters.push({
      id: parsed.data.id,
      quirks: parsed.data.quirks,
    });
  }
  return adapters;
}

function loadOverlayAdapters(): Array<{
  id: string;
  quirks: { mcpAutoload?: boolean; nexusMcp?: unknown };
}> {
  if (!fs.existsSync(USER_ADAPTER_DIR)) return [];
  const files = fs
    .readdirSync(USER_ADAPTER_DIR)
    .filter((name) => name.endsWith(".json"));
  const raw: unknown[] = [];
  for (const file of files) {
    try {
      raw.push(
        JSON.parse(fs.readFileSync(path.join(USER_ADAPTER_DIR, file), "utf8")),
      );
    } catch {
      // Overlay files the operator is still editing must not fail the matrix.
    }
  }
  return loadCliAdapters(raw);
}

describe("handoffTransportForAdapter catalog", () => {
  const builtins = loadCliAdapters(BUILTIN_ADAPTERS);
  const overlays = loadOverlayAdapters();

  it("inventories every bundled CLI (not an estimated ~18)", () => {
    expect(builtins.map((adapter) => adapter.id).sort()).toEqual(
      [...MCP_BUILTIN_IDS, ...PTY_FALLBACK_BUILTIN_IDS].sort(),
    );
    expect(builtins).toHaveLength(16);
  });

  it.each(builtins)(
    "builtin $id always has nx-mail + PTY scrape; MCP only when the CLI can load it",
    (adapter) => {
      const transport = handoffTransportForAdapter(adapter);
      expect(transport.nxMail).toBe(true);
      expect(transport.ptyScrape).toBe(true);
      expect(transport.mcpTool).toBe(MCP_BUILTIN_IDS.has(adapter.id));
      expect(transport.mcpTool).toBe(canUseNexusMcp(adapter));
      expect(PTY_FALLBACK_BUILTIN_IDS.has(adapter.id)).toBe(!transport.mcpTool);
    },
  );

  it("overlay CLIs without MCP still keep nx-mail + PTY scrape", () => {
    for (const adapter of overlays) {
      const transport = handoffTransportForAdapter(adapter);
      expect(transport.nxMail).toBe(true);
      expect(transport.ptyScrape).toBe(true);
      expect(transport.mcpTool).toBe(canUseNexusMcp(adapter));
    }
  });

  it("covers the adapters that failed in the field (agy/gemini/cursor/aider)", () => {
    const agy = builtins.find((adapter) => adapter.id === "agy");
    const aider = builtins.find((adapter) => adapter.id === "aider");
    expect(handoffTransportForAdapter(agy!).mcpTool).toBe(true);
    expect(handoffTransportForAdapter(aider!).mcpTool).toBe(false);

    const overlayById = new Map(overlays.map((adapter) => [adapter.id, adapter]));
    for (const id of ["gemini", "cursor-agent"]) {
      const overlay = overlayById.get(id);
      if (!overlay) continue;
      expect(handoffTransportForAdapter(overlay).mcpTool).toBe(false);
      expect(handoffTransportForAdapter(overlay).ptyScrape).toBe(true);
    }
  });

  it("Main idle/exit scrape is wired for every CLI, not only MCP adapters", () => {
    const mcpServer = fs.readFileSync(
      new URL("./mcp-server.ts", import.meta.url),
      "utf8",
    );
    const enforcement = fs.readFileSync(
      new URL("./worker-handoff-enforcement.ts", import.meta.url),
      "utf8",
    );
    expect(mcpServer).toContain("promoteObservedPtyHandoffs");
    expect(mcpServer).toContain('state === "idle"');
    expect(enforcement).toContain("promoteObservedPtyHandoffs");
    expect(enforcement).toContain("promoteObserved");
  });
});
