import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canUseNexusMcp,
  cleanupAgyMcpConfig,
  codexMcpArgs,
  geminiMcpFragment,
  mergeGeminiSettings,
  prepareAgyMcpConfig,
  purgeStaleAgyMcpConfigs,
  supportsMcpInjection,
} from "./cli-mcp-inject";
import {
  claudeFamilyHubMcpServers,
  codexHubMcpArgs,
  grokHubMcpServers,
  loadMcpHubServersForSpawn,
  MCP_HUB_SPAWN_MAX_SERVERS,
  openCodeHubMcpServers,
} from "../mcp-hub/mcp-hub-spawn";

const tempDirs: string[] = [];
const preparedTokens: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-agy-mcp-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

afterEach(() => {
  for (const token of preparedTokens.splice(0)) cleanupAgyMcpConfig(token);
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("supportsMcpInjection", () => {
  const adapter = (
    nexusMcp:
      | "none"
      | "autoload"
      | "codex"
      | "agy"
      | "opencode"
      | "mimo-code"
      | "kimi"
      | "grok",
    mcpAutoload = nexusMcp === "autoload",
  ) => ({
    quirks: {
      altScreen: false,
      requiresNoAutoUpdate: false,
      mcpAutoload,
      nexusMcp,
    },
  });

  it("deriva capability da metadata declarativa, sem lista paralela por id", () => {
    expect(supportsMcpInjection(adapter("codex"))).toBe("codex");
    expect(supportsMcpInjection(adapter("agy"))).toBe("agy");
    expect(supportsMcpInjection(adapter("opencode"))).toBe("opencode");
    expect(supportsMcpInjection(adapter("mimo-code"))).toBe("mimo-code");
    expect(canUseNexusMcp(adapter("mimo-code"))).toBe(true);
    expect(supportsMcpInjection(adapter("kimi"))).toBe("kimi");
    expect(supportsMcpInjection(adapter("grok"))).toBe("grok");
    expect(supportsMcpInjection(adapter("autoload"))).toBe(null);
    expect(supportsMcpInjection(adapter("none"))).toBe(null);
    expect(canUseNexusMcp(adapter("autoload"))).toBe(true);
    expect(canUseNexusMcp(adapter("opencode"))).toBe(true);
    expect(canUseNexusMcp(adapter("agy"))).toBe(true);
    expect(canUseNexusMcp(adapter("none"))).toBe(false);
  });

  it("preserva mcpAutoload legado e falha fechado no autoload inconsistente", () => {
    expect(canUseNexusMcp(adapter("none", true))).toBe(true);
    expect(canUseNexusMcp(adapter("autoload", false))).toBe(false);
  });
});

describe("codexMcpArgs", () => {
  it("mantém o bearer apenas na env e usa um nome efêmero não sobrescrevível", () => {
    const token = "codex-secret-token";
    const args = codexMcpArgs("http://127.0.0.1:5123/mcp", token);
    const serialized = JSON.stringify(args);

    expect(args).toHaveLength(6);
    expect(args[0]).toBe("-c");
    expect(args[2]).toBe("-c");
    expect(args[4]).toBe("-c");
    const serverName = args[1]?.match(
      /^mcp_servers\.(nexus_[0-9a-f]{12})\.url=/,
    )?.[1];
    expect(serverName).toMatch(/^nexus_[0-9a-f]{12}$/);
    expect(args[1]).toBe(
      `mcp_servers.${serverName}.url="http://127.0.0.1:5123/mcp"`,
    );
    expect(args[3]).toBe(
      `mcp_servers.${serverName}.bearer_token_env_var="NEXUS_MCP_TOKEN"`,
    );
    expect(args[5]).toBe(`mcp_servers.${serverName}.tool_timeout_sec=120`);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toContain("http_headers");
    expect(serialized).not.toContain("Authorization");
  });

  it("gera namespaces diferentes entre sessões", () => {
    const first = codexMcpArgs("http://127.0.0.1:5123/mcp");
    const second = codexMcpArgs("http://127.0.0.1:5123/mcp");
    const name = (args: string[]) =>
      args[1]?.match(/^mcp_servers\.(nexus_[0-9a-f]{12})\.url=/)?.[1];

    expect(name(first)).toMatch(/^nexus_[0-9a-f]{12}$/);
    expect(name(second)).toMatch(/^nexus_[0-9a-f]{12}$/);
    expect(name(first)).not.toBe(name(second));
  });

  it("pré-aprova somente o namespace efêmero explicitamente autorizado", () => {
    const args = codexMcpArgs(
      "http://127.0.0.1:5123/mcp",
      undefined,
      { approveBoundTools: true },
    );
    const serverName = args[1]?.match(
      /^mcp_servers\.(nexus_[0-9a-f]{12})\.url=/,
    )?.[1];

    expect(args).toContain(
      `mcp_servers.${serverName}.default_tools_approval_mode="approve"`,
    );
    expect(args.join(" ")).not.toContain(
      "apps._default.default_tools_approval_mode",
    );
    expect(args.join(" ")).not.toContain("approval_policy=");
  });
});

describe("geminiMcpFragment", () => {
  it("usa httpUrl + header Authorization + trust", () => {
    const frag = geminiMcpFragment("http://127.0.0.1:5123/mcp", "tok-abc");
    const nexus = frag.mcpServers.nexus;
    expect(nexus.httpUrl).toBe("http://127.0.0.1:5123/mcp");
    expect(nexus.headers.Authorization).toBe("Bearer tok-abc");
    expect(nexus.trust).toBe(true);
  });
});

describe("mergeGeminiSettings", () => {
  it("preserva chaves existentes e injeta o servidor nexus", () => {
    const existing = {
      theme: "dark",
      mcpServers: { outra: { httpUrl: "http://x" } },
    };
    const merged = mergeGeminiSettings(
      existing,
      geminiMcpFragment("http://u/mcp", "t"),
    );
    expect(merged.theme).toBe("dark");
    expect((merged.mcpServers as Record<string, unknown>).outra).toBeTruthy();
    expect((merged.mcpServers as Record<string, unknown>).nexus).toBeTruthy();
  });

  it("sobrescreve um nexus antigo (token rotaciona)", () => {
    const existing = {
      mcpServers: {
        nexus: {
          httpUrl: "http://velho",
          headers: { Authorization: "Bearer velho" },
        },
      },
    };
    const merged = mergeGeminiSettings(
      existing,
      geminiMcpFragment("http://novo/mcp", "novo"),
    );
    const nexus = (merged.mcpServers as Record<string, { httpUrl: string }>)
      .nexus;
    expect(nexus.httpUrl).toBe("http://novo/mcp");
  });

  it("base não-objeto vira objeto limpo", () => {
    const merged = mergeGeminiSettings(
      null,
      geminiMcpFragment("http://u/mcp", "t"),
    );
    expect((merged.mcpServers as Record<string, unknown>).nexus).toBeTruthy();
  });
});

describe("prepareAgyMcpConfig", () => {
  it("cria HOME privado 0700, configs 0600 e nunca altera workspace ou HOME real", () => {
    const root = makeTempDir();
    const realHome = path.join(root, "real-home");
    const artifacts = path.join(root, "artifacts");
    const workspace = path.join(root, "workspace");
    const modernConfig = path.join(
      realHome,
      ".gemini",
      "config",
      "mcp_config.json",
    );
    const cliConfig = path.join(
      realHome,
      ".gemini",
      "antigravity-cli",
      "mcp_config.json",
    );
    const gitConfig = path.join(realHome, ".gitconfig");
    fs.mkdirSync(realHome, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(gitConfig, "[user]\nname = Nexus Test\n");
    writeJson(modernConfig, {
      mcpServers: { userModern: { command: "modern" } },
    });
    writeJson(cliConfig, { mcpServers: { userCli: { command: "cli" } } });
    const originalModern = fs.readFileSync(modernConfig, "utf8");
    const originalCli = fs.readFileSync(cliConfig, "utf8");
    const token = "token-private-one";
    preparedTokens.push(token);

    const result = prepareAgyMcpConfig("http://127.0.0.1:4321/mcp", token, {
      home: realHome,
      artifactRoot: artifacts,
    });

    expect(result.homeDir).not.toBe(realHome);
    expect(result.homeDir).not.toContain(token);
    expect(mode(result.homeDir)).toBe(0o700);
    expect(fs.realpathSync(path.join(result.homeDir, ".gitconfig"))).toBe(
      fs.realpathSync(gitConfig),
    );
    expect(
      fs.existsSync(path.join(workspace, ".gemini", "settings.json")),
    ).toBe(false);
    expect(fs.readFileSync(modernConfig, "utf8")).toBe(originalModern);
    expect(fs.readFileSync(cliConfig, "utf8")).toBe(originalCli);

    for (const configPath of result.configPaths) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        mcpServers: Record<
          string,
          { serverUrl?: string; headers?: Record<string, string> }
        >;
      };
      expect(mode(configPath)).toBe(0o600);
      expect(mode(path.dirname(configPath))).toBe(0o700);
      expect(config.mcpServers.nexus).toEqual({
        serverUrl: "http://127.0.0.1:4321/mcp",
        headers: { Authorization: "Bearer token-private-one" },
      });
      expect(
        fs
          .readdirSync(path.dirname(configPath))
          .some((name) => name.endsWith(".tmp")),
      ).toBe(false);
    }
    const generatedModern = JSON.parse(
      fs.readFileSync(result.configPaths[0], "utf8"),
    ) as {
      mcpServers: Record<string, unknown>;
    };
    const generatedCli = JSON.parse(
      fs.readFileSync(result.configPaths[1], "utf8"),
    ) as {
      mcpServers: Record<string, unknown>;
    };
    expect(generatedModern.mcpServers.userModern).toEqual({
      command: "modern",
    });
    expect(generatedCli.mcpServers.userCli).toEqual({ command: "cli" });
  });

  it("isola tokens concorrentes e limpa somente o HOME da sessão encerrada", () => {
    const root = makeTempDir();
    const realHome = path.join(root, "real-home");
    const artifacts = path.join(root, "artifacts");
    const marker = path.join(realHome, "keep.txt");
    fs.mkdirSync(realHome, { recursive: true });
    fs.writeFileSync(marker, "preservar");
    const firstToken = "token-concurrent-first";
    const secondToken = "token-concurrent-second";
    preparedTokens.push(firstToken, secondToken);

    const first = prepareAgyMcpConfig("http://127.0.0.1:4001/mcp", firstToken, {
      home: realHome,
      artifactRoot: artifacts,
    });
    const second = prepareAgyMcpConfig(
      "http://127.0.0.1:4002/mcp",
      secondToken,
      {
        home: realHome,
        artifactRoot: artifacts,
      },
    );
    const firstRaw = fs.readFileSync(first.configPaths[0], "utf8");
    const secondRaw = fs.readFileSync(second.configPaths[0], "utf8");

    expect(first.homeDir).not.toBe(second.homeDir);
    expect(firstRaw).toContain("Bearer token-concurrent-first");
    expect(firstRaw).not.toContain(secondToken);
    expect(secondRaw).toContain("Bearer token-concurrent-second");
    expect(secondRaw).not.toContain(firstToken);

    cleanupAgyMcpConfig(firstToken);
    expect(fs.existsSync(first.homeDir)).toBe(false);
    expect(fs.existsSync(second.homeDir)).toBe(true);
    expect(fs.readFileSync(marker, "utf8")).toBe("preservar");

    cleanupAgyMcpConfig(firstToken);
    cleanupAgyMcpConfig(secondToken);
    expect(fs.existsSync(second.homeDir)).toBe(false);
    expect(fs.readFileSync(marker, "utf8")).toBe("preservar");
  });

  it("remove MCPs/plugins/skills externos do overlay governado", () => {
    const root = makeTempDir();
    const realHome = path.join(root, "real-home");
    const artifacts = path.join(root, "artifacts");
    writeJson(path.join(realHome, ".gemini", "config", "mcp_config.json"), {
      mcpServers: { external: { command: "external-mcp" } },
    });
    writeJson(
      path.join(realHome, ".gemini", "antigravity-cli", "mcp_config.json"),
      { mcpServers: { external: { command: "external-mcp" } } },
    );
    writeJson(
      path.join(
        realHome,
        ".gemini",
        "config",
        "plugins",
        "external",
        "plugin.json",
      ),
      { name: "external-plugin" },
    );
    fs.mkdirSync(
      path.join(realHome, ".gemini", "config", "skills", "allowed"),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(realHome, ".gemini", "config", "skills", "allowed", "SKILL.md"),
      "# allowed",
    );
    fs.mkdirSync(
      path.join(realHome, ".gemini", "config", "skills", "blocked"),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(realHome, ".gemini", "config", "skills", "blocked", "SKILL.md"),
      "# blocked",
    );
    const token = "agy-governed-token";
    preparedTokens.push(token);

    const result = prepareAgyMcpConfig("http://127.0.0.1:4321/mcp", token, {
      home: realHome,
      artifactRoot: artifacts,
      governed: true,
      allowedSkills: ["allowed"],
    });

    for (const configPath of result.configPaths) {
      const raw = fs.readFileSync(configPath, "utf8");
      expect(raw).not.toContain("external-mcp");
      expect(Object.keys(JSON.parse(raw).mcpServers)).toEqual(["nexus"]);
    }
    expect(
      fs.existsSync(path.join(result.geminiHomeDir, "config", "plugins")),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          result.geminiHomeDir,
          "config",
          "skills",
          "allowed",
          "SKILL.md",
        ),
      ),
    ).toBe(true);
    // F-1157: sem filtro de skill — o overlay recebe também a que não foi
    // concedida (MCPs e plugins externos continuam fora, logo acima).
    expect(
      fs.existsSync(
        path.join(result.geminiHomeDir, "config", "skills", "blocked", "SKILL.md"),
      ),
    ).toBe(true);
  });
});

