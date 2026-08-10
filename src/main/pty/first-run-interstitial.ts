/**
 * First-run interstitial responder — pure decision core (no Electron, no I/O).
 *
 * Some CLIs stop on a one-time screen BEFORE they ever reach their composer:
 * a workspace-trust question, a data-sharing consent gate, a migration offer.
 * A mission pane that lands on one of those sits mute until a human notices,
 * which is exactly the "mission that cannot start" failure mode.
 *
 * This module answers a CLOSED LIST of those screens. It is deliberately not a
 * general "press yes" machine, and the boundaries below are the product, not
 * decoration:
 *
 *  1. Mission panes only. A manual/operator terminal answers its own prompts
 *     (`context.missionId` absent → always `null`).
 *  2. Multi-signal match only. Every `requireAll` regex must be present and no
 *     `forbidAny` regex may be. One loose keyword never authorizes a keypress.
 *  3. A screen that grants filesystem authority (`directoryProof: 'cwd-match'`)
 *     is answered ONLY when the directory printed on screen IS the pane's own
 *     cwd — the workspace the operator picked when launching the mission. No
 *     confirmable path on screen → no answer.
 *  4. Answers come from `ALLOWED_ANSWERS` and nothing else. Exactly one entry
 *     in the table is affirmative (`1\r`, fenced by rule 3); every other entry
 *     dismisses with Esc, which cannot express consent to anything. Permission
 *     prompts, "run this command?" approvals, destructive confirmations, login
 *     screens and generic (y/N) questions are unreachable by construction —
 *     they simply have no entry here.
 *  5. One answer per pattern per session, inside `FIRST_RUN_WINDOW_MS` of
 *     spawn, and never once the pane has produced real agent work. This is
 *     also what keeps repo-authored text from replaying a screen at us later:
 *     by the time an agent is reading files, the responder is already closed.
 *
 * Adding a newly observed first-run screen is ONE entry in the table below.
 * Anything that needs new code is, by design, out of scope for this responder.
 */

/** Pick the first numbered option. The only affirmative keystroke that exists here. */
export const ANSWER_FIRST_NUMBERED_OPTION = '1\r';
/** Esc: dismiss/defer. Grants nothing, selects nothing, submits nothing. */
export const ANSWER_DISMISS = '\x1b';

/**
 * The complete set of keystrokes this responder may ever write into a PTY.
 * `decide` refuses any pattern whose answer is not in here, so a future table
 * entry cannot smuggle in a new affirmative without touching this line.
 */
export const ALLOWED_ANSWERS: ReadonlySet<string> = new Set([
  ANSWER_FIRST_NUMBERED_OPTION,
  ANSWER_DISMISS,
]);

export type DirectoryProof =
  /** Answer only when the screen prints the pane's own cwd. */
  | 'cwd-match'
  /** No directory authority is granted by the answer (Esc-style dismissal). */
  | 'none';

export interface FirstRunInterstitialPattern {
  /** Stable id used in logs and in the once-per-session ledger. */
  readonly name: string;
  /** CLIs known to show this screen. Empty means "any adapter". */
  readonly adapterIds: readonly string[];
  /** EVERY signal must be present on the normalized screen text. */
  readonly requireAll: readonly RegExp[];
  /** ANY of these present means the screen is not ours — never answer. */
  readonly forbidAny: readonly RegExp[];
  readonly answer: string;
  readonly directoryProof: DirectoryProof;
  /** Why this exact answer is safe. Kept next to the pattern on purpose. */
  readonly why: string;
}

/**
 * The closed list. Each entry was transcribed from the CLI that ships it, not
 * guessed: the Grok and Kimi strings come verbatim from their binaries, the
 * Claude trust wording from the live screen a mission stalled on.
 *
 * `forbidAny` also keeps this table disjoint from the boot-menu signatures in
 * `src/main/orch/cli-prompt-autoresponder.ts`, which watches the same PTY
 * stream. Two responders must never answer one screen.
 */
