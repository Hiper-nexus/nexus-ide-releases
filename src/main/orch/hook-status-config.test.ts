import { describe, expect, it } from 'vitest';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import {
  GROK_STATUS_HOOKS_FILE,
  codexStatusHookArgs,
  grokStatusHooksDocument,
  mergeClaudeStatusHooks,
  mergeKimiStatusHooks,
} from './hook-status-config';
import { REGRESSION_HOOK_TIMEOUT_SECONDS } from './hook-regression-command';
import { isNexusHookText } from '../../vendor/emdash/hooks/hook-commands';

const MARKER = 'NEXUS_HOOK_STATUS';

/** The skill-gate entry shape hooks-gen.ts writes (must survive our merge). */
const SKILL_GATE_STOP = {
  hooks: [{ type: 'command', command: 'node "/home/x/.nexus/ephemeral/abc/nexus-gate.mjs" stop' }],
};
const USER_PROMPT_HOOK = {
  matcher: '*',
  hooks: [{ type: 'command', command: 'echo user-prompt' }],
};

describe('mergeClaudeStatusHooks (Claude JSON settings)', () => {
  it('adds start/notification/stop status hooks preserving gate + user hooks', () => {
    const merged = mergeClaudeStatusHooks({
      Stop: [SKILL_GATE_STOP],
      UserPromptSubmit: [USER_PROMPT_HOOK],
    });

    expect(Object.keys(merged).sort()).toEqual([
      'Notification',
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'Stop',
      'StopFailure',
      'UserPromptSubmit',
    ]);
    // F-734: StopFailure só tem o hook de status (a CLI ignora a saída dele).
    expect(merged.StopFailure).toHaveLength(1);
    // Skill-gate Stop entry intact, ours appended alongside: status +
    // portão de regressão (/hook/regression, resposta = saída do hook).
    expect(merged.Stop).toHaveLength(3);
    expect(merged.Stop![0]).toEqual(SKILL_GATE_STOP);
    const regression = (merged.Stop as Array<{
      hooks: Array<{ command: string; timeout?: number }>;
    }>)[2]!.hooks[0]!;
    expect(regression.command).toContain('$NEXUS_HOOK_REGRESSION_URL');
    expect(regression.command).not.toContain('/dev/null');
    expect(regression.command).toContain('|| true');
    expect(regression.timeout).toBe(REGRESSION_HOOK_TIMEOUT_SECONDS);
    // User hook intact, ours appended: status + conselho de delegação (C2).
    expect(merged.UserPromptSubmit![0]).toEqual(USER_PROMPT_HOOK);
    expect(merged.UserPromptSubmit).toHaveLength(3);
    expect(merged.Notification).toHaveLength(1);

    // PostToolUseFailure carrega o status hook padrão + o hook de triagem
    // (matcher Bash → POST /hook/triage, cuja RESPOSTA é o output do hook).
    const failure = merged.PostToolUseFailure as Array<{
      matcher?: string;
      hooks: Array<{ type: string; command: string; timeout?: number }>;
    }>;
    expect(failure).toHaveLength(2);
    const triage = failure.find((entry) => entry.matcher === 'Bash');
    expect(triage).toBeDefined();
    expect(triage!.hooks[0]!.command).toContain('$NEXUS_HOOK_TRIAGE_URL');
    expect(triage!.hooks[0]!.command).toContain(MARKER);
    expect(triage!.hooks[0]!.command).not.toContain('--output /dev/null');
    expect(triage!.hooks[0]!.command).toContain('|| true');

    // PreToolUse/Bash → portão de integração (/hook/integration, F-234).
    const preToolUse = merged.PreToolUse as Array<{
      matcher?: string;
      hooks: Array<{ type: string; command: string; timeout?: number }>;
    }>;
    const integration = preToolUse.find((entry) => entry.matcher === 'Bash');
    expect(integration).toBeDefined();
    expect(integration!.hooks[0]!.command).toContain('$NEXUS_HOOK_INTEGRATION_URL');
    expect(integration!.hooks[0]!.command).toContain(MARKER);
    expect(integration!.hooks[0]!.command).toContain('|| true');

    const serialized = JSON.stringify(merged);
    expect(serialized).toContain(MARKER);
    expect(serialized).toContain('$NEXUS_HOOK_URL');
    expect(serialized).toContain('$NEXUS_GATE_TOKEN');
    expect(serialized).not.toMatch(/127\.0\.0\.1:\d/);
  });

  it('is idempotent — a second spawn rewrite does not duplicate entries', () => {
    const once = mergeClaudeStatusHooks({ Stop: [SKILL_GATE_STOP] });
    const twice = mergeClaudeStatusHooks(once);

    expect(twice).toEqual(once);
    // 7 status hooks (claudeHookSpecs, com o StopFailure do F-734) + 1 hook de
    // triagem PostToolUseFailure + 1 hook de delegação UserPromptSubmit (C2)
    // + 1 portão de regressão Stop + 1 portão de integração PreToolUse/Bash
    // (F-234) + admissão física no Bash em plataformas POSIX.
    const commands = Object.values(twice)
      .flat()
      .flatMap((entry) => (entry as { hooks: Array<{ command: string }> }).hooks)
      .map((hook) => hook.command);
    expect(commands.filter(isNexusHookText)).toHaveLength(process.platform === 'win32' ? 11 : 12);
  });
});

