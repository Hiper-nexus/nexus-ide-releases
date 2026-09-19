import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import {
  cliPtyAdapterSchema,
  adapterSchema,
  resolvePlaceholders,
} from '../../shared/adapter-types';
import type { Adapter } from '../../shared/adapter-types';
import { buildControlArgs } from './control-args';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import publishedModelCatalog from '../../../resources/model-catalog.json';
import {
  adapterCapabilityMatrixForAdapter,
  authMethodForAdapter,
  mergeAdapters,
  broadcastToListeners,
  orchestrationEvidenceForAdapter,
  missionControlCapabilityForAdapter,
  taskHandoffCapabilityForAdapter,
} from './adapter-registry';

// ── Minimal valid cli-pty adapter for reuse across tests ────────────────────

const MINIMAL_CLI_PTY = {
  kind: 'cli-pty' as const,
  id: 'test-cli',
  label: 'Test CLI',
  version: '1.0.0',
  icon: '🤖',
  bin: 'test-cli',
  detect: 'test-cli --version',
  install: { method: 'npm' as const, command: 'npm install -g test-cli' },
  auth: { method: 'none' as const },
  spawn: {
    interactive: ['test-cli'],
    headless: ['test-cli', '--prompt', '{{PROMPT}}'],
    ptyRequired: true,
    resumeArgs: [],
    extraArgs: [],
  },
  env: { static: {}, passthrough: [], ephemeralHome: false },
  models: { flag: '--model', list: ['default'], default: 'default' },
  promptInjection: { method: 'arg' as const, trailingNewline: true, bracketedPaste: false },
  stateParsing: {
    idle: { type: 'timeout' as const, ms: 500 },
    shellIntegration: false,
    exitCodes: {},
  },
  quirks: {
    altScreen: false,
    requiresNoAutoUpdate: false,
    mcpAutoload: false,
    nexusMcp: 'none' as const,
  },
  control: {},
};

// ── Schema validation tests ──────────────────────────────────────────────────

describe('cliPtyAdapterSchema', () => {
  it('accepts a fully valid cli-pty adapter', () => {
    const result = cliPtyAdapterSchema.safeParse(MINIMAL_CLI_PTY);
    expect(result.success).toBe(true);
  });

  it('rejects an adapter missing required fields', () => {
    const result = cliPtyAdapterSchema.safeParse({ kind: 'cli-pty', id: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects an id with illegal characters', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      id: 'My CLI!',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an id with uppercase', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      id: 'MyCLI',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a timeout idle pattern', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      stateParsing: { ...MINIMAL_CLI_PTY.stateParsing, idle: { type: 'timeout', ms: 1000 } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a regex idle pattern', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      stateParsing: { ...MINIMAL_CLI_PTY.stateParsing, idle: { type: 'regex', pattern: '^\\$ ' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown idle pattern type', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      stateParsing: { ...MINIMAL_CLI_PTY.stateParsing, idle: { type: 'magic' } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts uv as an isolated Python tool installer', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      install: {
        method: 'uv',
        command: 'uv tool install aider-chat',
      },
    });
    expect(result.success).toBe(true);
  });

  it('keeps legacy custom adapters with only mcpAutoload enabled', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      quirks: {
        altScreen: false,
        requiresNoAutoUpdate: false,
        mcpAutoload: true,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.quirks.mcpAutoload).toBe(true);
      expect(result.data.quirks.nexusMcp).toBe('none');
    }
  });

  it('rejects nexusMcp autoload when the injection path is disabled', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      quirks: {
        ...MINIMAL_CLI_PTY.quirks,
        mcpAutoload: false,
        nexusMcp: 'autoload',
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['quirks', 'nexusMcp'],
          }),
        ]),
      );
    }
  });
});

// ── Builtin adapters ─────────────────────────────────────────────────────────

