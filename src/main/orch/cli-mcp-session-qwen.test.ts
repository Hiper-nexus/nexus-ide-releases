import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupCliMcpSession } from './cli-mcp-session-artifacts';
import { prepareQwenMcpSession } from './cli-mcp-session-qwen';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-qwen-overlay-'));
  tempDirs.push(dir);
  return dir;
}

/** O MESMO arquivo, não uma cópia: symlink no POSIX, hardlink no Windows. */
function expectSameFile(linked: string, source: string): void {
  if (process.platform !== 'win32') expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
  const a = fs.statSync(linked);
  const b = fs.statSync(source);
  expect([a.dev, a.ino]).toEqual([b.dev, b.ino]);
}

const URL = 'http://127.0.0.1:43210/mcp';
const TOKEN = 'fixture-session-token';

interface Fixture {
  home: string;
  providerHome: string;
  userDataPath: string;
  artifactRoot: string;
  workspace: string;
}

function fixture(): Fixture {
  const root = tempDir();
  const home = path.join(root, 'home');
  const providerHome = path.join(home, '.qwen');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(providerHome, { recursive: true });
  fs.writeFileSync(
    path.join(providerHome, 'settings.json'),
    JSON.stringify({
      model: { name: 'qwen3.8-max' },
      env: { BAILIAN_TOKEN_PLAN_API_KEY: 'fixture-settings-secret' },
      mcpServers: { blender: { command: 'blender-mcp' } },
    }),
  );
  fs.mkdirSync(path.join(providerHome, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(providerHome, 'sessions', 'native.jsonl'), '{}\n');
  return {
    home,
    providerHome,
    userDataPath: path.join(root, 'userData'),
    artifactRoot: path.join(root, 'artifacts'),
    workspace,
  };
}

function readMcpConfig(artifactDir: string): {
  mcpServers: Record<string, Record<string, unknown>>;
} {
  return JSON.parse(
    fs.readFileSync(path.join(artifactDir, 'mcp-config.json'), 'utf8'),
  ) as { mcpServers: Record<string, Record<string, unknown>> };
}

describe('prepareQwenMcpSession (F-238)', () => {
  it('settings.json é ligado (nunca copiado) e conversas ficam no provider-state', () => {
    const fx = fixture();
    const result = prepareQwenMcpSession(URL, TOKEN, {
      home: fx.home,
      providerHome: fx.providerHome,
      userDataPath: fx.userDataPath,
      artifactRoot: fx.artifactRoot,
      checkoutId: 'checkout-1',
      cwd: fx.workspace,
      workspaceRoot: fx.workspace,
    });
    try {
      const artifactDir = result.artifactDir!;
      expect(result.env.QWEN_HOME).toBe(artifactDir);
      expect(result.env.NEXUS_MCP_URL).toBe(URL);
      expect(result.env.NEXUS_MCP_TOKEN).toBe(TOKEN);

      // Credencial: link para o perfil real (symlink no POSIX, hardlink no
      // Windows) — o segredo não é copiado.
      const linked = path.join(artifactDir, 'settings.json');
      expectSameFile(linked, path.join(fx.providerHome, 'settings.json'));
      expect(fs.readFileSync(linked, 'utf8')).toContain(
        'fixture-settings-secret',
      );

      // Sessões: fora do perfil nativo, dentro do provider-state do checkout.
      const sessions = path.join(artifactDir, 'sessions');
      expect(fs.lstatSync(sessions).isSymbolicLink()).toBe(true);
      const realSessions = fs.realpathSync(sessions);
      const realUserData = fs.existsSync(fx.userDataPath)
        ? fs.realpathSync(fx.userDataPath)
        : path.resolve(fx.userDataPath);
      expect(realSessions.startsWith(realUserData)).toBe(true);
      expect(realSessions).toContain(path.join('provider-state', 'qwen', 'checkout-1'));
      // A conversa nativa NÃO migra para o overlay (import proibido).
      expect(fs.existsSync(path.join(realSessions, 'native.jsonl'))).toBe(false);

      // MCP: nexus (ponte stdio) + ambiente do operador preservado em pane
      // não-governado; token nunca vai para o disco.
      const config = readMcpConfig(artifactDir);
      expect(config.mcpServers[result.serverName]).toMatchObject({
        type: 'stdio',
      });
      expect(config.mcpServers.blender).toEqual({ command: 'blender-mcp' });
      const raw = fs.readFileSync(path.join(artifactDir, 'mcp-config.json'), 'utf8');
      expect(raw).not.toContain(TOKEN);
      expect(raw).not.toContain('fixture-settings-secret');

      expect(result.extraArgs).toContain('--mcp-config');
      expect(result.extraArgs).toContain('--allowed-mcp-server-names');
      const allowed = result.extraArgs.slice(
        result.extraArgs.indexOf('--allowed-mcp-server-names') + 1,
      );
      expect(allowed).toContain(result.serverName);
      expect(allowed).toContain('blender');
    } finally {
      cleanupCliMcpSession(TOKEN);
    }
  });

  it('worker governado recebe só o servidor Nexus — MCP ambiente (blender) não entra', () => {
    const fx = fixture();
    const result = prepareQwenMcpSession(URL, TOKEN, {
      home: fx.home,
      providerHome: fx.providerHome,
      userDataPath: fx.userDataPath,
      artifactRoot: fx.artifactRoot,
      checkoutId: 'checkout-2',
      cwd: fx.workspace,
      workspaceRoot: fx.workspace,
      governed: true,
      allowedSkills: [],
      allowedTools: [],
    });
    try {
      const artifactDir = result.artifactDir!;
      const config = readMcpConfig(artifactDir);
      expect(Object.keys(config.mcpServers)).toEqual([result.serverName]);
      const allowed = result.extraArgs.slice(
        result.extraArgs.indexOf('--allowed-mcp-server-names') + 1,
      );
      expect(allowed).toEqual([result.serverName]);
      expect(allowed).not.toContain('blender');
      // Credencial continua ligada mesmo no perfil governado.
      expectSameFile(
        path.join(artifactDir, 'settings.json'),
        path.join(fx.providerHome, 'settings.json'),
      );
      expect(result.providerSessionHome).toContain('checkout-2');
    } finally {
      cleanupCliMcpSession(TOKEN);
    }
  });
});

describe('prepareQwenMcpSession — injeção de chave do Nexus (F-1565)', () => {
  const PLAN = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';

  it('com injeção, o overlay ESCREVE um settings mesclado (sem segredo) em vez de ligar', () => {
    const fx = fixture();
    const result = prepareQwenMcpSession(URL, TOKEN, {
      home: fx.home,
      providerHome: fx.providerHome,
      userDataPath: fx.userDataPath,
      artifactRoot: fx.artifactRoot,
      checkoutId: 'checkout-3',
      cwd: fx.workspace,
      workspaceRoot: fx.workspace,
      qwenSettingsInjection: {
        baseUrl: PLAN,
        models: ['qwen3.8-max'],
        tokenPlanKey: true,
      },
    });
    try {
      const artifactDir = result.artifactDir!;
      const written = path.join(artifactDir, 'settings.json');
      // Não é link para o perfil real: é a cópia mesclada efêmera.
      if (process.platform !== 'win32') {
        expect(fs.lstatSync(written).isSymbolicLink()).toBe(false);
      }
      const merged = JSON.parse(fs.readFileSync(written, 'utf8')) as {
        security: { auth: { selectedType: string } };
        modelProviders: { openai: Array<Record<string, unknown>> };
        env?: Record<string, string>;
      };
      expect(merged.security.auth.selectedType).toBe('openai');
      expect(merged.modelProviders.openai[0]).toMatchObject({
        id: 'qwen3.8-max',
        baseUrl: PLAN,
        envKey: 'BAILIAN_TOKEN_PLAN_API_KEY',
      });
      // O settings do operador (com o env.BAILIAN… dele) é preservado na
      // mescla, mas o arquivo real nunca é tocado.
      expect(merged.env?.BAILIAN_TOKEN_PLAN_API_KEY).toBe('fixture-settings-secret');
      expect(fs.readFileSync(path.join(fx.providerHome, 'settings.json'), 'utf8'))
        .not.toContain('modelProviders');
      // MCP ambiente continua lido do settings do operador (blender entra).
      expect(readMcpConfig(artifactDir).mcpServers.blender).toEqual({ command: 'blender-mcp' });
    } finally {
      cleanupCliMcpSession(TOKEN);
    }
  });

  it('governado com injeção: o grant de escrita no settings.json REAL sai', () => {
    const fx = fixture();
    const result = prepareQwenMcpSession(URL, TOKEN, {
      home: fx.home,
      providerHome: fx.providerHome,
      userDataPath: fx.userDataPath,
      artifactRoot: fx.artifactRoot,
      checkoutId: 'checkout-4',
      cwd: fx.workspace,
      workspaceRoot: fx.workspace,
      governed: true,
      allowedSkills: [],
      allowedTools: [],
      qwenSettingsInjection: { baseUrl: PLAN, models: ['qwen3.8-max'], tokenPlanKey: true },
    });
    try {
      expect(result.providerStateWritePaths ?? []).not.toContain(
        path.join(fx.providerHome, 'settings.json'),
      );
      const written = path.join(result.artifactDir!, 'settings.json');
      if (process.platform !== 'win32') {
        expect(fs.lstatSync(written).isSymbolicLink()).toBe(false);
      }
    } finally {
      cleanupCliMcpSession(TOKEN);
    }
  });
});
