import { describe, expect, it } from 'vitest';
import {
  ACCEPT_DEFAULT_PROMPT_RESPONSE,
  ACCEPT_FIRST_OPTION_BY_NUMBER,
  ACCEPT_SECOND_OPTION_BY_NUMBER,
  ACCEPT_SECOND_PROMPT_RESPONSE,
  ACCEPT_SECOND_TRUST_OPTION_RESPONSE,
  BUILTIN_PROMPT_SIGNATURES,
  CliPromptAutoResponder,
  matchesPromptSignature,
} from './cli-prompt-autoresponder';

const AGY_TRUST_PROMPT = `
Accessing workspace:

/Users/cleofasrocha/dev

Do you trust the contents of this project?

Antigravity CLI requires permission to read, edit, and execute files here

> Yes, I trust this folder
  No, exit
`;

const GROK_TRUST_PROMPT = `
Do you trust the contents of this directory?

Grok Build may run or modify contents in this directory, posing security risks.

> Yes, proceed
  No, exit
`;

/** Kimi Code 0.41/0.42 — transcrito ao vivo na primeira abertura numa pasta. */
const KIMI_TRUST_PROMPT = `
Trust this folder?
↑↓ navigate · Enter select · Esc exit

/private/tmp/kimi-trust-fresh-1

Project-level MCP servers are disabled until you explicitly choose Trust.
Trust starts the listed project MCP targets and remembers this folder.

 ❯ Trust this folder
   Enable project MCP servers. Remembered for this folder.

   Don't trust
   Exit Kimi Code. Asked again next launch.
`;

/** Live Claude Code 2.1.x UI (also used by GLM/Longcat) — no "Enter to confirm". */
const CLAUDE_BYPASS_PROMPT_21 = `
WARNING: Claude Code running in Bypass Permissions mode

In Bypass Permissions mode, Claude Code will not ask for your approval before
running potentially dangerous commands.
This mode should only be used in a sandboxed container/VM that has
restricted internet access and can easily be restored if damaged.

By proceeding, you accept all responsibility for actions taken
while running in Bypass Permissions mode.

https://code.claude.com/docs/en/security
› 1. No, exit
  2. Yes, I accept
`;

/** Older fixture that still included the footer — must keep matching. */
const CLAUDE_BYPASS_PROMPT_LEGACY = `
WARNING: Claude Code running in Bypass Permissions mode

In Bypass Permissions mode, Claude Code will not ask for your approval before
running potentially dangerous commands.

By proceeding, you accept all responsibility for actions taken while running
in Bypass Permissions mode.

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`;

/**
 * Claude Code workspace trust dialog (also GLM/LongCat). Isolated third-party
 * homes carry no per-project trust, so the first spawn per cwd shows this.
 * Option 1 is the safe accept — Down+Enter here would pick "No, exit".
 */
const CLAUDE_TRUST_PROMPT = `
Do you trust the files in this folder?

/Users/cleofasrocha/dev/radarbi

Claude Code may read files in this folder. Reading unknown files may lead to
malicious behavior. Claude will not execute commands without your approval.

› 1. Yes, proceed
  2. No, exit
`;

/** Claude Code 2.1.220 workspace trust copy observed in the physical E2E. */
const CLAUDE_TRUST_PROMPT_220 = `
Quick safety check: Is this a project you created or one you trust?

/tmp/nexus-final-e2e

› 1. Yes, I trust this folder
  2. No, exit
`;

/**
 * Claude Code 2.1.267, transcribed from a live PTY run (10/09) in a cwd that
 * was never trusted. Two things changed since 2.1.220 and both are fatal for a
 * fixed keystroke: the options lost their numbers, and the cursor now parks on
 * "No, exit" — so a bare Enter quits the CLI instead of trusting the folder.
 */
