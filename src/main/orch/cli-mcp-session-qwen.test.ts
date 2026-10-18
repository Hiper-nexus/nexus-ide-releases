import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readQwenOperatorSettings } from '../adapters/qwen-settings';
import { cleanupCliMcpSession, purgeStaleCliMcpSessions } from './cli-mcp-session-artifacts';
import { prepareQwenMcpSession } from './cli-mcp-session-qwen';

// A2: o settings do operador só é lido quando algum caminho precisa dele; o
// espião conta as leituras sem trocar o comportamento real.
vi.mock('../adapters/qwen-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/qwen-settings')>();
  return { ...actual, readQwenOperatorSettings: vi.fn(actual.readQwenOperatorSettings) };
});

const tempDirs: string[] = [];

beforeEach(() => {
  vi.mocked(readQwenOperatorSettings).mockClear();
});

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
const INJECTED_ENV = 'NEXUS_QWEN_KEY_0123456789abcdef0123456789abcdef';

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
        envKey: INJECTED_ENV,
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
        envKey: INJECTED_ENV,
      });
      // M2: a chave Alibaba do operador (env.BAILIAN… do settings dele) não
      // vai para a cópia: a injetada é a única credencial do pane e nenhum
      // segredo velho fica em disco. O arquivo real nunca é tocado.
      expect(merged.env?.BAILIAN_TOKEN_PLAN_API_KEY).toBeUndefined();
      expect(result.env.QWEN_CODE_SYSTEM_SETTINGS_PATH).toBe(written);
      expect(fs.readFileSync(written, 'utf8')).not.toContain('fixture-settings-secret');
      expect(fs.readFileSync(path.join(fx.providerHome, 'settings.json'), 'utf8'))
        .toContain('fixture-settings-secret');
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
      qwenSettingsInjection: { baseUrl: PLAN, models: ['qwen3.8-max'], tokenPlanKey: true, envKey: INJECTED_ENV },
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