describe("loadMcpHubServersForSpawn", () => {
  function workspaceWithHub(hub: unknown): string {
    const workspace = path.join(makeTempDir(), "workspace");
    fs.mkdirSync(path.join(workspace, ".nexus"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".nexus", "mcp-hub.json"),
      typeof hub === "string" ? hub : JSON.stringify(hub, null, 2),
    );
    return workspace;
  }

  const stdioServer = {
    id: "context7",
    name: "Context7",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    env: { CONTEXT7_MODE: "docs" },
  };
  const httpServer = {
    id: "linear",
    name: "Linear",
    transport: "streamable-http",
    url: "https://mcp.linear.app/mcp",
    headers: { Authorization: "Bearer hub-linear-secret" },
  };

  it("materializa stdio e http do hub para Claude e Codex, ao lado do nexus", () => {
    const workspace = workspaceWithHub({
      schemaVersion: 1,
      servers: [httpServer, stdioServer],
    });

    const servers = loadMcpHubServersForSpawn(workspace);
    expect(servers.map((s) => s.key)).toEqual(["context7", "linear"]);

    const claude = claudeFamilyHubMcpServers(servers);
    expect(claude.context7).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: { CONTEXT7_MODE: "docs" },
    });
    expect(claude.linear).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer hub-linear-secret" },
    });

    const codex = codexHubMcpArgs(servers).join(" ");
    expect(codex).toContain('mcp_servers.context7.command="npx"');
    expect(codex).toContain(
      'mcp_servers.context7.args=["-y","@upstash/context7-mcp"]',
    );
    expect(codex).toContain('mcp_servers.context7.env.CONTEXT7_MODE="docs"');
    expect(codex).toContain(
      'mcp_servers.linear.url="https://mcp.linear.app/mcp"',
    );

    const opencode = openCodeHubMcpServers(servers);
    expect(opencode.context7).toEqual({
      type: "local",
      command: ["npx", "-y", "@upstash/context7-mcp"],
      enabled: true,
      environment: { CONTEXT7_MODE: "docs" },
    });
    expect(opencode.linear).toMatchObject({
      type: "remote",
      url: "https://mcp.linear.app/mcp",
      enabled: true,
    });

    const grok = grokHubMcpServers(servers);
    expect(grok.context7).toMatchObject({ command: "npx", enabled: true });
    expect(grok.linear).toMatchObject({
      url: "https://mcp.linear.app/mcp",
      http_headers: { Authorization: "Bearer hub-linear-secret" },
    });
  });

  it("hub ausente, vazio ou corrompido degrada para lista vazia", () => {
    const empty = path.join(makeTempDir(), "no-nexus-dir");
    fs.mkdirSync(empty, { recursive: true });

    expect(loadMcpHubServersForSpawn(empty)).toEqual([]);
    expect(loadMcpHubServersForSpawn(undefined)).toEqual([]);
    expect(loadMcpHubServersForSpawn("relative/path")).toEqual([]);
    expect(
      loadMcpHubServersForSpawn(
        workspaceWithHub({ schemaVersion: 1, servers: [] }),
      ),
    ).toEqual([]);
    expect(
      loadMcpHubServersForSpawn(workspaceWithHub("{ not json at all")),
    ).toEqual([]);
    expect(
      loadMcpHubServersForSpawn(
        workspaceWithHub({ schemaVersion: 9, servers: "nope" }),
      ),
    ).toEqual([]);
    // Um único servidor fora do contrato invalida o arquivo inteiro: nunca
    // inventamos uma leitura parcial de um hub que o schema recusa.
    expect(
      loadMcpHubServersForSpawn(
        workspaceWithHub({
          schemaVersion: 1,
          servers: [{ id: "x", name: "x", transport: "carrier-pigeon" }],
        }),
      ),
    ).toEqual([]);
  });

  it("pula entrada sem command e sem url, e o namespace reservado do nexus", () => {
    const workspace = workspaceWithHub({
      schemaVersion: 1,
      servers: [
        { id: "ghost", name: "Ghost", transport: "stdio" },
        { id: "blank-url", name: "Blank", transport: "streamable-http", url: "  " },
        { id: "nexus", name: "Impostor", transport: "stdio", command: "evil" },
        { id: "nexus_deadbeef", name: "Impostor 2", transport: "stdio", command: "evil" },
        stdioServer,
      ],
    });

    expect(loadMcpHubServersForSpawn(workspace).map((s) => s.key)).toEqual([
      "context7",
    ]);
  });

  it("nunca escreve ref de cofre, placeholder mascarado ou segredo em argv", () => {
    const workspace = workspaceWithHub({
      schemaVersion: 1,
      servers: [
        {
          id: "sealed",
          name: "Sealed",
          transport: "streamable-http",
          url: "https://sealed.example/mcp",
          headers: {
            Authorization: "__nexus_vault__:mcphub:abc:sealed:headers:Authorization",
            "X-Trace": "on",
          },
        },
        {
          id: "masked",
          name: "Masked",
          transport: "stdio",
          command: "run-it",
          env: { API_KEY: "[REDACTED]", MODE: "fast" },
        },
        {
          id: "plain",
          name: "Plain",
          transport: "stdio",
          command: "run-it",
          env: { API_TOKEN: "plain-secret-value", MODE: "fast" },
        },
      ],
    });

    const servers = loadMcpHubServersForSpawn(workspace);
    const claude = JSON.stringify(claudeFamilyHubMcpServers(servers));
    expect(claude).not.toContain("__nexus_vault__");
    expect(claude).not.toContain("[REDACTED]");
    expect(claude).toContain("plain-secret-value");

    // argv é legível por qualquer processo (`ps`): campo secreto fica de fora.
    const codex = codexHubMcpArgs(servers).join(" ");
    expect(codex).not.toContain("plain-secret-value");
    expect(codex).not.toContain("__nexus_vault__");
    expect(codex).toContain('mcp_servers.plain.env.MODE="fast"');
    expect(codex).toContain('mcp_servers.sealed.http_headers.X-Trace="on"');
  });

  it("respeita o teto de servidores do hub", () => {
    const serversOfSize = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `srv${String(index).padStart(3, "0")}`,
        name: `Server ${index}`,
        transport: "stdio",
        command: "run-it",
      }));

    expect(
      loadMcpHubServersForSpawn(
        workspaceWithHub({
          schemaVersion: 1,
          servers: serversOfSize(MCP_HUB_SPAWN_MAX_SERVERS),
        }),
      ),
    ).toHaveLength(MCP_HUB_SPAWN_MAX_SERVERS);
    // Acima do teto o próprio schema recusa o arquivo: degrada para vazio.
    expect(
      loadMcpHubServersForSpawn(
        workspaceWithHub({
          schemaVersion: 1,
          servers: serversOfSize(MCP_HUB_SPAWN_MAX_SERVERS + 1),
        }),
      ),
    ).toEqual([]);
  });

  it("é determinístico: ordem estável e primeira entrada vence na colisão", () => {
    const workspace = workspaceWithHub({
      schemaVersion: 1,
      servers: [
        { id: "zeta", name: "Z", transport: "stdio", command: "z" },
        { id: "io.github/tool", name: "A", transport: "stdio", command: "first" },
        { id: "io_github_tool", name: "B", transport: "stdio", command: "second" },
        { id: "alpha", name: "Al", transport: "stdio", command: "a" },
      ],
    });

    const servers = loadMcpHubServersForSpawn(workspace);
    expect(servers.map((s) => s.key)).toEqual([
      "alpha",
      "io_github_tool",
      "zeta",
    ]);
    expect(servers.find((s) => s.key === "io_github_tool")?.command).toBe(
      "first",
    );
    expect(codexHubMcpArgs(servers)).toEqual(
      codexHubMcpArgs(loadMcpHubServersForSpawn(workspace)),
    );
  });
});