describe('mergeClaudeStatusHooks — conselho de delegação (C2)', () => {
  it('UserPromptSubmit ganha o hook de delegação sem perder o de status, e é idempotente', () => {
    const once = mergeClaudeStatusHooks({});
    const twice = mergeClaudeStatusHooks(once);
    const commands = (twice.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((entry) => entry.hooks.map((hook) => hook.command));
    expect(commands.filter((c) => c.includes('NEXUS_HOOK_DELEGATE_URL'))).toHaveLength(1);
    expect(commands.some((c) => c.includes('NEXUS_HOOK_URL'))).toBe(true);
  });
});

describe('codexStatusHookArgs (Codex TOML -c overrides)', () => {
  function parseOverride(arg: string): Record<string, unknown> {
    // Re-parse exactly what Codex would: a dotted key + TOML value.
    return parseToml(arg) as Record<string, unknown>;
  }

  it('emits -c overrides for SessionStart/UserPromptSubmit/Stop/PermissionRequest', () => {
    const args = codexStatusHookArgs();
    const keys: string[] = [];
    for (let i = 0; i < args.length; i += 2) {
      expect(args[i]).toBe('-c');
      keys.push(args[i + 1]!.split('=')[0]!);
    }
    expect(keys).toEqual([
      'hooks.SessionStart',
      'hooks.UserPromptSubmit',
      'hooks.PreToolUse',
      'hooks.PostToolUse',
      'hooks.PostToolUseFailure',
      'hooks.Stop',
      'hooks.PermissionRequest',
    ]);
  });

  it('every override value is valid TOML carrying a marked, env-only command', () => {
    const args = codexStatusHookArgs();
    for (let i = 1; i < args.length; i += 2) {
      const parsed = parseOverride(args[i]!) as {
        hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
      };
      const [event, entries] = Object.entries(parsed.hooks)[0]!;
      expect(entries).toHaveLength(1);
      // UserPromptSubmit also carries the delegate hook, Stop the regression
      // gate and PreToolUse the integration gate (F-234); status is first.
      expect(entries[0]!.hooks).toHaveLength(
        event === 'UserPromptSubmit' || event === 'Stop' || event === 'PreToolUse' ? 2 : 1,
      );
      const [hook] = entries[0]!.hooks;
      expect(hook!.type).toBe('command');
      expect(hook!.command).toContain(MARKER);
      expect(hook!.command).toContain('$NEXUS_GATE_TOKEN');
      expect(hook!.command).toContain('$NEXUS_HOOK_URL');
      expect(hook!.command).toContain('|| true');
      expect(hook!.command).toContain('X-Nexus-Hook-Flavor: codex');
    }
  });

  it('UserPromptSubmit runs status and delegate in ONE array (a second -c with the same key would shadow it)', () => {
    const values = codexStatusHookArgs().filter(
      (arg, index) => index % 2 === 1 && arg.startsWith('hooks.UserPromptSubmit='),
    );
    expect(values).toHaveLength(1);
    const parsed = parseOverride(values[0]!) as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
    };
    const [status, delegate] = parsed.hooks.UserPromptSubmit[0]!.hooks.map((hook) => hook.command);
    expect(status).toContain('X-Nexus-Hook-Event: user-submit');
    // The delegate response IS the hook output (additionalContext): never discarded.
    expect(delegate).toContain('$NEXUS_HOOK_DELEGATE_URL');
    expect(delegate).not.toContain('/dev/null');
    expect(delegate).toContain(MARKER);
  });

  it('Stop runs status and the regression gate in ONE array', () => {
    const values = codexStatusHookArgs().filter(
      (arg, index) => index % 2 === 1 && arg.startsWith('hooks.Stop='),
    );
    expect(values).toHaveLength(1);
    const parsed = parseOverride(values[0]!) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    const [status, regression] = parsed.hooks.Stop[0]!.hooks.map((hook) => hook.command);
    expect(status).toContain('X-Nexus-Hook-Event: stop');
    expect(regression).toContain('$NEXUS_HOOK_REGRESSION_URL');
    expect(regression).not.toContain('/dev/null');
    expect(regression).toContain(MARKER);
  });

  it('PreToolUse runs status and the integration gate in ONE array (F-234)', () => {
    const values = codexStatusHookArgs().filter(
      (arg, index) => index % 2 === 1 && arg.startsWith('hooks.PreToolUse='),
    );
    expect(values).toHaveLength(1);
    const parsed = parseOverride(values[0]!) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const [status, integration] = parsed.hooks.PreToolUse[0]!.hooks.map((hook) => hook.command);
    expect(status).toContain('X-Nexus-Hook-Event: tool-use');
    expect(integration).toContain('$NEXUS_HOOK_INTEGRATION_URL');
    expect(integration).toContain(MARKER);
    expect(integration).toContain('|| true');
  });

  it('is deterministic — a second spawn produces identical argv (no accumulation)', () => {
    expect(codexStatusHookArgs()).toEqual(codexStatusHookArgs());
  });

  it('Stop pipes Codex stdin instead of a stub idle_prompt', () => {
    const args = codexStatusHookArgs();
    const stop = args.find(
      (arg, index) => index % 2 === 1 && arg.startsWith('hooks.Stop='),
    );
    expect(stop).toContain('-d @-');
    expect(stop).toContain('X-Nexus-Hook-Event: stop');
    expect(stop).not.toContain('idle_prompt');
  });
});

