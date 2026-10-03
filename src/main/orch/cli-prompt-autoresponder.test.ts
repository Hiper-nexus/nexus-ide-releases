import { describe, expect, it } from 'vitest';
import {
  ACCEPT_DEFAULT_PROMPT_RESPONSE,
  ACCEPT_FIRST_OPTION_BY_NUMBER,
  ACCEPT_SECOND_OPTION_BY_NUMBER,
  ACCEPT_SECOND_PROMPT_RESPONSE,
  ACCEPT_SECOND_TRUST_OPTION_RESPONSE,
  BUILTIN_PROMPT_SIGNATURES,
  CliPromptAutoResponder,
  codexFolderAccessResponse,
  codexFolderTrustResponse,
  focusedMenuResponse,
  matchesPromptSignature,
} from './cli-prompt-autoresponder';
import { cpuTimeMs } from '../../test/cpu-time';

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

/** Devin CLI workspace trust — herdr `workspace_trust_prompt`. */
const DEVIN_TRUST_PROMPT = `
Do you trust the authors of this directory?

Devin can read, edit, and run commands here. Only continue
with untrusted content.

> Yes, trust this folder
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

  it('recognizes and accepts the Devin workspace trust prompt with Enter', () => {
    expect(
      matchesPromptSignature(DEVIN_TRUST_PROMPT, signature('devin-workspace-trust')),
    ).toBe(true);

    const responder = new CliPromptAutoResponder();
    responder.bind('session-devin', 'devin');
    expect(responder.observe('session-devin', DEVIN_TRUST_PROMPT)).toBe(
      ACCEPT_DEFAULT_PROMPT_RESPONSE,
    );
    expect(responder.observe('session-devin', DEVIN_TRUST_PROMPT)).toBeNull();
  });

  it('holds Devin injection on the trust banner before options finish painting', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-devin', 'devin');
    expect(
      responder.observe(
        'session-devin',
        'Do you trust the authors of this directory?\n',
      ),
    ).toBeNull();
    expect(responder.shouldDeferInjection('session-devin')).toBe(true);
    expect(responder.forceAcceptResponse('session-devin')).toEqual({
      response: ACCEPT_DEFAULT_PROMPT_RESPONSE,
    });
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

describe('MiMo startup permission prompt', () => {
  it('recognizes the exact official MiMo warning only for its own adapter', () => {
    const signature = BUILTIN_PROMPT_SIGNATURES.find(s => s.name === 'mimo-bypass-permissions');
    expect(signature).toBeDefined();
    const prompt = 'WARNING: Bypass Permissions mode\nMiMo Code will read, edit, and execute files\nNo, exit (recommended)\nYes, I accept the risks and want to skip permissions';
    expect(matchesPromptSignature(prompt, signature!)).toBe(true);
    expect(signature!.adapterIds).toEqual(['mimo-code']);
    expect(signature!.response).toBe(ACCEPT_SECOND_PROMPT_RESPONSE);
    expect(matchesPromptSignature('MiMo Code ready', signature!)).toBe(false);
  });

  it('forceAcceptResponse nunca age sobre o holdPhrase da migração — só o menu', () => {
    const writes: { sessionId: string; data: string }[] = [];
    const responder = new CliPromptAutoResponder(() => true, (fn) => fn());
    responder.setWriter((sessionId, data) => {
      writes.push({ sessionId, data });
      return undefined as void;
    });
    responder.bind('sess-mimo', 'mimo-code');
    // Só o banner da migração one-time: holdPhrase segura a injeção, mas o
    // menu ainda não existe — Down+Enter aqui entraria no stream da migração.
    responder.observe(
      'sess-mimo',
      'Performing one time database migration, may take a few minutes...\n' +
        '100% complete 1/1\nDatabase migration complete.\n',
    );
    expect(responder.shouldDeferInjection('sess-mimo')).toBe(true);
    expect(responder.forceAcceptResponse('sess-mimo')).toBeNull();
    expect(writes).toEqual([]);
  });

  it('isHoldingForBanner: só o banner da migração segura; o menu pintado ou a janela vencida liberam', () => {
    const responder = new CliPromptAutoResponder(() => true, (fn) => fn());
    responder.setWriter(() => undefined);
    const t0 = 1_000_000;
    responder.bind('sess-mimo', 'mimo-code', t0);
    responder.observe(
      'sess-mimo',
      'Performing one time database migration, may take a few minutes...\n',
      t0 + 10,
    );
    expect(responder.isHoldingForBanner('sess-mimo', t0 + 30_000)).toBe(true);
    // Janela de observação da assinatura vencida: nunca espera para sempre.
    expect(responder.isHoldingForBanner('sess-mimo', t0 + 181_000)).toBe(false);
    expect(responder.isHoldingForBanner('sess-unbound', t0 + 30_000)).toBe(false);
  });
});

// Tela real do Codex 0.157.1 (sonda de 28/09 com o perfil governado numa
// worktree): pasta marcada untrusted pelo próprio Nexus.
const CODEX_FOLDER_ACCESS = [
  '\x1b[1m Folder access\x1b[0m',
  ' C:\Users\op\AppData\Roaming\NexusIDE\project-runtime\wt\d6cf\t-2f6c',
  ' Config, hooks, and exec policies from untrusted folders stay disabled.',
  ' Trusted project folders can still contribute settings. Opening will not change saved trust.',
  '\x1b[36m› 1. Open restricted\x1b[0m',
  '  2. Quit',
  ' enter continue · esc quit',
].join('\n');

describe('Codex "Folder access" (F-666)', () => {
  it('abre restrito com Enter quando o cursor já está em "Open restricted"', () => {
    expect(codexFolderAccessResponse(CODEX_FOLDER_ACCESS)).toBe('\r');
    const responder = new CliPromptAutoResponder();
    responder.bind('session-codex', 'codex');
    expect(responder.observe('session-codex', CODEX_FOLDER_ACCESS)).toBe('\r');
  });

  it('nunca escolhe "Trust and continue": desce até "Open restricted"', () => {
    const withTrust = CODEX_FOLDER_ACCESS.replace(
      '\x1b[36m› 1. Open restricted\x1b[0m\n  2. Quit',
      '› 1. Trust and continue\n  2. Open restricted\n  3. Quit',
    );
    expect(codexFolderAccessResponse(withTrust)).toBe('\x1b[B\r');
  });

  it('sem "Open restricted" desenhado não responde', () => {
    expect(codexFolderAccessResponse(' Folder access\n› 1. Quit')).toBeNull();
  });

  it('segura o brief enquanto a tela está aberta', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-codex-hold', 'codex');
    responder.observe('session-codex-hold', ' Folder access\n');
    expect(responder.shouldDeferInjection('session-codex-hold')).toBe(true);
  });
});

// Tela real do Codex 0.157 no pane do operador (campo 29/09, hipergo, YOLO).
const CODEX_FOLDER_TRUST = [
  ' C:\\Users\\Administrador\\Documents\\Projetos\\hipergo',
  '              YOLO mode',
  ' Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.',
  ' Folders can run code automatically, even without a model request. Continue only if you trust these files.',
  ' Your decision will be saved.',
  '\x1b[7m› 1. Trust and continue\x1b[0m',
  '  2. Quit',
  ' enter continue · esc quit',
].join('\n');

describe('Codex "Trust this folder?" no pane do operador (F-681)', () => {
  it('pane não governado confia na pasta que o operador abriu', () => {
    expect(codexFolderTrustResponse(CODEX_FOLDER_TRUST)).toBe('\r');
    const responder = new CliPromptAutoResponder();
    responder.bind('session-codex-op', 'codex', Date.now(), { governed: false });
    expect(responder.observe('session-codex-op', CODEX_FOLDER_TRUST)).toBe('\r');
  });

  it('pane governado (ou sem informação) nunca confia sozinho', () => {
    const governed = new CliPromptAutoResponder();
    governed.bind('session-codex-gov', 'codex', Date.now(), { governed: true });
    expect(governed.observe('session-codex-gov', CODEX_FOLDER_TRUST)).toBeNull();
    const unknown = new CliPromptAutoResponder();
    unknown.bind('session-codex-unknown', 'codex');
    expect(unknown.observe('session-codex-unknown', CODEX_FOLDER_TRUST)).toBeNull();
  });

  it('o diálogo restrito do F-666 continua restrito mesmo no pane do operador', () => {
    const withTrust = CODEX_FOLDER_ACCESS.replace(
      '\x1b[36m› 1. Open restricted\x1b[0m\n  2. Quit',
      '› 1. Trust and continue\n  2. Open restricted\n  3. Quit',
    );
    expect(codexFolderTrustResponse(withTrust)).toBeNull();
    const responder = new CliPromptAutoResponder();
    responder.bind('session-codex-restricted', 'codex', Date.now(), { governed: false });
    expect(responder.observe('session-codex-restricted', withTrust)).toBe('\x1b[B\r');
  });
});

// Tela real do Claude Code (campo 29/09): sem números, cursor em "Yes".
const CLAUDE_BYPASS_UNNUMBERED = [
  ' WARNING: Claude Code running in Bypass Permissions mode',
  ' In Bypass Permissions mode, Claude Code will not ask for your approval',
  ' before running potentially dangerous commands.',
  ' https://code.claude.com/docs/en/security',
  '   No, exit',
  ' \x1b[36m❯ Yes, I accept\x1b[0m',
  ' Enter to confirm · Esc to cancel',
].join('\n');

describe('aviso de Bypass Permissions sem números (F-681)', () => {
  it('cursor já em "Yes, I accept": só Enter (nunca Seta, que voltava a "No, exit")', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-claude-bypass', 'claude');
    expect(responder.observe('session-claude-bypass', CLAUDE_BYPASS_UNNUMBERED)).toBe('\r');
  });

  it('cursor em "No, exit": desce uma e confirma', () => {
    const cursorOnNo = CLAUDE_BYPASS_UNNUMBERED
      .replace('   No, exit', ' ❯ No, exit')
      .replace('\x1b[36m❯ Yes, I accept\x1b[0m', '  Yes, I accept');
    const responder = new CliPromptAutoResponder();
    responder.bind('session-claude-bypass-no', 'claude');
    expect(responder.observe('session-claude-bypass-no', cursorOnNo)).toBe('\x1b[B\r');
  });

  it('sem cursor desenhado não chuta', () => {
    expect(
      focusedMenuResponse(
        CLAUDE_BYPASS_UNNUMBERED.replace('❯ ', '  '),
        'claude code running in bypass permissions mode',
        ['no, exit', 'yes, i accept'],
        'yes, i accept',
      ),
    ).toBeNull();
  });

  it('na tela nova só a assinatura sem números casa inteira (o aceite forçado prefere ela)', () => {
    const byName = (name: string) => BUILTIN_PROMPT_SIGNATURES.find((s) => s.name === name)!;
    expect(matchesPromptSignature(CLAUDE_BYPASS_UNNUMBERED, byName('claude-bypass-acknowledgement'))).toBe(false);
    expect(
      matchesPromptSignature(CLAUDE_BYPASS_UNNUMBERED, byName('claude-bypass-acknowledgement-unnumbered')),
    ).toBe(true);
  });
});

/**
 * F-764 C.3: as leituras de menu anteriores, só como referência — a regex
 * recomeçava em cada espaço de uma corrida (`[ \t]*`) e em cada `ESC ]` sem
 * BEL (`[^\x07]*`), quadrática em tela de TUI.
 */
const REFERENCE_CODEX_OPTION_RE =
  /(›|>)?[ \t]*(\d)\.[ \t]*(open restricted|trust and continue|open existing task|quit)/gi;
function referencePlain(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
}
function referenceFocusedMenu(raw: string, banner: string, labels: readonly string[], target: string): string | null {
  const plain = referencePlain(raw);
  const start = plain.toLowerCase().lastIndexOf(banner);
  if (start < 0) return null;
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`([❯›])?[ \\t]*(${escaped.join('|')})`, 'gi');
  const found: Array<{ label: string; focused: boolean }> = [];
  for (const match of plain.slice(start).matchAll(re)) {
    const label = match[2].toLowerCase();
    const seen = found.find((option) => option.label === label);
    if (seen) seen.focused ||= Boolean(match[1]);
    else found.push({ label, focused: Boolean(match[1]) });
  }
  if (found.length !== labels.length) return null;
  const targetIndex = found.findIndex((option) => option.label === target);
  const focusedIndexes = found.flatMap((option, index) => (option.focused ? [index] : []));
  if (targetIndex < 0 || focusedIndexes.length !== 1) return null;
  const delta = targetIndex - focusedIndexes[0]!;
  return (delta >= 0 ? '\x1b[B'.repeat(delta) : '\x1b[A'.repeat(-delta)) + '\r';
}
function referenceCodexOptions(raw: string, banner: string): string[] {
  const plain = referencePlain(raw);
  const start = plain.toLowerCase().lastIndexOf(banner);
  if (start < 0) return [];
  return [...plain.slice(start).matchAll(REFERENCE_CODEX_OPTION_RE)].map(
    (match) => `${match.index}:${match[1] ?? ''}:${match[2]}:${match[3]}`,
  );
}

describe('leitura de menu em tempo linear (F-764 C.3)', () => {
  const PIECES = [
    ' ', ' ', '\t', '›', '>', '❯', '1.', '2.', '3.', 'open restricted', 'trust and continue',
    'quit', 'no, exit', 'yes, i accept', 'Yes, I Accept', 'x', '\n', '\x1b]0;t', '\x07',
    '\x1b[1m', '\x1b]',
  ];
  let seed = 681;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const screen = (banner: string) => {
    let out = banner;
    const length = Math.floor(random() * 14);
    for (let i = 0; i < length; i += 1) out += PIECES[Math.floor(random() * PIECES.length)];
    return out;
  };
  const BYPASS = 'claude code running in bypass permissions mode';

  it('focusedMenuResponse responde igual à leitura anterior em 10 mil telas', () => {
    for (let round = 0; round < 10_000; round += 1) {
      const raw = screen(BYPASS);
      expect(
        focusedMenuResponse(raw, BYPASS, ['no, exit', 'yes, i accept'], 'yes, i accept'),
        JSON.stringify(raw),
      ).toBe(referenceFocusedMenu(raw, BYPASS, ['no, exit', 'yes, i accept'], 'yes, i accept'));
    }
  });

  it('as opções do Codex casam igual à leitura anterior em 10 mil telas', () => {
    for (let round = 0; round < 10_000; round += 1) {
      const access = screen('Folder access ');
      const trust = screen('Trust this folder? ');
      expect(codexFolderAccessResponse(access), JSON.stringify(access)).toBe(
        referenceCodexAccess(access),
      );
      expect(codexFolderTrustResponse(trust), JSON.stringify(trust)).toBe(
        referenceCodexTrust(trust),
      );
    }
  });

  function orderedResponse(options: string[], wanted: string): string | null {
    const byNumber = new Map<number, { focused: boolean; label: string }>();
    for (const option of options) {
      const [, cursor, number, label] = option.split(':');
      if (!byNumber.has(Number(number))) {
        byNumber.set(Number(number), { focused: Boolean(cursor), label: label.toLowerCase() });
      }
    }
    const ordered = [...byNumber.entries()].sort(([a], [b]) => a - b).map(([, option]) => option);
    const target = ordered.findIndex((option) => option.label === wanted);
    if (target < 0) return null;
    const focused = Math.max(0, ordered.findIndex((option) => option.focused));
    const delta = target - focused;
    return (delta >= 0 ? '\x1b[B'.repeat(delta) : '\x1b[A'.repeat(-delta)) + '\r';
  }
  function referenceCodexAccess(raw: string): string | null {
    return orderedResponse(referenceCodexOptions(raw, 'folder access'), 'open restricted');
  }
  function referenceCodexTrust(raw: string): string | null {
    const plain = referencePlain(raw);
    const start = plain.toLowerCase().lastIndexOf('trust this folder?');
    if (start < 0) return null;
    if (/open restricted|folder access/i.test(plain.slice(start))) return null;
    return orderedResponse(referenceCodexOptions(raw, 'trust this folder?'), 'trust and continue');
  }

  it.each([
    ['espaço sem quebra', ' '.repeat(16_384)],
    ['espaço e x no fim', `${' '.repeat(16_383)}x`],
    ['ESC ] sem BEL', '\x1b]'.repeat(8_192)],
  ])('%s: 16 KB em tempo linear', (_label, text) => {
    const run = () => {
      focusedMenuResponse(`${BYPASS}\n${text}`, BYPASS, ['no, exit', 'yes, i accept'], 'yes, i accept');
      codexFolderAccessResponse(`Folder access\n${text}`);
      codexFolderTrustResponse(`Trust this folder?\n${text}`);
    };
    // As três leituras somavam ~450 ms aqui antes da correção.
    expect(cpuTimeMs(run)).toBeLessThan(30);
  });
});