const PATTERNS: FirstRunInterstitialPattern[] = [
  {
    name: 'workspace-trust-directory-contents',
    // Claude Code 2.1.2xx replaced the older "files in this folder" copy.
    // Claude-family shells (glm/longcat) inherit the screen; grok ships a
    // folder-trust gate of its own whose older wording is already owned by
    // cli-prompt-autoresponder and is forbidden below.
    adapterIds: ['claude', 'glm', 'longcat', 'grok'],
    requireAll: [
      /do you trust the contents of this directory\?/,
      /higher risk of prompt injection/,
      /\b1\.\s*yes, continue\b/,
      /\b2\.\s*no, quit\b/,
    ],
    forbidAny: [
      // Owned by cli-prompt-autoresponder's own signatures.
      /grok build may run or modify contents in this directory/,
      /do you trust the files in this folder\?/,
      /quick safety check: is this a project/,
      /do you trust the contents of this project\?/,
      /claude code running in bypass permissions mode/,
    ],
    answer: ANSWER_FIRST_NUMBERED_OPTION,
    // The affirmative is confined to the directory the operator themselves
    // chose for this mission. Any other path on screen → no keypress.
    directoryProof: 'cwd-match',
    why:
      'Option 1 ("Yes, continue") trusts the mission workspace the operator ' +
      'already authorized at launch. Never blind-accept: option 2 quits.',
  },
  {
    name: 'grok-coding-data-consent',
    adapterIds: ['grok'],
    requireAll: [
      /help improve grok/,
      /off by default\. opt-in to allow/,
      /retain coding data/,
    ],
    forbidAny: [],
    // Esc leaves the setting at its own documented default (off). We decline
    // by declining to choose — opting IN on the operator's behalf would be a
    // consent we have no authority to give.
    answer: ANSWER_DISMISS,
    directoryProof: 'none',
    why:
      'Data-sharing consent gate. Esc dismisses without opting in; the ' +
      'screen states the setting is off by default and changeable later.',
  },
  {
    name: 'kimi-migrate-from-kimi-cli',
    adapterIds: ['kimi'],
    requireAll: [
      /migrate from kimi-cli/,
      /found an existing kimi-cli installation/,
      /migrate this data to kimi-code\?/,
    ],
    forbidAny: [],
    // The screen's own footer maps esc → "later". The highlighted option is
    // "Migrate now", so Enter would kick off a bulk data migration, and the
    // third option ("Never ask again") is a durable preference change — both
    // are the operator's call, not ours.
    answer: ANSWER_DISMISS,
    directoryProof: 'none',
    why:
      'One-time migration offer. Esc defers it ("later" per the screen\'s ' +
      'own footer) without migrating data or changing a stored preference.',
  },
];

export const FIRST_RUN_INTERSTITIAL_PATTERNS: readonly FirstRunInterstitialPattern[] =
  Object.freeze(PATTERNS);

/** Only the first N ms after spawn are watched; a first-run screen is immediate. */
export const FIRST_RUN_WINDOW_MS = 90_000;
/** Rolling window of decoded text kept per session. */
export const FIRST_RUN_BUFFER_CHARS = 4_096;

export interface FirstRunInterstitialContext {
  readonly adapterId: string;
  /** Absent → manual/operator pane. The responder stays silent. */
  readonly missionId?: string;
  /** The pane's own spawn cwd (main-owned, never sourced from screen text). */
  readonly cwd: string;
  /** Used to expand a `~`-abbreviated path printed by the CLI. */
  readonly homeDir?: string;
  readonly msSinceSpawn: number;
  /** Pattern names already answered for this session. */
  readonly answeredPatterns: readonly string[];
  /** True once the pane reported real agent work; the responder then closes. */
  readonly agentWorkObserved: boolean;
}

export interface FirstRunInterstitialDecision {
  readonly answer: string;
  readonly pattern: string;
}

// Box-drawing / block characters plus the ASCII pipe. TUI frames wrap a
// sentence across lines, so the borders must go before phrase matching or a
// signature would fail purely because the terminal was narrow.
const FRAME_CHARS = /[─-▟|]/g;

