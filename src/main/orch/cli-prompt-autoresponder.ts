import { getOrchSettings } from '../persistence/settings-store';

const PROMPT_WINDOW = 4_096;
/** After auto-accepting a boot prompt, hold prompt injection briefly so the TUI can leave the menu. */
const SETTLE_AFTER_ACCEPT_MS = 450;
/**
 * Only watch the first N ms of a session for interactive boot menus. After that
 * we unbind: otherwise Claude-family panes with skipDangerous set would keep
 * stripAnsi on every PTY chunk for the whole mission.
 */
const WATCH_WINDOW_MS = 20_000;

interface PromptSignature {
  adapterIds: readonly string[];
  name: string;
  phrases: readonly string[];
  response: string;
  /**
   * Sent ~120ms after `response` by the force-accept path when a TUI build
   * ignores the primary keys. Must select the SAME option as `response`.
   */
  fallbackResponse?: string;
  /**
   * Banner-only hold: start deferring injection as soon as this phrase is
   * visible, before the menu options finish painting.
   */
  earlyPhrase?: string;
}

export const ACCEPT_DEFAULT_PROMPT_RESPONSE = '\r';
/** Move from the safe first option to the explicit second option, then enter. */
export const ACCEPT_SECOND_PROMPT_RESPONSE = '\x1b[B\r';
/** Fallback when Down+Enter is ignored (some Claude Code TUI builds). */
export const ACCEPT_SECOND_OPTION_BY_NUMBER = '2\r';
/** Pick the first numbered option explicitly (Claude-family workspace trust). */
export const ACCEPT_FIRST_OPTION_BY_NUMBER = '1\r';

/**
 * Claude Code 2.1.x (and Claude-family shells: glm/longcat) show this disclaimer
 * whenever full-auto / bypass is enabled. The live UI no longer always prints
 * "Enter to confirm" — matching on that phrase left GLM workers stuck forever.
 */
export const BUILTIN_PROMPT_SIGNATURES: readonly PromptSignature[] = [
  {
    adapterIds: ['claude', 'glm', 'longcat'],
    name: 'claude-bypass-acknowledgement',
    phrases: [
      'claude code running in bypass permissions mode',
      '1. no, exit',
      '2. yes, i accept',
    ],
    response: ACCEPT_SECOND_PROMPT_RESPONSE,
    fallbackResponse: ACCEPT_SECOND_OPTION_BY_NUMBER,
    earlyPhrase: 'claude code running in bypass permissions mode',
  },
  {
    // Claude-family workspace trust ("Do you trust the files in this
    // folder?"). Isolated third-party homes (GLM/LongCat under
    // ~/.nexus/homes/<id>) carry no per-project trust, so the FIRST spawn in
    // every project cwd hits this dialog; unanswered it stays up forever and
    // the mission/review brief is pasted into the modal and swallowed.
    // Option 1 is "Yes, proceed" — never force the default-accept here:
    // Down+Enter would pick "No, exit" and kill the session.
    adapterIds: ['claude', 'glm', 'longcat'],
    name: 'claude-workspace-trust',
    phrases: [
      'do you trust the files in this folder?',
      'yes, proceed',
      'no, exit',
    ],
    response: ACCEPT_FIRST_OPTION_BY_NUMBER,
    earlyPhrase: 'do you trust the files in this folder?',
  },
  {
    // Claude Code 2.1.220 replaced the legacy folder-trust copy above. Keep a
    // separate exact signature so future wording changes fail closed instead
    // of turning generic terminal text into an automatic keypress.
    adapterIds: ['claude', 'glm', 'longcat'],
    name: 'claude-workspace-trust-quick-safety-check',
    phrases: [
      'quick safety check: is this a project you created or one you trust?',
      'yes, i trust this folder',
      'no, exit',
    ],
    response: ACCEPT_FIRST_OPTION_BY_NUMBER,
    earlyPhrase: 'quick safety check: is this a project',
  },
  {
    adapterIds: ['agy'],
    name: 'agy-workspace-trust',
    phrases: [
      'do you trust the contents of this project?',
      'antigravity cli requires permission to read, edit, and execute files here',
      'yes, i trust this folder',
    ],
    response: ACCEPT_DEFAULT_PROMPT_RESPONSE,
  },
  {
    adapterIds: ['grok'],
    name: 'grok-folder-trust',
    phrases: [
      'do you trust the contents of this directory?',
      'grok build may run or modify contents in this directory',
      'yes, proceed',
    ],
    response: ACCEPT_DEFAULT_PROMPT_RESPONSE,
  },
];

function normalizePromptText(output: string): string {
  return output.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Pane estreito quebra a frase no MEIO da palavra e intercala a moldura do
 * TUI ("is this a --project you created" no voo real de 19/08) — o include
 * contíguo nunca casa e o trust fica na tela pra sempre. A forma compacta
 * (só [a-z0-9?]) sobrevive a qualquer wrap/borda mantendo a ordem.
 */
function compactPromptText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9?]/g, '');
}

export function matchesPromptSignature(
  output: string,
  signature: PromptSignature,
): boolean {
  const normalized = normalizePromptText(output);
  if (signature.phrases.every((phrase) => normalized.includes(phrase))) {
    return true;
  }
  const compact = compactPromptText(output);
  return signature.phrases.every((phrase) =>
    compact.includes(compactPromptText(phrase)),
  );
}