describe('prepareQwenMcpSession — settings do operador sob demanda e tolerante (F-1565)', () => {
  const PLAN = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
  const injection = { baseUrl: PLAN, models: ['qwen3.8-max'], tokenPlanKey: true, envKey: INJECTED_ENV };
  const governed = { governed: true, allowedSkills: [], allowedTools: [] } as const;

  function start(
    fx: Fixture,
    checkoutId: string,
    extra: Partial<Parameters<typeof prepareQwenMcpSession>[2]> = {},
  ) {
    return prepareQwenMcpSession(URL, TOKEN, {
      home: fx.home,
      providerHome: fx.providerHome,
      userDataPath: fx.userDataPath,
      artifactRoot: fx.artifactRoot,
      checkoutId,
      cwd: fx.workspace,
      workspaceRoot: fx.workspace,
      ...extra,
    });
  }

  function operatorSettings(fx: Fixture, content: string | Buffer): void {
    fs.writeFileSync(path.join(fx.providerHome, 'settings.json'), content);
  }

  function readMerged(artifactDir: string): {
    security: { auth: Record<string, unknown> };
    model?: { name?: string };
    modelProviders: { openai: Array<Record<string, unknown>> };
    env?: Record<string, string>;
  } {
    return JSON.parse(fs.readFileSync(path.join(artifactDir, 'settings.json'), 'utf8'));
  }

  it('worker governado SEM injeção nem lê o settings: o arquivo continua só ligado', () => {
    const fx = fixture();
    operatorSettings(fx, '{not json');
    const result = start(fx, 'c-a2-1', governed);
    try {
      expect(readQwenOperatorSettings).not.toHaveBeenCalled();
      expectSameFile(
        path.join(result.artifactDir!, 'settings.json'),
        path.join(fx.providerHome, 'settings.json'),
      );
      expect(Object.keys(readMcpConfig(result.artifactDir!).mcpServers)).toEqual([result.serverName]);
    } finally {
      cleanupCliMcpSession(TOKEN);
    }
  });

  it.each([
    ['JSONC com comentários e vírgula final', '// perfil\n{ "model": { "name": "qwen3.8-max", }, }'],
    ['BOM', '\uFEFF{"model":{"name":"qwen3.8-max"}}'],
  ])('worker governado com injeção e settings com %s: sobe e a mescla aproveita os campos do operador', (_label, content) => {
    const fx = fixture();
    operatorSettings(fx, content);
    const result = start(fx, 'c-a2-2', { ...governed, qwenSettingsInjection: injection });
    try {
      expect(readQwenOperatorSettings).toHaveBeenCalledTimes(1);
      const merged = readMerged(result.artifactDir!);
      expect(merged.model?.name).toBe('qwen3.8-max');
      expect(merged.security.auth.selectedType).toBe('openai');
      expect(merged.modelProviders.openai[0]).toMatchObject({
        id: 'qwen3.8-max',
        baseUrl: PLAN,
        envKey: INJECTED_ENV,
      });
    } finally {
      cleanupCliMcpSession(TOKEN);
    }
  });

  it.each([
    ['inválido', '{not json'],
    ['raiz que não é objeto', '[]'],
    ['vazio', ''],
  ])('worker governado com injeção e settings %s: não derruba o spawn, a cópia nasce só com as entradas do Nexus', (_label, content) => {
    const fx = fixture();
    operatorSettings(fx, content);
    const result = start(fx, 'c-a2-3', { ...governed, qwenSettingsInjection: injection });
    try {
      const merged = readMerged(result.artifactDir!);
      expect(merged.model).toBeUndefined();
      expect(merged.modelProviders.openai).toHaveLength(1);
      expect(merged.modelProviders.openai[0]).toMatchObject({ id: 'qwen3.8-max', envKey: INJECTED_ENV });
      expect(Object.keys(readMcpConfig(result.artifactDir!).mcpServers)).toEqual([result.serverName]);
    } finally {
      cleanupCliMcpSession(TOKEN);
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'worker governado com injeção e settings sem permissão de leitura (EACCES): sobe',
    () => {
      const fx = fixture();
      const file = path.join(fx.providerHome, 'settings.json');
      fs.chmodSync(file, 0o000);
      try {
        const result = start(fx, 'c-a2-4', { ...governed, qwenSettingsInjection: injection });
        try {
          expect(readMerged(result.artifactDir!).modelProviders.openai).toHaveLength(1);
        } finally {
          cleanupCliMcpSession(TOKEN);
        }
      } finally {
        fs.chmodSync(file, 0o600);
      }
    },
  );

  it('pane não-governado: JSONC dá o MCP ambiente certo; settings inválido não derruba e vira sem MCP ambiente', () => {
    const fx = fixture();
    operatorSettings(fx, '\uFEFF// ferramentas\n{ "mcpServers": { "blender": { "command": "blender-mcp", }, }, }');
    const jsonc = start(fx, 'c-a2-5');
    try {
      expect(readMcpConfig(jsonc.artifactDir!).mcpServers.blender).toEqual({ command: 'blender-mcp' });
    } finally {
      cleanupCliMcpSession(TOKEN);
    }
    operatorSettings(fx, '{not json');
    const broken = start(fx, 'c-a2-6');
    try {
      expect(Object.keys(readMcpConfig(broken.artifactDir!).mcpServers)).toEqual([broken.serverName]);
    } finally {
      cleanupCliMcpSession(TOKEN);
    }
  });

  it('M2: modelo fora de injection.models não acha credencial velha — nada do operador sobra em disco', () => {
    const fx = fixture();
    operatorSettings(
      fx,
      JSON.stringify({
        model: { name: 'qwen-modelo-que-so-o-operador-tem' },
        security: { auth: { selectedType: 'openai', apiKey: 'sk-sp-VELHA-EMBUTIDA' } },
        env: { BAILIAN_TOKEN_PLAN_API_KEY: 'sk-sp-VELHA-ENV', DASHSCOPE_API_KEY: 'sk-velha-dash', OUTRA: 'fica' },
      }),
    );
    const result = start(fx, 'c-m2', { qwenSettingsInjection: injection });
    try {
      const raw = fs.readFileSync(path.join(result.artifactDir!, 'settings.json'), 'utf8');
      expect(raw).not.toMatch(/sk-sp-VELHA|sk-velha-dash/);
      const merged = readMerged(result.artifactDir!);
      expect(merged.security.auth).not.toHaveProperty('apiKey');
      expect(merged.env).toEqual({ OUTRA: 'fica' });
      expect(merged.model?.name).toBe('qwen-modelo-que-so-o-operador-tem');
    } finally {
      cleanupCliMcpSession(TOKEN);
    }
  });
});

describe('purgeStaleCliMcpSessions — overlay qwen órfão (F-1565)', () => {
  it('a purga de boot limpa a cópia mesclada de um processo que morreu e poupa o overlay ativo', () => {
    const fx = fixture();
    const active = prepareQwenMcpSession(URL, TOKEN, {
      home: fx.home,
      providerHome: fx.providerHome,
      userDataPath: fx.userDataPath,
      artifactRoot: fx.artifactRoot,
      checkoutId: 'checkout-purge',
      cwd: fx.workspace,
      workspaceRoot: fx.workspace,
      qwenSettingsInjection: {
        baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
        models: ['qwen3.8-max'],
        tokenPlanKey: true,
        envKey: INJECTED_ENV,
      },
    });
    try {
      // Sobra de um processo que morreu sem teardown: diretório de sessão (hash
      // de 32 hex) com uma cópia mesclada do settings do operador.
      const orphan = path.join(fx.artifactRoot, 'qwen', 'a'.repeat(32));
      fs.mkdirSync(orphan, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(orphan, 'settings.json'), '{"modelProviders":{"openai":[]}}\n');

      const result = purgeStaleCliMcpSessions({ home: fx.home, artifactRoot: fx.artifactRoot });

      expect(fs.existsSync(orphan)).toBe(false);
      expect(fs.existsSync(path.join(active.artifactDir!, 'settings.json'))).toBe(true);
      expect(result).toMatchObject({ removed: 1, skippedActive: 1, failed: 0 });
    } finally {
      cleanupCliMcpSession(TOKEN);
    }
  });
});