describe("purgeStaleAgyMcpConfigs", () => {
  it("remove apenas sessões Nexus e nunca segue symlink para fora da raiz", () => {
    const root = makeTempDir();
    const artifacts = path.join(root, "agy-artifacts");
    const outside = path.join(root, "outside");
    const outsideMarker = path.join(outside, "keep.txt");
    const stale = path.join(artifacts, "d".repeat(32));
    const staleSymlink = path.join(artifacts, "e".repeat(32));
    const unrelated = path.join(artifacts, "keep-me");
    fs.mkdirSync(path.dirname(outsideMarker), { recursive: true });
    fs.writeFileSync(outsideMarker, "outside-safe");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, "secret.json"), "{}");
    fs.mkdirSync(unrelated, { recursive: true });
    fs.writeFileSync(path.join(unrelated, "marker.txt"), "unrelated-safe");
    fs.symlinkSync(outside, staleSymlink);

    const result = purgeStaleAgyMcpConfigs({ artifactRoot: artifacts });

    expect(result.removed).toBe(2);
    expect(result.failed).toBe(0);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(staleSymlink)).toBe(false);
    expect(fs.readFileSync(outsideMarker, "utf8")).toBe("outside-safe");
    expect(fs.readFileSync(path.join(unrelated, "marker.txt"), "utf8")).toBe(
      "unrelated-safe",
    );
  });
});

describe('canUseNexusMcp — lei física do binário (bug E 2026-08-17)', () => {
  it('adapter de usuário com bin claude usa o MCP mesmo com quirks none', () => {
    expect(
      canUseNexusMcp({
        bin: 'claude',
        quirks: { mcpAutoload: false, nexusMcp: 'none' },
      } as never),
    ).toBe(true);
  });

  it('quirks none SEM bin claude continua sem MCP (aider etc.)', () => {
    expect(
      canUseNexusMcp({
        bin: 'aider',
        quirks: { mcpAutoload: false, nexusMcp: 'none' },
      } as never),
    ).toBe(false);
  });
});