describe('builtin adapters', () => {
  const builtin = (id: string) =>
    BUILTIN_ADAPTERS.find(
      (adapter) => (adapter as { id?: string }).id === id,
    ) as {
      bin?: string;
      install?: { method?: string; command?: string };
      spawn?: {
        interactive?: string[];
        headless?: string[];
        extraArgs?: string[];
        resumeArgs?: string[];
        resumeIdArgs?: string[];
        sessionIdArg?: string;
      };
      env?: { ephemeralHome?: boolean };
      models?: { default?: string };
      auth?: { loginCommand?: string };
      control?: { permission?: { safe?: string[]; yolo?: string[] } };
    } | undefined;

  it('never publishes a model id the adapter itself does not offer', () => {
    // Campo (02/08): o roster selou `grok/grok-build` para o Revisor sênior. O
    // pane abriu, a CLI respondeu `Couldn't switch model: Invalid params:
    // "unknown model id"`, e a task ficou `running` PARA SEMPRE — a missão
    // parou sem nunca falhar, e a task seguinte nunca destravou.
    //
    // `grok-build` não é modelo: é o nome do projeto que este repositório cita
    // como fonte de ideia em uma dúzia de comentários. Ele estava publicado no
    // catálogo de runtime como `default` do grok E marcado
    // `availability: cheap`, e o roteador prefere rota barata — então ganhava
    // sempre. Um id inválido não falha na selagem; falha depois, calado.
    //
    // A invariante que pega a classe inteira é cruzada: o catálogo publicado
    // só pode oferecer o que o adapter builtin realmente aceita.
    const published = publishedModelCatalog.adapters as Record<
      string,
      { default?: string; models?: readonly { id: string }[] } | undefined
    >;
    for (const raw of BUILTIN_ADAPTERS) {
      const adapter = raw as {
        id?: string;
        models?: { list?: string[]; default?: string };
      };
      const offered = adapter.models?.list ?? [];
      // Adapters sem modelo enumerável (muse: a CLI aceita um --model
      // opaco que o catálogo não tem como listar) declaram default "" =
      // "sem opinião". O runtime descarta modelo vazio em vez de selá-lo
      // (readyModelForAdapter / firstDeclaredModel), então não há id
      // inválido para publicar — só defaults não-vazios entram aqui.
      // (O incidente grok-build acima era um id ERRADO, não ausência.)
      if (adapter.models?.default) {
        expect(offered).toContain(adapter.models.default);
      }
      const entry = adapter.id ? published[adapter.id] : undefined;
      if (!entry) continue;
      for (const model of entry.models ?? []) {
        expect(
          offered,
          `${adapter.id}: catálogo publica "${model.id}", que o adapter não oferece`,
        ).toContain(model.id);
      }
      if (entry.default !== undefined) {
        expect(
          offered,
          `${adapter.id}: default publicado "${entry.default}" não é oferecido pelo adapter`,
        ).toContain(entry.default);
      }
    }
  });

  it('all builtins pass schema validation', () => {
    for (const raw of BUILTIN_ADAPTERS) {
      const result = adapterSchema.safeParse(raw);
      if (!result.success) {
        const raw_ = raw as { id?: unknown };
        throw new Error(
          `Builtin adapter "${raw_?.id ?? '?'}" failed validation: ` +
            result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      expect(result.success).toBe(true);
    }
  });

  it('all builtin ids are unique', () => {
    const ids = BUILTIN_ADAPTERS.map((a) => (a as { id?: string }).id ?? '');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all builtins declare a known adapter kind', () => {
    const kinds = new Set(['cli-pty', 'cli-rpc', 'api-provider']);
    for (const raw of BUILTIN_ADAPTERS) {
      expect(kinds.has((raw as { kind?: string }).kind ?? '')).toBe(true);
    }
    // Every bundled CLI currently runs through the observable PTY boundary.
    const byKind = BUILTIN_ADAPTERS.map((raw) => (raw as { kind?: string }).kind);
    expect(byKind.filter((kind) => kind === 'cli-rpc')).toEqual([]);
  });

  it('declares only physically usable Nexus MCP routes', () => {
    const integration = (id: string) =>
      (BUILTIN_ADAPTERS.find(
        (adapter) => (adapter as { id?: string }).id === id,
      ) as { quirks?: { nexusMcp?: string } } | undefined)?.quirks?.nexusMcp;

    expect(integration('aider')).toBe('none');
    expect(integration('claude')).toBe('autoload');
    expect(integration('openclaude')).toBe('autoload');
    expect(integration('glm')).toBe('autoload');
    expect(integration('glm-flash')).toBe('autoload');
    expect(integration('longcat')).toBe('autoload');
    expect(integration('codex')).toBe('codex');
    // AGY 1.1 ignores private MCP profile projections. Mission workers use
    // the Main-owned PTY-stream handoff instead of advertising fake MCP.
    expect(integration('agy')).toBe('none');
    expect(integration('opencode')).toBe('opencode');
    expect(integration('kimi')).toBe('kimi');
    expect(integration('grok')).toBe('grok');
  });

  it('claude builtin has altScreen:true', () => {
    const claude = BUILTIN_ADAPTERS.find(
      (a) => (a as { id?: string }).id === 'claude',
    ) as { quirks?: { altScreen?: boolean } } | undefined;
    expect(claude?.quirks?.altScreen).toBe(true);
  });

  it('aider builtin has altScreen:false', () => {
    const aider = BUILTIN_ADAPTERS.find(
      (a) => (a as { id?: string }).id === 'aider',
    ) as { quirks?: { altScreen?: boolean } } | undefined;
    expect(aider?.quirks?.altScreen).toBe(false);
  });

  it('ships the model ids reported by the current AGY CLI', () => {
    const agy = BUILTIN_ADAPTERS.find(
      (adapter) => (adapter as { id?: string }).id === 'agy',
    ) as { models?: { default?: string; list?: string[] } } | undefined;
    const models = agy?.models?.list ?? [];

    expect(agy?.models?.default).toBe('gemini-3.8-flash-high');
    expect(models).toEqual(
      expect.arrayContaining([
        'gemini-3.7-flash-high',
        'gemini-3.7-flash-medium',
        'gemini-3.7-flash-low',
        'gemini-3.6-flash-high',
        'gemini-3.6-flash-medium',
        'gemini-3.6-flash-low',
        'gemini-3.5-flash-medium',
        'claude-sonnet-4-6',
      ]),
    );
    expect(models).not.toContain('claude-sonnet-4-6-thinking');
  });

  it('agy yolo flag matches the installed Antigravity CLI', () => {
    const agy = BUILTIN_ADAPTERS.find(
      (a) => (a as { id?: string }).id === 'agy',
    ) as { control?: { permission?: { yolo?: string[] } } } | undefined;
    expect(agy?.control?.permission?.yolo).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('pins safe sandbox/approval flags for the primary coding CLIs', () => {
    const permission = (id: string) =>
      (BUILTIN_ADAPTERS.find(
        (adapter) => (adapter as { id?: string }).id === id,
      ) as { control?: { permission?: { safe?: string[] } } } | undefined)
        ?.control?.permission;
    expect(permission('codex')?.safe).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
    ]);
    expect(permission('claude')?.safe).toEqual([
      '--permission-mode',
      'manual',
    ]);
    expect(permission('agy')?.safe).toEqual(['--sandbox']);
    expect(permission('glm')?.safe).toEqual([
      '--permission-mode',
      'manual',
    ]);
    expect(permission('glm-flash')?.safe).toEqual([
      '--permission-mode',
      'manual',
    ]);
    expect(permission('longcat')?.safe).toEqual([
      '--permission-mode',
      'manual',
    ]);
    expect(permission('grok')?.safe).toEqual([
      '--permission-mode',
      'default',
      '--sandbox',
      'workspace',
    ]);
  });

  it('uses current official and reversible package-manager installs where available', () => {
    expect(builtin('aider')?.install).toEqual({
      method: 'uv',
      command:
        'uv tool install --force --python python3.12 --with pip aider-chat@latest',
    });
    expect(builtin('opencode')?.install).toEqual({
      method: 'brew',
      command: 'brew install anomalyco/tap/opencode',
    });
    expect(builtin('kimi')?.install).toEqual({
      method: 'npm',
      command: 'npm install -g @moonshot-ai/kimi-code',
    });
    expect(builtin('openclaude')?.install).toEqual({
      method: 'npm',
      command: 'npm install -g @gitlawb/openclaude@latest',
    });
  });

  it('ships OpenClaude as its own binary, not a Claude overlay', () => {
    const openclaude = builtin('openclaude');
    expect(openclaude?.bin).toBe('openclaude');
    expect(openclaude?.spawn?.interactive?.[0]).toBe('openclaude');
    expect(openclaude?.spawn?.extraArgs).toEqual([
      '--disallowed-tools',
      'Task',
    ]);
    expect(openclaude?.env?.ephemeralHome).toBe(false);
    expect(openclaude?.models?.default).toBe('sonnet');
    expect(openclaude?.auth?.loginCommand).toBe('openclaude auth login');
  });

  it('uses Kimi Code transient-model env instead of ignored legacy key vars', () => {
    const kimi = BUILTIN_ADAPTERS.find(
      (adapter) => (adapter as { id?: string }).id === 'kimi',
    ) as {
      auth?: { method?: string; envVarFallback?: string };
      env?: { passthrough?: string[] };
    } | undefined;

    expect(kimi?.auth).toMatchObject({
      method: 'api_key',
      envVarFallback: 'KIMI_MODEL_API_KEY',
    });
    expect(kimi?.env?.passthrough).toContain('KIMI_MODEL_NAME');
    expect(kimi?.env?.passthrough).toContain('KIMI_MODEL_API_KEY');
    expect(kimi?.env?.passthrough).not.toContain('MOONSHOT_API_KEY');
    expect(kimi?.env?.passthrough).not.toContain('KIMI_API_KEY');
  });

  it('declares only provider-qualified OpenCode models with a locally available default', () => {
    const opencode = BUILTIN_ADAPTERS.find(
      (adapter) => (adapter as { id?: string }).id === 'opencode',
    ) as { models?: { list?: string[]; default?: string } } | undefined;

    expect(opencode?.models?.default).toBe('opencode/big-pickle');
    expect(opencode?.models?.list).toContain('opencode/big-pickle');
    expect(opencode?.models?.list?.every((model) => model.includes('/')))
      .toBe(true);
  });

  it('ships the official Claude Opus 5 id in Claude', () => {
    const claude = BUILTIN_ADAPTERS.find(
      (adapter) => (adapter as { id?: string }).id === 'claude',
    ) as { models?: { list?: string[]; default?: string } } | undefined;

    expect(claude?.models?.list?.[0]).toBe('claude-opus-5');
    expect(claude?.models?.list).toContain('claude-opus-5');
    expect(claude?.models?.default).toBe('claude-sonnet-5');
  });

  it('abre Codex no melhor modelo GA em vez de cair no default nativo 5.5', () => {
    const codex = BUILTIN_ADAPTERS.find(
      (adapter) => (adapter as { id?: string }).id === 'codex',
    ) as { models?: { list?: string[]; default?: string } } | undefined;

    expect(codex?.models?.default).toBe('gpt-5.6-sol');
    expect(codex?.models?.list?.[0]).toBe('gpt-6-astra');
    expect(codex?.models?.list).toContain('gpt-5.6-sol');
  });

  it('uses the xAI CLI official API-key variable for Grok', () => {
    const grok = BUILTIN_ADAPTERS.find(
      (adapter) => (adapter as { id?: string }).id === 'grok',
    ) as {
      auth?: { envVarFallback?: string };
      env?: { passthrough?: string[] };
    } | undefined;

    expect(grok?.auth?.envVarFallback).toBe('XAI_API_KEY');
    expect(grok?.env?.passthrough).toEqual(['XAI_API_KEY']);
  });

  it('never substitutes community packages for the installed official AGY/Grok CLIs', () => {
    expect(builtin('agy')?.install).toEqual({
      method: 'manual',
      command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    });
    expect(builtin('grok')?.install).toEqual({
      method: 'manual',
      command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    });
  });

  it('uses the current Codex exec subcommand for non-interactive work', () => {
    expect(builtin('codex')?.spawn?.headless).toEqual([
      'codex',
      '--ask-for-approval',
      'on-request',
      'exec',
      '--sandbox',
      'workspace-write',
      '{{PROMPT}}',
    ]);
  });

  it('does not silently auto-approve headless Grok work', () => {
    expect(builtin('grok')?.spawn?.headless).toEqual([
      'grok',
      '-p',
      '{{PROMPT}}',
    ]);
  });

  it('declares Kimi Code native --yolo approval while preserving headless prompt mode', () => {
    // Verified against kimi 1.50.0 --help: --yolo/--yes/--auto-approve.
    expect(builtin('kimi')?.spawn?.headless).toEqual([
      'kimi',
      '--output-format',
      'text',
      '-p',
      '{{PROMPT}}',
    ]);
    expect(builtin('kimi')?.spawn?.headless).not.toContain('--auto');
    expect(builtin('kimi')?.control?.permission?.yolo).toEqual(['--yolo']);
  });

  it('separates declared MCP routes from operational orchestration evidence', () => {
    const parsed = (id: string) => {
      const raw = BUILTIN_ADAPTERS.find(
        (adapter) => (adapter as { id?: string }).id === id,
      );
      const result = adapterSchema.safeParse(raw);
      if (!result.success) throw result.error;
      return result.data;
    };

    expect(orchestrationEvidenceForAdapter(parsed('claude'), 'builtin')).toBe(
      'verified',
    );
    expect(orchestrationEvidenceForAdapter(parsed('codex'), 'builtin')).toBe(
      'verified',
    );
    expect(orchestrationEvidenceForAdapter(parsed('kimi'), 'builtin')).toBe(
      'unsupported',
    );
    // grok declarou confinamento read-only enforceável (`--sandbox read-only`,
    // probe físico de escape verde) e tem rota MCP — sobe para Maestro
    // experimental; a promoção a verified exige o gate físico de coordenação.
    expect(orchestrationEvidenceForAdapter(parsed('grok'), 'builtin')).toBe(
      'experimental',
    );
    expect(orchestrationEvidenceForAdapter(parsed('opencode'), 'builtin')).toBe(
      'unsupported',
    );
    expect(orchestrationEvidenceForAdapter(parsed('glm'), 'builtin')).toBe(
      'unsupported',
    );
    expect(orchestrationEvidenceForAdapter(parsed('glm-flash'), 'builtin')).toBe(
      'unsupported',
    );
    expect(orchestrationEvidenceForAdapter(parsed('longcat'), 'builtin')).toBe(
      'unsupported',
    );
    expect(orchestrationEvidenceForAdapter(parsed('aider'), 'builtin')).toBe(
      'unsupported',
    );
    expect(orchestrationEvidenceForAdapter(parsed('openclaude'), 'builtin')).toBe(
      'unsupported',
    );
    expect(orchestrationEvidenceForAdapter(parsed('claude'), 'user')).toBe(
      'experimental',
    );
  });

  it('projects an explicit capability ladder without letting adapters self-qualify authority', () => {
    const parsed = (id: string) => {
      const raw = BUILTIN_ADAPTERS.find(
        (adapter) => (adapter as { id?: string }).id === id,
      );
      const result = adapterSchema.safeParse(raw);
      if (!result.success) throw result.error;
      return result.data;
    };

    expect(
      adapterCapabilityMatrixForAdapter(parsed('claude'), 'builtin'),
    ).toEqual({
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: true,
      governedWriter: false,
      verifiedMaestro: true,
    });
    expect(
      adapterCapabilityMatrixForAdapter(parsed('codex'), 'builtin'),
    ).toEqual({
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: true,
      governedWriter: true,
      verifiedMaestro: true,
    });
    expect(
      adapterCapabilityMatrixForAdapter(parsed('kimi'), 'builtin'),
    ).toEqual({
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: false,
      governedWriter: false,
      verifiedMaestro: false,
    });
    expect(
      adapterCapabilityMatrixForAdapter(parsed('aider'), 'builtin'),
    ).toEqual({
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: false,
      autonomousReadOnly: false,
      governedWriter: false,
      verifiedMaestro: false,
    });

    // Even the exact builtin declaration loses every release qualification
    // when it came from the user adapter directory.
    expect(
      adapterCapabilityMatrixForAdapter(parsed('codex'), 'user'),
    ).toMatchObject({
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: false,
      governedWriter: false,
      verifiedMaestro: false,
    });
  });

  it('admits custom launchable CLIs to the Main-owned PTY handoff lane', () => {
    const parsed = cliPtyAdapterSchema.parse(MINIMAL_CLI_PTY);

    expect(taskHandoffCapabilityForAdapter(parsed, 'user')).toBe(true);
    expect(missionControlCapabilityForAdapter(parsed, 'user')).toBe(false);
    expect(
      taskHandoffCapabilityForAdapter(
        {
          ...parsed,
          spawn: {
            ...parsed.spawn,
            headless: ['test-cli'],
          },
          promptInjection: {
            ...parsed.promptInjection,
            method: 'arg',
          },
        },
        'user',
      ),
    ).toBe(false);
    expect(
      missionControlCapabilityForAdapter(
        {
          ...parsed,
          spawn: {
            ...parsed.spawn,
            headless: ['test-cli'],
          },
          promptInjection: {
            ...parsed.promptInjection,
            method: 'arg',
          },
        },
        'user',
      ),
    ).toBe(false);
  });

  it.each([
    ['claude', true],
    ['codex', true],
    ['agy', false],
    ['aider', false],
  ])('projects physical Nexus MCP coordinator eligibility for %s', (id, capable) => {
    const raw = BUILTIN_ADAPTERS.find(
      (item) => (item as { id?: string }).id === id,
    );
    const parsed = adapterSchema.parse(raw);

    expect(taskHandoffCapabilityForAdapter(parsed, 'builtin')).toBe(true);
    expect(missionControlCapabilityForAdapter(parsed, 'builtin')).toBe(capable);
  });

  it('admits custom Claude binaries even when their legacy metadata omits MCP', () => {
    const parsed = cliPtyAdapterSchema.parse({
      ...MINIMAL_CLI_PTY,
      id: 'custom-claude',
      bin: 'claude',
    });

    expect(missionControlCapabilityForAdapter(parsed, 'user')).toBe(true);
  });

  it('admits custom MCP declarations but rejects AGY even with autoload metadata', () => {
    const parsed = cliPtyAdapterSchema.parse(MINIMAL_CLI_PTY);

    expect(missionControlCapabilityForAdapter({
      ...parsed,
      quirks: { ...parsed.quirks, mcpAutoload: true },
    }, 'user')).toBe(true);
    expect(missionControlCapabilityForAdapter({
      ...parsed,
      quirks: { ...parsed.quirks, mcpAutoload: true, nexusMcp: 'agy' },
    }, 'user')).toBe(false);
  });

  it.each([
    ['agy', ['--conversation']],
    ['claude', ['--resume']],
    ['codex', ['resume']],
    ['glm', ['--resume']],
    ['glm-flash', ['--resume']],
    ['grok', ['--resume']],
    ['kimi', ['--session']],
    ['longcat', ['--resume']],
    ['opencode', ['--session']],
    ['openclaude', ['--resume']],
  ])(
    '%s disables latest resume and preserves exact provider session ID flags',
    (id, exact) => {
      const adapter = cliPtyAdapterSchema.parse(builtin(id));
      expect(adapter.spawn.resumeArgs).toEqual([]);
      expect(adapter.spawn.resumeIdArgs).toEqual(exact);
    },
  );

  it.each(['claude', 'openclaude', 'glm', 'glm-flash', 'longcat', 'grok'])(
    '%s dictates a fresh provider session id for exact per-pane recovery',
    (id) => {
      expect(builtin(id)?.spawn?.sessionIdArg).toBe('--session-id');
    },
  );

  it('grok trusts the workspace folder before the TUI prompt can block', () => {
    const grok = BUILTIN_ADAPTERS.find(
      (a) => (a as { id?: string }).id === 'grok',
    ) as { spawn?: { extraArgs?: string[] } } | undefined;
    expect(grok?.spawn?.extraArgs).toContain('--trust-folder');
  });
});

// ── resolvePlaceholders ──────────────────────────────────────────────────────

describe('resolvePlaceholders', () => {
  it('replaces known placeholders', () => {
    const args = ['--model', '{{MODEL}}', '-p', '{{PROMPT}}'];
    const vars = { MODEL: 'claude-opus', PROMPT: 'hello world' };
    expect(resolvePlaceholders(args, vars)).toEqual([
      '--model', 'claude-opus', '-p', 'hello world',
    ]);
  });

  it('resolves unknown placeholders to empty string', () => {
    const args = ['{{UNKNOWN}}'];
    expect(resolvePlaceholders(args, {})).toEqual(['']);
  });

  it('leaves args with no placeholders unchanged', () => {
    const args = ['claude', '--no-auto-update', '--model', 'default'];
    expect(resolvePlaceholders(args, {})).toEqual(args);
  });

  it('handles multiple placeholders in one arg', () => {
    const args = ['{{BIN}}-{{VERSION}}'];
    expect(resolvePlaceholders(args, { BIN: 'mycli', VERSION: '1.0' })).toEqual([
      'mycli-1.0',
    ]);
  });

  it('handles empty args array', () => {
    expect(resolvePlaceholders([], { MODEL: 'x' })).toEqual([]);
  });
});

// ── broadcastToListeners (destroyed-window guard) ────────────────────────────

describe('broadcastToListeners', () => {
  const fakeWc = (destroyed: boolean, crashed = false) =>
    ({
      isDestroyed: () => destroyed,
      isCrashed: () => crashed,
      send: vi.fn(),
    }) as unknown as WebContents;

  it('sends to a live listener', () => {
    const wc = fakeWc(false);
    const targets = new Set<WebContents>([wc]);
    broadcastToListeners(targets, 'ch', { a: 1 });
    expect(wc.send).toHaveBeenCalledWith('ch', { a: 1 });
  });

  it('does not send to a destroyed listener (no throw)', () => {
    const wc = fakeWc(true);
    const targets = new Set<WebContents>([wc]);
    expect(() => broadcastToListeners(targets, 'ch', {})).not.toThrow();
    expect(wc.send).not.toHaveBeenCalled();
  });

  it('skips a crashed listener but keeps it (renderer may reload)', () => {
    const wc = fakeWc(false, true);
    const targets = new Set<WebContents>([wc]);
    expect(() => broadcastToListeners(targets, 'ch', {})).not.toThrow();
    expect(wc.send).not.toHaveBeenCalled();
    expect(targets.has(wc)).toBe(true);
  });

  it('prunes destroyed listeners from the set', () => {
    const dead = fakeWc(true);
    const live = fakeWc(false);
    const targets = new Set<WebContents>([dead, live]);
    broadcastToListeners(targets, 'ch', {});
    expect(targets.has(dead)).toBe(false);
    expect(targets.has(live)).toBe(true);
  });

  it('delivers to live listeners even when a destroyed one is present', () => {
    const dead = fakeWc(true);
    const live = fakeWc(false);
    const targets = new Set<WebContents>([dead, live]);
    broadcastToListeners(targets, 'ch', { ok: true });
    expect(live.send).toHaveBeenCalledWith('ch', { ok: true });
  });
});

// ── mergeAdapters ────────────────────────────────────────────────────────────

describe('mergeAdapters', () => {
  const buildAdapter = (id: string, label: string): Adapter =>
    ({ ...MINIMAL_CLI_PTY, id, label }) as Adapter;

  it('supplies verified Qwen CLI approval args when a user plugin omits them', () => {
    const qwen = { ...MINIMAL_CLI_PTY, id: 'qwen', bin: 'qwen' } as Adapter;
    const loaded = mergeAdapters([], [qwen]).get('qwen');
    expect(loaded?.kind === 'cli-pty' && loaded.control.permission?.yolo)
      .toEqual(['--yolo']);
    expect(qwen.kind === 'cli-pty' && qwen.control).toEqual({});
  });

  it('repairs legacy Kimi plugins and starts them in native automatic mode', () => {
    const kimi = {
      ...MINIMAL_CLI_PTY, id: 'kimi', bin: 'kimi',
      control: { permission: { modes: {}, default: '', yolo: ['--auto'] } },
    } as Adapter;
    const loaded = mergeAdapters([], [kimi]).get('kimi');
    expect(loaded?.kind === 'cli-pty' && buildControlArgs(loaded, {}))
      .toEqual(['--yolo']);
  });

  it('preserves explicit plugin approval sequences', () => {
    const qwen = {
      ...MINIMAL_CLI_PTY, id: 'qwen', bin: 'qwen',
      control: { permission: { modes: {}, default: '', yolo: ['-y'] } },
    } as Adapter;
    expect(mergeAdapters([], [qwen]).get('qwen')).toEqual(qwen);
  });

  it('does not guess approval flags for unrelated executables', () => {
    const custom = { ...MINIMAL_CLI_PTY, id: 'qwen', bin: 'custom-wrapper' } as Adapter;
    expect(mergeAdapters([], [custom]).get('qwen')).toEqual(custom);
  });

  it('user adapter with same id overrides builtin', () => {
    const builtin = buildAdapter('claude', 'Claude (builtin)');
    const user = buildAdapter('claude', 'Claude (custom)');
    const merged = mergeAdapters([builtin], [user]);
    expect(merged.get('claude')?.label).toBe('Claude (custom)');
  });

  it('user adapter with new id is added alongside builtins', () => {
    const builtin = buildAdapter('claude', 'Claude');
    const user = buildAdapter('my-cli', 'My CLI');
    const merged = mergeAdapters([builtin], [user]);
    expect(merged.size).toBe(2);
    expect(merged.has('my-cli')).toBe(true);
  });

  it('não carrega Gemini CLI builtin nem plugin; AGY permanece', () => {
    const agy = buildAdapter('agy', 'Antigravity');
    const gemini = buildAdapter('gemini', 'Gemini CLI');
    const geminiCli = buildAdapter('gemini-cli', 'Gemini CLI legacy');
    const renamedGemini = {
      ...buildAdapter('custom-google', 'Google assistant'),
      bin: 'C:\\Users\\operator\\bin\\gemini.cmd',
    } as Adapter;
    const merged = mergeAdapters(
      [agy],
      [gemini, geminiCli, renamedGemini],
    );

    expect(merged.has('agy')).toBe(true);
    expect(merged.has('gemini')).toBe(false);
    expect(merged.has('gemini-cli')).toBe(false);
    expect(merged.has('custom-google')).toBe(false);
  });

  it('empty user list returns only builtins', () => {
    const builtins = [buildAdapter('a', 'A'), buildAdapter('b', 'B')];
    const merged = mergeAdapters(builtins, []);
    expect(merged.size).toBe(2);
  });

  it('builtin-only ids are preserved when user has no conflicts', () => {
    const builtin = buildAdapter('codex', 'Codex');
    const user = buildAdapter('my-cli', 'My CLI');
    const merged = mergeAdapters([builtin], [user]);
    expect(merged.has('codex')).toBe(true);
  });
});

describe('authMethodForAdapter', () => {
  const buildAdapter = (id: string, label: string): Adapter =>
    ({ ...MINIMAL_CLI_PTY, id, label }) as Adapter;

  it('expõe o método declarado da CLI (oauth do claude, api_key do codex)', () => {
    expect(authMethodForAdapter(buildAdapter('claude', 'Claude'))).toBe(
      MINIMAL_CLI_PTY.auth.method,
    );
    const codex = {
      ...MINIMAL_CLI_PTY,
      id: 'codex',
      auth: { ...MINIMAL_CLI_PTY.auth, method: 'api_key' },
    } as Adapter;
    expect(authMethodForAdapter(codex)).toBe('api_key');
  });

  it('api-provider sempre declara api_key', () => {
    const provider = {
      kind: 'api-provider',
      id: 'glm',
      label: 'GLM',
      version: '1.0.0',
      icon: '🌐',
      endpoint: 'https://example.invalid/v1',
      protocol: 'openai-chat',
      auth: { method: 'api_key', header: 'x', scheme: 'y', envVar: 'Z', keychainKey: 'k' },
      models: { flag: '--model', list: ['m'], default: 'm' },
      streaming: true,
      quirks: {},
    } as unknown as Adapter;
    expect(authMethodForAdapter(provider)).toBe('api_key');
  });
});