const CLAUDE_TRUST_PROMPT_21267 = `
────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /private/var/folders/zg/…/T/probe3-cwd-a3_o5mg5

 Quick safety check: Is this a project you created or one you trust? (Like
 your own code, a well-known open source project, or work from your team).
 If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

/** O mesmo diálogo num pane estreito, com as frases quebradas no meio. */
const CLAUDE_TRUST_PROMPT_21267_NARROW = `
 Quick safety check: Is this a project you created or one you trust? (Like
 your own code, a well-known open source project, or work from your team).
 If not, take a moment to review what's in this fo
 lder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exi
 t
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
`;

/** Same dialog, accept listed first — a build where Enter already accepts. */
const CLAUDE_TRUST_PROMPT_ACCEPT_FIRST = `
Quick safety check: Is this a project you created or one you trust?

/tmp/nexus-accept-first

 ❯ Yes, I trust this folder
   No, exit

 Enter to confirm · Esc to cancel
`;

function signature(name: string) {
  const found = BUILTIN_PROMPT_SIGNATURES.find((item) => item.name === name);
  if (!found) throw new Error(`missing signature ${name}`);
  return found;
}

describe('CLI prompt autoresponder', () => {
  it('has a fail-closed runtime kill switch that prevents every automatic keypress', () => {
    const responder = new CliPromptAutoResponder(() => false);
    responder.bind('session-glm', 'glm');

    expect(responder.isPending('session-glm')).toBe(false);
    expect(responder.observe('session-glm', CLAUDE_BYPASS_PROMPT_21)).toBeNull();
    expect(responder.shouldDeferInjection('session-glm')).toBe(false);
    expect(responder.forceAcceptResponse('session-glm')).toBeNull();
  });

  it('recognizes the Antigravity workspace trust prompt', () => {
    expect(
      matchesPromptSignature(AGY_TRUST_PROMPT, signature('agy-workspace-trust')),
    ).toBe(true);
  });

  it('recognizes the Grok folder trust prompt', () => {
    expect(
      matchesPromptSignature(GROK_TRUST_PROMPT, signature('grok-folder-trust')),
    ).toBe(true);
  });

  it('recognizes and accepts the Kimi folder trust prompt with Enter', () => {
    // Campo 09/09: o Kimi 0.42 para em "Trust this folder?" antes do composer;
    // sem resposta a pane fica muda e o prompt da missão é engolido pelo modal.
    expect(
      matchesPromptSignature(KIMI_TRUST_PROMPT, signature('kimi-folder-trust')),
    ).toBe(true);

    const responder = new CliPromptAutoResponder();
    responder.bind('session-kimi', 'kimi');
    expect(responder.observe('session-kimi', KIMI_TRUST_PROMPT)).toBe(
      ACCEPT_DEFAULT_PROMPT_RESPONSE,
    );
    expect(responder.observe('session-kimi', KIMI_TRUST_PROMPT)).toBeNull();
  });

  it('never answers the 2.1.267 trust dialog with the Enter that quits the CLI', () => {
    // Probe ao vivo (10/09): sem números e com o cursor parado em "No, exit",
    // o Enter sozinho encerra o processo (exit 1) e o `1\r` antigo é uma tecla
    // ignorada seguida desse mesmo Enter fatal. A resposta tem de MOVER o
    // cursor para o aceite.
    expect(
      matchesPromptSignature(
        CLAUDE_TRUST_PROMPT_21267,
        signature('claude-workspace-trust-quick-safety-check'),
      ),
    ).toBe(true);

    const responder = new CliPromptAutoResponder();
    responder.bind('session-claude', 'claude');
    const answer = responder.observe('session-claude', CLAUDE_TRUST_PROMPT_21267);
    expect(answer).toBe(ACCEPT_SECOND_TRUST_OPTION_RESPONSE);
    expect(answer).not.toBe(ACCEPT_DEFAULT_PROMPT_RESPONSE);
    expect(answer).not.toBe(ACCEPT_FIRST_OPTION_BY_NUMBER);
  });

  it('answers the same trust screen when a narrow pane shreds the wording', () => {
    // Pane estreito quebra a etiqueta no meio da palavra ("No, exi / t") — a
    // forma compacta é o que salva, e a decisão de tecla usa a mesma leitura.
    const responder = new CliPromptAutoResponder();
    responder.bind('session-claude', 'claude');
    expect(
      responder.observe('session-claude', CLAUDE_TRUST_PROMPT_21267_NARROW),
    ).toBe(ACCEPT_SECOND_TRUST_OPTION_RESPONSE);
  });

  it('keeps a bare Enter when the accept item is the one already focused', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-claude', 'claude');
    expect(
      responder.observe('session-claude', CLAUDE_TRUST_PROMPT_ACCEPT_FIRST),
    ).toBe(ACCEPT_DEFAULT_PROMPT_RESPONSE);
  });

  it('recognizes and accepts the Claude 2.1.x bypass acknowledgement (GLM shell)', () => {
    expect(
      matchesPromptSignature(
        CLAUDE_BYPASS_PROMPT_21,
        signature('claude-bypass-acknowledgement'),
      ),
    ).toBe(true);
    expect(
      matchesPromptSignature(
        CLAUDE_BYPASS_PROMPT_LEGACY,
        signature('claude-bypass-acknowledgement'),
      ),
    ).toBe(true);

    for (const adapterId of ['claude', 'glm', 'glm-flash', 'longcat'] as const) {
      const responder = new CliPromptAutoResponder();
      responder.bind(`session-${adapterId}`, adapterId);
      expect(responder.observe(`session-${adapterId}`, CLAUDE_BYPASS_PROMPT_21)).toBe(
        ACCEPT_SECOND_PROMPT_RESPONSE,
      );
      expect(responder.observe(`session-${adapterId}`, CLAUDE_BYPASS_PROMPT_21)).toBeNull();
    }
  });

  it('defers injection once the bypass banner is visible and after accept (GLM)', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-glm', 'glm');
    expect(responder.shouldDeferInjection('session-glm')).toBe(false);

    // Banner alone (options may still be painting) must hold mission inject.
    expect(
      responder.observe(
        'session-glm',
        'WARNING: Claude Code running in Bypass Permissions mode\n',
      ),
    ).toBeNull();
    expect(responder.shouldDeferInjection('session-glm')).toBe(true);

    expect(responder.observe('session-glm', CLAUDE_BYPASS_PROMPT_21)).toBe(
      ACCEPT_SECOND_PROMPT_RESPONSE,
    );
    expect(responder.shouldDeferInjection('session-glm')).toBe(true);
  });

  it('does not treat generic trust text as a supported CLI prompt', () => {
    expect(
      matchesPromptSignature(
        'Do you trust the contents of this project?',
        signature('agy-workspace-trust'),
      ),
    ).toBe(false);
  });

  it('accepts a prompt split across terminal chunks only once', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-1', 'agy');

    expect(
      responder.observe('session-1', AGY_TRUST_PROMPT.slice(0, 80)),
    ).toBeNull();
    expect(responder.observe('session-1', AGY_TRUST_PROMPT.slice(80))).toBe(
      ACCEPT_DEFAULT_PROMPT_RESPONSE,
    );
    expect(responder.observe('session-1', AGY_TRUST_PROMPT)).toBeNull();
  });

  it('uses adapter-specific prompt signatures', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-1', 'grok');

    expect(responder.observe('session-1', AGY_TRUST_PROMPT)).toBeNull();
    expect(responder.observe('session-1', GROK_TRUST_PROMPT)).toBe(
      ACCEPT_DEFAULT_PROMPT_RESPONSE,
    );
  });

  it('ignores sessions for adapters without a supported prompt signature', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-1', 'codex');

    expect(responder.observe('session-1', AGY_TRUST_PROMPT)).toBeNull();
  });

  it('stops watching after the boot window so long sessions do not stripAnsi forever', () => {
    const responder = new CliPromptAutoResponder();
    const t0 = 1_000_000;
    responder.bind('session-glm', 'glm', t0);
    expect(responder.isPending('session-glm', t0 + 1_000)).toBe(true);
    // F-529: trust pinta tarde em cold start — a janela do glm é a das
    // assinaturas de TRUST (60s), não o default de boot menu (20s).
    expect(responder.isPending('session-glm', t0 + 21_000)).toBe(true);
    // ... mas continua finita: sessão longa não paga stripAnsi para sempre.
    expect(responder.isPending('session-glm', t0 + 61_000)).toBe(false);
  });

  it('forceAcceptResponse dismisses a visible bypass menu for inject recovery', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-glm', 'glm');
    responder.observe(
      'session-glm',
      'WARNING: Claude Code running in Bypass Permissions mode\n',
    );
    expect(responder.shouldDeferInjection('session-glm')).toBe(true);
    expect(responder.forceAcceptResponse('session-glm')).toEqual({
      response: ACCEPT_SECOND_PROMPT_RESPONSE,
      fallbackResponse: ACCEPT_SECOND_OPTION_BY_NUMBER,
    });
    expect(responder.shouldDeferInjection('session-glm')).toBe(true);
  });

  it('recognizes and accepts the Claude-family workspace trust dialog', () => {
    expect(
      matchesPromptSignature(
        CLAUDE_TRUST_PROMPT,
        signature('claude-workspace-trust'),
      ),
    ).toBe(true);

    for (const adapterId of ['claude', 'glm', 'glm-flash', 'longcat'] as const) {
      const responder = new CliPromptAutoResponder();
      responder.bind(`session-${adapterId}`, adapterId);
      expect(responder.observe(`session-${adapterId}`, CLAUDE_TRUST_PROMPT)).toBe(
        ACCEPT_FIRST_OPTION_BY_NUMBER,
      );
      expect(responder.observe(`session-${adapterId}`, CLAUDE_TRUST_PROMPT)).toBeNull();
    }
  });

  it('recognizes the Claude 2.1.220 quick-safety trust dialog', () => {
    expect(
      matchesPromptSignature(
        CLAUDE_TRUST_PROMPT_220,
        signature('claude-workspace-trust-quick-safety-check'),
      ),
    ).toBe(true);

    for (const adapterId of ['claude', 'glm', 'glm-flash', 'longcat'] as const) {
      const responder = new CliPromptAutoResponder();
      responder.bind(`session-${adapterId}`, adapterId);
      // Nesta build o aceite é o item focado e vem listado primeiro: a tecla
      // derivada da tela é o Enter simples.
      expect(
        responder.observe(`session-${adapterId}`, CLAUDE_TRUST_PROMPT_220),
      ).toBe(ACCEPT_DEFAULT_PROMPT_RESPONSE);
      expect(
        responder.observe(`session-${adapterId}`, CLAUDE_TRUST_PROMPT_220),
      ).toBeNull();
    }
  });

  it('holds injection on the bare trust banner but never types a blind Enter', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-claude', 'claude');

    expect(
      responder.observe(
        'session-claude',
        'Quick safety check: Is this a project\n',
      ),
    ).toBeNull();
    expect(responder.shouldDeferInjection('session-claude')).toBe(true);
    // Sem as duas etiquetas na tela não há como saber qual item está focado, e
    // na 2.1.267 o Enter no item errado encerra o pane. Fail-closed: o
    // force-accept espera o diálogo pintar em vez de arriscar uma tecla.
    expect(responder.forceAcceptResponse('session-claude')).toBeNull();
  });

  it('defers injection on the trust banner and force-accepts with option 1 (never Down+Enter)', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-glm', 'glm');
    expect(
      responder.observe('session-glm', 'Do you trust the files in this folder?\n'),
    ).toBeNull();
    expect(responder.shouldDeferInjection('session-glm')).toBe(true);

    // Regression guard: the generic force-accept used to be Down+Enter, which
    // on this menu selects "No, exit" and kills the CLI session.
    expect(responder.forceAcceptResponse('session-glm')).toEqual({
      response: ACCEPT_FIRST_OPTION_BY_NUMBER,
    });
  });

  describe('F-529: resposta perdida na race do trust é reenviada', () => {
    function armHarness(prompt: string, adapterId = 'glm') {
      const writes: Array<{ sessionId: string; data: string }> = [];
      const timers: Array<() => void> = [];
      const responder = new CliPromptAutoResponder(
        () => true,
        (fn) => {
          timers.push(fn);
          return undefined as unknown as NodeJS.Timeout;
        },
      );
      responder.setWriter((sessionId, data) => writes.push({ sessionId, data }));
      responder.bind('session-op', adapterId);
      const response = responder.observe('session-op', prompt);
      return { responder, writes, timers, response };
    }

    it('pane do operador no trust 2.1.267: tecla perdida é reenviada até o teto, sem fallback inventado', () => {
      const { responder, writes, timers, response } = armHarness(
        CLAUDE_TRUST_PROMPT_21267,
      );
      expect(response).toBe(ACCEPT_SECOND_TRUST_OPTION_RESPONSE);
      expect(responder.isVerifying('session-op')).toBe(true);
      // O envio original é do caller (o tap do mcp-server) — o autoresponder
      // só digita os REENVIOS.
      expect(writes).toEqual([]);

      timers.pop()!(); // silêncio: 1º reenvio com a mesma tecla segura
      expect(writes.map((w) => w.data)).toEqual([
        ACCEPT_SECOND_TRUST_OPTION_RESPONSE,
      ]);
      timers.pop()!(); // ainda mudo: 2º reenvio
      expect(writes.map((w) => w.data)).toEqual([
        ACCEPT_SECOND_TRUST_OPTION_RESPONSE,
        ACCEPT_SECOND_TRUST_OPTION_RESPONSE,
      ]);
      timers.pop()!(); // esgotou: desiste e devolve o diálogo ao operador
      expect(writes.length).toBe(2);
      expect(responder.isVerifying('session-op')).toBe(false);
    });

    it('o repaint que prova o aceite encerra a verificação sem nenhum reenvio', () => {
      const { responder, writes, timers, response } = armHarness(
        CLAUDE_TRUST_PROMPT_21267,
      );
      expect(response).toBe(ACCEPT_SECOND_TRUST_OPTION_RESPONSE);
      // O TUI aceitou e repintou a tela home.
      responder.observe('session-op', ' Welcome to Claude Code!');
      expect(responder.isVerifying('session-op')).toBe(false);
      timers.pop()!(); // recheck agendado antes do repaint: estado já não existe
      expect(writes).toEqual([]);
    });

    it('a última tentativa usa o fallback numérico da assinatura (bypass 2.1.x)', () => {
      const { writes, timers, response } = armHarness(
        CLAUDE_BYPASS_PROMPT_21,
      );
      expect(response).toBe(ACCEPT_SECOND_PROMPT_RESPONSE);
      timers.pop()!();
      timers.pop()!();
      expect(writes.map((w) => w.data)).toEqual([
        ACCEPT_SECOND_PROMPT_RESPONSE,
        ACCEPT_SECOND_OPTION_BY_NUMBER,
      ]);
    });

    it('injeção de missão segue adiada enquanto a resposta aguarda prova', () => {
      const { responder } = armHarness(CLAUDE_TRUST_PROMPT_21267);
      expect(responder.shouldDeferInjection('session-op')).toBe(true);
      responder.observe('session-op', ' Welcome to Claude Code!');
      // Depois do aceite provado só resta o settle de 450ms (o TUI saindo do
      // menu); passado ele, a injeção segue.
      expect(
        responder.shouldDeferInjection('session-op', Date.now() + 2_000),
      ).toBe(false);
    });

    it('fechar o pane (drop) cancela a verificação e não digita mais nada', () => {
      const { responder, writes, timers } = armHarness(
        CLAUDE_TRUST_PROMPT_21267,
      );
      responder.drop('session-op');
      expect(responder.isVerifying('session-op')).toBe(false);
      timers.pop()!();
      expect(writes).toEqual([]);
    });
  });
});
