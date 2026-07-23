import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canUseNexusMcp,
  cleanupAgyMcpConfig,
  cleanupOmpMcpConfig,
  codexMcpArgs,
  geminiMcpFragment,
  mergeGeminiSettings,
  mergeOmpMcpConfig,
  ompMcpFragment,
  prepareAgyMcpConfig,
  prepareOmpMcpConfig,
  purgeStaleAgyMcpConfigs,
  supportsMcpInjection,
} from "./cli-mcp-inject";

const tempDirs: string[] = [];
const preparedTokens: string[] = [];
const preparedOmpTokens: string[] = [];

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
  for (const token of preparedOmpTokens.splice(0)) cleanupOmpMcpConfig(token);
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("supportsMcpInjection", () => {
  const adapter = (
    nexusMcp:
      | 'none'
      | 'autoload'
      | 'codex'
      | 'agy'
      | 'opencode'
      | 'kimi'
      | 'grok'
      | 'omp',
    mcpAutoload = nexusMcp === 'autoload',
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
    expect(supportsMcpInjection(adapter("kimi"))).toBe("kimi");
    expect(supportsMcpInjection(adapter("grok"))).toBe("grok");
    expect(supportsMcpInjection(adapter("omp"))).toBe("omp");
    expect(supportsMcpInjection(adapter("autoload"))).toBe(null);
    expect(supportsMcpInjection(adapter("none"))).toBe(null);
    expect(canUseNexusMcp(adapter("autoload"))).toBe(true);
    expect(canUseNexusMcp(adapter("opencode"))).toBe(true);
    expect(canUseNexusMcp(adapter("omp"))).toBe(true);
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
    expect(args[5]).toBe(
      `mcp_servers.${serverName}.tool_timeout_sec=45`,
    );
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
});

describe("prepareOmpMcpConfig", () => {
  it("gera fragment http com bearer e merge preservando servers do usuário", () => {
    const frag = ompMcpFragment("http://127.0.0.1:4321/mcp", "tok-omp");
    expect(frag.mcpServers.nexus).toEqual({
      type: "http",
      url: "http://127.0.0.1:4321/mcp",
      headers: { Authorization: "Bearer tok-omp" },
    });
    const merged = mergeOmpMcpConfig(
      { mcpServers: { user: { type: "stdio", command: "x" } }, disabledServers: ["y"] },
      frag,
    ) as {
      mcpServers: Record<string, unknown>;
      disabledServers: string[];
    };
    expect(merged.mcpServers.user).toEqual({ type: "stdio", command: "x" });
    expect(merged.disabledServers).toEqual(["y"]);
    expect(merged.mcpServers.nexus).toEqual(frag.mcpServers.nexus);
  });

  it("preserva login/sessões por symlink e isola o bearer no mcp.json privado", () => {
    const root = makeTempDir();
    const realHome = path.join(root, "real-home");
    const artifacts = path.join(root, "omp-artifacts");
    const agentDb = path.join(realHome, ".omp", "agent", "agent.db");
    fs.mkdirSync(path.dirname(agentDb), { recursive: true });
    fs.writeFileSync(agentDb, "sqlite-login-blob");
    writeJson(path.join(realHome, ".omp", "agent", "mcp.json"), {
      mcpServers: { userServer: { type: "stdio", command: "keep" } },
    });
    fs.writeFileSync(path.join(realHome, ".gitconfig"), "[user]");
    const token = "token-omp-private";
    preparedOmpTokens.push(token);

    const result = prepareOmpMcpConfig("http://127.0.0.1:4321/mcp", token, {
      home: realHome,
      artifactRoot: artifacts,
    });

    // Login e home continuam visíveis através do overlay.
    expect(
      fs.realpathSync(path.join(result.homeDir, ".omp", "agent", "agent.db")),
    ).toBe(fs.realpathSync(agentDb));
    expect(fs.realpathSync(path.join(result.homeDir, ".gitconfig"))).toBe(
      fs.realpathSync(path.join(realHome, ".gitconfig")),
    );
    // sessions/blobs reais criados e linkados — escrita do pane persiste.
    for (const dir of ["sessions", "blobs"]) {
      expect(
        fs.realpathSync(path.join(result.homeDir, ".omp", "agent", dir)),
      ).toBe(fs.realpathSync(path.join(realHome, ".omp", "agent", dir)));
    }
    // mcp.json privado: 0600, com merge do server do usuário + nexus.
    expect(mode(result.configPath)).toBe(0o600);
    const config = JSON.parse(fs.readFileSync(result.configPath, "utf8")) as {
      mcpServers: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(config.mcpServers.userServer).toEqual({
      type: "stdio",
      command: "keep",
    });
    expect(config.mcpServers.nexus).toEqual({
      type: "http",
      url: "http://127.0.0.1:4321/mcp",
      headers: { Authorization: `Bearer ${token}` },
    });
    // O mcp.json REAL do usuário nunca ganha o bearer.
    const realRaw = fs.readFileSync(
      path.join(realHome, ".omp", "agent", "mcp.json"),
      "utf8",
    );
    expect(realRaw).not.toContain(token);
  });

  it("isola tokens concorrentes e sync-back devolve arquivos novos sem o mcp.json", () => {
    const root = makeTempDir();
    const realHome = path.join(root, "real-home");
    const artifacts = path.join(root, "omp-artifacts");
    fs.mkdirSync(realHome, { recursive: true });
    const first = "token-omp-first";
    const second = "token-omp-second";
    preparedOmpTokens.push(first, second);

    const a = prepareOmpMcpConfig("http://127.0.0.1:4001/mcp", first, {
      home: realHome,
      artifactRoot: artifacts,
    });
    const b = prepareOmpMcpConfig("http://127.0.0.1:4002/mcp", second, {
      home: realHome,
      artifactRoot: artifacts,
    });
    expect(a.homeDir).not.toBe(b.homeDir);
    expect(fs.readFileSync(a.configPath, "utf8")).not.toContain(second);
    expect(fs.readFileSync(b.configPath, "utf8")).not.toContain(first);

    // Primeiro uso: omp cria agent.db direto no overlay (não existia real).
    fs.writeFileSync(
      path.join(a.homeDir, ".omp", "agent", "agent.db"),
      "fresh-login",
    );
    cleanupOmpMcpConfig(first);
    expect(fs.existsSync(a.homeDir)).toBe(false);
    expect(fs.existsSync(b.homeDir)).toBe(true);
    // Sync-back preservou o login novo no perfil real, sem levar o mcp.json.
    expect(
      fs.readFileSync(path.join(realHome, ".omp", "agent", "agent.db"), "utf8"),
    ).toBe("fresh-login");
    const realMcp = path.join(realHome, ".omp", "agent", "mcp.json");
    if (fs.existsSync(realMcp)) {
      expect(fs.readFileSync(realMcp, "utf8")).not.toContain(first);
    }

    cleanupOmpMcpConfig(second);
    expect(fs.existsSync(b.homeDir)).toBe(false);
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
    expect(fs.readFileSync(path.join(unrelated, "marker.txt"), "utf8"))
      .toBe("unrelated-safe");
  });
});