function signaturesFor(adapterId: string): PromptSignature[] {
  return BUILTIN_PROMPT_SIGNATURES.filter((signature) =>
    signature.adapterIds.includes(adapterId),
  );
}

export class CliPromptAutoResponder {
  private readonly buffers = new Map<string, string>();
  private readonly sessions = new Map<string, PromptSignature[]>();
  private readonly settlingUntil = new Map<string, number>();
  private readonly boundAt = new Map<string, number>();

  constructor(private readonly enabled: () => boolean = () => true) {}

  private isEnabled(sessionId?: string): boolean {
    let enabled = false;
    try {
      enabled = this.enabled();
    } catch {
      // A broken settings read can never authorize an automatic keypress.
      enabled = false;
    }
    if (!enabled && sessionId) this.drop(sessionId);
    return enabled;
  }

  bind(sessionId: string, adapterId: string, now = Date.now()): void {
    if (!this.isEnabled(sessionId)) return;
    const signatures = signaturesFor(adapterId);
    if (signatures.length === 0) return;
    this.sessions.set(sessionId, signatures);
    this.boundAt.set(sessionId, now);
    this.buffers.delete(sessionId);
    this.settlingUntil.delete(sessionId);
  }

  unbind(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.buffers.delete(sessionId);
    this.boundAt.delete(sessionId);
    // Intentionally keep settlingUntil so post-accept inject hold still works.
  }

  /** Drop every per-session map, including settle (session exit / shutdown). */
  drop(sessionId: string): void {
    this.unbind(sessionId);
    this.settlingUntil.delete(sessionId);
  }

  /** True while we are still watching PTY output for a known boot prompt. */
  isPending(sessionId: string, now = Date.now()): boolean {
    if (!this.isEnabled(sessionId)) return false;
    return this.watchingSignatures(sessionId, now) !== null;
  }

  private watchingSignatures(
    sessionId: string,
    now: number,
  ): PromptSignature[] | null {
    const signatures = this.sessions.get(sessionId);
    if (!signatures) return null;
    const started = this.boundAt.get(sessionId) ?? now;
    if (now - started > WATCH_WINDOW_MS) {
      this.unbind(sessionId);
      return null;
    }
    return signatures;
  }

  /**
   * The signature currently holding injection: full phrase match, or early
   * hold as soon as a known banner is visible (options may still be painting).
   */
  private pendingMatch(
    sessionId: string,
    now: number,
  ): PromptSignature | null {
    const signatures = this.watchingSignatures(sessionId, now);
    if (!signatures) return null;
    const raw = this.buffers.get(sessionId) ?? '';
    const buffer = normalizePromptText(raw);
    if (!buffer) return null;
    const compact = compactPromptText(raw);
    return (
      signatures.find(
        (signature) =>
          matchesPromptSignature(raw, signature) ||
          (signature.earlyPhrase !== undefined &&
            (buffer.includes(signature.earlyPhrase) ||
              compact.includes(compactPromptText(signature.earlyPhrase)))),
      ) ?? null
    );
  }

  /**
   * Hold nexus prompt injection while a known interactive boot menu is on
   * screen or we just auto-accepted one (TUI still leaving the dialog).
   */
  shouldDeferInjection(sessionId: string, now = Date.now()): boolean {
    if (!this.isEnabled(sessionId)) return false;
    const settleUntil = this.settlingUntil.get(sessionId);
    if (settleUntil !== undefined) {
      if (now < settleUntil) return true;
      this.settlingUntil.delete(sessionId);
    }
    return this.pendingMatch(sessionId, now) !== null;
  }

  /**
   * Keys to force-dismiss a still-visible boot menu when the normal observe
   * path did not fire before inject timeout. Returns the matched signature's
   * own response (plus its same-option fallback) — never a blind Down+Enter,
   * which picks "No, exit" on menus whose safe option is the first one.
   */
  forceAcceptResponse(
    sessionId: string,
    now = Date.now(),
  ): { response: string; fallbackResponse?: string } | null {
    if (!this.isEnabled(sessionId)) return null;
    const match = this.pendingMatch(sessionId, now);
    if (!match) return null;
    // Settle so callers wait before typing the mission brief.
    this.unbind(sessionId);
    this.settlingUntil.set(sessionId, now + SETTLE_AFTER_ACCEPT_MS);
    return {
      response: match.response,
      ...(match.fallbackResponse !== undefined
        ? { fallbackResponse: match.fallbackResponse }
        : {}),
    };
  }

  clear(): void {
    this.sessions.clear();
    this.buffers.clear();
    this.settlingUntil.clear();
    this.boundAt.clear();
  }

  observe(sessionId: string, output: string, now = Date.now()): string | null {
    if (!this.isEnabled(sessionId)) return null;
    const signatures = this.watchingSignatures(sessionId, now);
    if (!signatures) return null;
    const buffer = `${this.buffers.get(sessionId) ?? ''}${output}`.slice(
      -PROMPT_WINDOW,
    );
    const match = signatures.find((signature) =>
      matchesPromptSignature(buffer, signature),
    );
    if (!match) {
      this.buffers.set(sessionId, buffer);
      return null;
    }
    this.unbind(sessionId);
    this.settlingUntil.set(sessionId, now + SETTLE_AFTER_ACCEPT_MS);
    return match.response;
  }
}

/** Process-wide instance shared by MCP spawn decoration and prompt injection. */
export const cliPromptAutoResponder = new CliPromptAutoResponder(
  () => getOrchSettings().cliPromptAutoResponderEnabled,
);