function stripFrame(text: string): string {
  return text.replace(FRAME_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/** Lowercased, frame-stripped, whitespace-collapsed — used for signal matching. */
export function normalizeScreenText(text: string): string {
  return stripFrame(text.toLowerCase());
}

// Paths keep their original case: POSIX filesystems are case-sensitive.
const POSIX_PATH_CANDIDATE = /(?:~|\/)[^\s"'`,;:()[\]{}<>]+/g;
const WINDOWS_PATH_CANDIDATE = /[A-Za-z]:[\\/][^\s"'`,;()[\]{}<>]*/g;
const TRAILING_NOISE = /[.,;:!?)\]}…]+$/;

function normalizePath(raw: string, homeDir?: string): string {
  let value = raw.trim().replace(TRAILING_NOISE, '');
  if (value.startsWith('~') && homeDir) {
    value = `${homeDir}${value.slice(1)}`;
  }
  value = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (value.length > 1) value = value.replace(/\/+$/, '');
  // Windows drive paths are case-insensitive; POSIX paths are not.
  return /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
}

/**
 * True when the screen prints the pane's own cwd. Deliberately an EQUALITY
 * check: a screen may name any directory it likes, but the only one we will
 * ever trust on the operator's behalf is the one they launched the mission in.
 */
export function screenNamesOwnCwd(
  screenText: string,
  cwd: string,
  homeDir?: string,
): boolean {
  if (!cwd.trim()) return false;
  const haystack = stripFrame(screenText);
  const target = normalizePath(cwd, homeDir);
  const candidates = [
    ...(haystack.match(POSIX_PATH_CANDIDATE) ?? []),
    ...(haystack.match(WINDOWS_PATH_CANDIDATE) ?? []),
  ];
  return candidates.some(
    (candidate) => normalizePath(candidate, homeDir) === target,
  );
}

function appliesToAdapter(
  pattern: FirstRunInterstitialPattern,
  adapterId: string,
): boolean {
  return (
    pattern.adapterIds.length === 0 || pattern.adapterIds.includes(adapterId)
  );
}

/** Patterns a given CLI can ever trigger — bounds the per-session ledger. */
export function patternsForAdapter(
  adapterId: string,
): readonly FirstRunInterstitialPattern[] {
  return FIRST_RUN_INTERSTITIAL_PATTERNS.filter((pattern) =>
    appliesToAdapter(pattern, adapterId),
  );
}

/**
 * The whole decision, as a pure function of decoded screen text plus context.
 * Returns `null` for everything that is not an exact, still-answerable,
 * mission-owned first-run screen — which is almost everything.
 */
export function decideFirstRunInterstitial(
  screenText: string,
  context: FirstRunInterstitialContext,
): FirstRunInterstitialDecision | null {
  // Boundary 1: mission panes only.
  if (!context.missionId?.trim()) return null;
  // Boundary 5: short window after spawn, and never over real agent work.
  if (context.msSinceSpawn < 0) return null;
  if (context.msSinceSpawn > FIRST_RUN_WINDOW_MS) return null;
  if (context.agentWorkObserved) return null;
  if (!screenText) return null;

  const normalized = normalizeScreenText(screenText);
  if (!normalized) return null;
  const answered = new Set(context.answeredPatterns);

  for (const pattern of FIRST_RUN_INTERSTITIAL_PATTERNS) {
    if (!appliesToAdapter(pattern, context.adapterId)) continue;
    // Boundary 5: at most one answer per pattern per session.
    if (answered.has(pattern.name)) continue;
    // Boundary 2: every signal, or nothing.
    if (!pattern.requireAll.every((re) => re.test(normalized))) continue;
    if (pattern.forbidAny.some((re) => re.test(normalized))) continue;
    // Boundary 3: an authority-granting answer needs the cwd proof.
    if (
      pattern.directoryProof === 'cwd-match' &&
      !screenNamesOwnCwd(screenText, context.cwd, context.homeDir)
    ) {
      continue;
    }
    // Boundary 4: the keystroke must be one this module declared.
    if (!ALLOWED_ANSWERS.has(pattern.answer)) continue;
    return { answer: pattern.answer, pattern: pattern.name };
  }
  return null;
}

interface WatchedSession {
  readonly adapterId: string;
  readonly missionId?: string;
  readonly cwd: string;
  readonly homeDir?: string;
  readonly boundAt: number;
  readonly applicable: number;
  readonly answered: Set<string>;
  buffer: string;
}

export interface FirstRunInterstitialBinding {
  readonly adapterId: string;
  /** Omit for non-mission panes; the responder will simply never fire. */
  readonly missionId?: string;
  readonly cwd: string;
  readonly homeDir?: string;
}

export interface FirstRunInterstitialObserveOptions {
  readonly now?: number;
  /** Wave-1 semantic status said the pane is working — stop watching. */
  readonly agentWorkObserved?: boolean;
}

/**
 * Per-session bookkeeping around `decideFirstRunInterstitial`: a rolling text
 * window (a screen arrives split across PTY chunks), the answered-pattern
 * ledger, and the spawn clock. Still free of Electron and of any I/O.
 */
export class FirstRunInterstitialResponder {
  readonly #sessions = new Map<string, WatchedSession>();
  readonly #enabled: () => boolean;

  /**
   * `enabled` is the operator's kill switch (Settings › Mission Driver). It is
   * injected rather than read here so this module keeps zero dependencies, and
   * it fails CLOSED: a settings read that throws can never authorize a
   * keypress.
   */
  constructor(enabled: () => boolean = () => true) {
    this.#enabled = enabled;
  }

  #isEnabled(sessionId: string): boolean {
    let enabled = false;
    try {
      enabled = this.#enabled();
    } catch {
      enabled = false;
    }
    if (!enabled) this.#sessions.delete(sessionId);
    return enabled;
  }

  bind(
    sessionId: string,
    binding: FirstRunInterstitialBinding,
    now = Date.now(),
  ): void {
    const applicable = patternsForAdapter(binding.adapterId).length;
    if (applicable === 0) return;
    this.#sessions.set(sessionId, {
      adapterId: binding.adapterId,
      ...(binding.missionId ? { missionId: binding.missionId } : {}),
      cwd: binding.cwd,
      ...(binding.homeDir ? { homeDir: binding.homeDir } : {}),
      boundAt: now,
      applicable,
      answered: new Set<string>(),
      buffer: '',
    });
  }

  /**
   * Cheap gate for the PTY tap: false means the caller can skip stripAnsi
   * entirely. Watching ends at the window, or once every applicable pattern
   * for this CLI has been answered.
   */
  isWatching(sessionId: string, now = Date.now()): boolean {
    // Map lookup first: the kill-switch read only runs for the few sessions
    // actually inside their post-spawn window, never for every PTY chunk.
    const watch = this.#sessions.get(sessionId);
    if (!watch) return false;
    if (!this.#isEnabled(sessionId)) return false;
    if (now - watch.boundAt > FIRST_RUN_WINDOW_MS) {
      this.#sessions.delete(sessionId);
      return false;
    }
    return watch.answered.size < watch.applicable;
  }

  /** Feed one ANSI-stripped chunk. Returns the keystrokes to send, or null. */
  observe(
    sessionId: string,
    plainChunk: string,
    options: FirstRunInterstitialObserveOptions = {},
  ): FirstRunInterstitialDecision | null {
    const now = options.now ?? Date.now();
    if (!this.isWatching(sessionId, now)) return null;
    const watch = this.#sessions.get(sessionId);
    if (!watch) return null;
    if (options.agentWorkObserved === true) {
      // Real agent work started: this pane is past its first-run screens.
      this.#sessions.delete(sessionId);
      return null;
    }
    watch.buffer = `${watch.buffer}${plainChunk}`.slice(
      -FIRST_RUN_BUFFER_CHARS,
    );
    const decision = decideFirstRunInterstitial(watch.buffer, {
      adapterId: watch.adapterId,
      ...(watch.missionId ? { missionId: watch.missionId } : {}),
      cwd: watch.cwd,
      ...(watch.homeDir ? { homeDir: watch.homeDir } : {}),
      msSinceSpawn: now - watch.boundAt,
      answeredPatterns: [...watch.answered],
      agentWorkObserved: false,
    });
    if (!decision) return null;
    watch.answered.add(decision.pattern);
    // The screen is consumed: drop it so its own text cannot re-trigger.
    watch.buffer = '';
    return decision;
  }

  /** Mission id bound to a session — used for the observability log line. */
  missionOf(sessionId: string): string | null {
    return this.#sessions.get(sessionId)?.missionId ?? null;
  }

  drop(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  clear(): void {
    this.#sessions.clear();
  }

  watchedCount(): number {
    return this.#sessions.size;
  }
}