describe('mergeKimiStatusHooks (Kimi TOML flat array)', () => {
  it('merges marked entries into config.toml content, preserving user hooks', () => {
    const userEntry = { event: 'Stop', command: 'echo user-stop' };
    const merged = mergeKimiStatusHooks({ model: 'k2', hooks: [userEntry] });

    const hooks = merged.hooks as Array<{ event: string; command: string }>;
    expect(hooks[0]).toEqual(userEntry);
    expect(hooks.length).toBeGreaterThan(1);
    expect(merged.model).toBe('k2');
    // Round-trip through real TOML, the way the overlay writer persists it.
    const reparsed = parseToml(stringifyToml(merged)) as typeof merged;
    expect(isNexusHookText(JSON.stringify(reparsed))).toBe(true);
  });

  it('Stop também chama o portão de regressão', () => {
    const hooks = mergeKimiStatusHooks({}).hooks as Array<{ event: string; command: string }>;
    expect(hooks.some((hook) => hook.event === 'Stop' && hook.command.includes('$NEXUS_HOOK_REGRESSION_URL'))).toBe(true);
  });

  it('UserPromptSubmit também pede o contexto do motor ao /hook/delegate (F-802)', () => {
    const hooks = mergeKimiStatusHooks({}).hooks as Array<{ event: string; command: string }>;
    const prompt = hooks.filter((hook) => hook.event === 'UserPromptSubmit');
    expect(prompt.some((hook) => hook.command.includes('$NEXUS_HOOK_DELEGATE_URL'))).toBe(true);
    // O status (user-submit) continua ali: o delegate é entrada a mais, não troca.
    expect(prompt.some((hook) => hook.command.includes('X-Nexus-Hook-Event: user-submit'))).toBe(true);
    // O comando do delegate imprime a resposta (stdout vira a mensagem no Kimi).
    const delegate = prompt.find((hook) => hook.command.includes('$NEXUS_HOOK_DELEGATE_URL'))!;
    expect(delegate.command).not.toContain('--output /dev/null');
  });

  it('second spawn rewrite does not duplicate Nexus entries', () => {
    const once = mergeKimiStatusHooks({});
    const twice = mergeKimiStatusHooks(once);
    expect(twice).toEqual(once);
  });
});

describe('grokStatusHooksDocument (Grok hooks/nexus.json)', () => {
  it('builds the nested hooks document with marked commands', () => {
    const doc = grokStatusHooksDocument();
    const hooks = doc.hooks as Record<string, unknown[]>;

    expect(Object.keys(hooks)).toContain('SessionStart');
    expect(Object.keys(hooks)).toContain('Stop');
    const serialized = JSON.stringify(doc);
    expect(serialized).toContain(MARKER);
    expect(serialized).toContain('X-Nexus-Hook-Flavor: grok');
    expect(GROK_STATUS_HOOKS_FILE).toBe('nexus.json');
    expect(JSON.stringify(hooks.Stop)).toContain('$NEXUS_HOOK_REGRESSION_URL');
  });
});
