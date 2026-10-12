import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebContents } from 'electron';
import type { PaneActivitySummary } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { claudeProjectSlug } from '../usage/claude-transcript';
import { parseCodexLine } from '../usage/codex-transcript';
import { managedHomePath } from '../adapters/managed-credentials';
import { getProviderPaneSession } from '../persistence/provider-session-store';
import {
  findPaneOwnedBy,
  readSessionOutput,
  sessionOutputExitedAt,
  stripAnsi,
} from './pane-registry';

/**
 * Zero-LLM pane activity summary (peer ADE v1.2 harvest): given a persisted
 * pane, resolve "what it was doing" from local artifacts only —
 *   1. title:    first real user message of the CLI's native transcript;
 *   2. lastLine: last significant output line (live PTY tail preferred, last
 *      transcript entry as fallback for dead sessions);
 *   3. stoppedAt: transcript mtime (or the retained buffer's exit time).
 *
 * Robustness rules (third-party formats change without notice):
 *   - reads are capped (head/tail windows, never the whole transcript);
 *   - every failure degrades to a `none` summary — never throws;
 *   - flavors without a readable local transcript (kimi/grok/gemini today)
 *     resolve to `none` instead of guessing.
 */

export const PANE_ACTIVITY_HEAD_BYTES = 96 * 1024;
export const PANE_ACTIVITY_HEAD_LINES = 200;
export const PANE_ACTIVITY_TAIL_BYTES = 48 * 1024;
export const PANE_ACTIVITY_LINE_CAP = 140;
export const PANE_ACTIVITY_CACHE_TTL_MS = 30_000;

const EMPTY_SUMMARY: PaneActivitySummary = {
  title: null,
  lastLine: null,
  stoppedAt: null,
  source: 'none',
};

/* ------------------------------------------------------------------ *
 * Line significance: strip ANSI, drop spinner / box-drawing / empty.  *
 * ------------------------------------------------------------------ */

// Braille/blocks spinners and box-drawing runs carry no meaning on a card.
const EDGE_NOISE = /^[\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒|/\\─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬▀▄█▌▐░▒▓<>+-]+/;
const EDGE_NOISE_END = /[\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒|/\\─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬▀▄█▌▐░▒▓]+$/;

/** Sanitize one output line for card display; null when it carries no text. */
export function sanitizeActivityLine(
  raw: string,
  cap = PANE_ACTIVITY_LINE_CAP,
): string | null {
  const plain = stripAnsi(raw).replace(/\s+/g, ' ').trim();
  if (!plain) return null;
  const text = plain.replace(EDGE_NOISE, '').replace(EDGE_NOISE_END, '').trim();
  if (!text) return null;
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

/** Last meaningful line of a plain-text output dump (tail of pane/transcript). */
export function lastSignificantLine(
  text: string,
  cap = PANE_ACTIVITY_LINE_CAP,
): string | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const clean = sanitizeActivityLine(lines[i] ?? '', cap);
    if (clean) return clean;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Transcript line parsers (Claude Code / Codex JSONL).                 *
 * ------------------------------------------------------------------ */

export type TranscriptFlavor = 'claude' | 'codex';

/**
 * Claude-family adapters run the `claude` binary (mcpAutoload) and therefore
 * write Claude-shaped transcripts — native `claude` plus third-party family
 * (GLM/LongCat) in isolated homes. Plugin adapters we cannot classify return
 * null (summary degrades to `none`).
 */
export function classifyTranscriptFlavor(
  adapterId: string,
): TranscriptFlavor | null {
  if (adapterId === 'codex') return 'codex';
  for (const raw of BUILTIN_ADAPTERS) {
    const adapter = raw as {
      id?: unknown;
      quirks?: { mcpAutoload?: unknown };
    };
    if (adapter?.id === adapterId) {
      return adapter.quirks?.mcpAutoload === true ? 'claude' : null;
    }
  }
  return null;
}

/**
 * CLI wrappers (slash-command expansions, environment context, injected
 * instructions) are XML-ish; a real first user message essentially never
 * leads with `<`. Heuristic documented — worst case we skip one odd message.
 */
function isWrapperUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('<') || trimmed.startsWith('Caveat:');
}

function parseJsonlLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as unknown;
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as Record<string, unknown>;
  } catch {
    return null;
  }
}

function textFromContentItems(content: unknown, textTypes: Set<string>): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as { type?: unknown; text?: unknown };
    if (
      typeof entry.type === 'string' &&
      textTypes.has(entry.type) &&
      typeof entry.text === 'string'
    ) {
      parts.push(entry.text);
    }
  }
  return parts.join(' ').trim();
}

/** First real user message of a Claude transcript line; null when not one. */
export function extractClaudeFirstUserMessage(line: string): string | null {
  const obj = parseJsonlLine(line);
  if (!obj || obj.type !== 'user' || obj.isSidechain === true) return null;
  const message = obj.message as { content?: unknown } | undefined;
  // tool_result-only user entries yield no text and are skipped naturally.
  const text = textFromContentItems(message?.content, new Set(['text']));
  if (!text || isWrapperUserText(text)) return null;
  return text;
}

/** Visible text of a Claude transcript line (user or assistant), if any. */
export function extractClaudeEntryText(line: string): string | null {
  const obj = parseJsonlLine(line);
  if (!obj || (obj.type !== 'user' && obj.type !== 'assistant')) return null;
  if (obj.isSidechain === true) return null;
  const message = obj.message as { content?: unknown } | undefined;
  const text = textFromContentItems(message?.content, new Set(['text']));
  if (!text || isWrapperUserText(text)) return null;
  return text;
}

function codexMessageText(
  obj: Record<string, unknown>,
  role: 'user' | 'assistant',
): string {
  if (obj.type !== 'response_item') return '';
  const payload = obj.payload as
    | { type?: unknown; role?: unknown; content?: unknown }
    | undefined;
  if (payload?.type !== 'message' || payload.role !== role) return '';
  // user → input_text; assistant → output_text; accept generic text too.
  return textFromContentItems(
    payload.content,
    new Set(['input_text', 'output_text', 'text']),
  );
}

/** First real user message of a Codex rollout line; null when not one. */
export function extractCodexFirstUserMessage(line: string): string | null {
  const obj = parseJsonlLine(line);
  if (!obj) return null;
  const text = codexMessageText(obj, 'user');
  // session_meta / environment_context / user_instructions are not prompts.
  if (!text || isWrapperUserText(text)) return null;
  return text;
}

/** Visible text of a Codex rollout line (user or assistant), if any. */
export function extractCodexEntryText(line: string): string | null {
  const obj = parseJsonlLine(line);
  if (!obj) return null;
  const text = codexMessageText(obj, 'assistant') || codexMessageText(obj, 'user');
  if (!text || isWrapperUserText(text)) return null;
  return text;
}

/* ------------------------------------------------------------------ *
 * Bounded file reads.                                                  *
 * ------------------------------------------------------------------ */

function statMtime(file: string): number | null {
  try {
    return Math.round(fs.statSync(file).mtimeMs);
  } catch {
    return null;
  }
}

function statHit(file: string): { file: string; mtimeMs: number } | null {
  const mtimeMs = statMtime(file);
  return mtimeMs === null ? null : { file, mtimeMs };
}

/** Read up to `maxBytes` from the file head; '' on any failure. */
export function readFileHead(
  file: string,
  maxBytes = PANE_ACTIVITY_HEAD_BYTES,
): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = Math.min(fs.fstatSync(fd).size, maxBytes);
    if (size <= 0) return '';
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    return buffer.toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
  }
}

/** Read up to `maxBytes` from the file tail; '' on any failure. */
export function readFileTail(
  file: string,
  maxBytes = PANE_ACTIVITY_TAIL_BYTES,
): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return '';
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Transcript file resolution per flavor.                               *
 * ------------------------------------------------------------------ */

interface TranscriptHit {
  file: string;
  mtimeMs: number;
}

const MAX_DIR_ENTRIES = 256;

function newestJsonlInDir(dir: string): TranscriptHit | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir).slice(0, MAX_DIR_ENTRIES);
  } catch {
    return null;
  }
  let best: TranscriptHit | null = null;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const hit = statHit(path.join(dir, name));
    if (hit && (!best || hit.mtimeMs > best.mtimeMs)) best = hit;
  }
  return best;
}

/** Live gated workers run in ~/.nexus/ephemeral/<token>/.claude (purged on exit). */
function ephemeralClaudeRoots(home: string): string[] {
  const base = path.join(home, '.nexus', 'ephemeral');
  let names: string[];
  try {
    names = fs.readdirSync(base).slice(0, MAX_DIR_ENTRIES);
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const name of names) {
    const candidate = path.join(base, name, '.claude');
    try {
      if (fs.statSync(candidate).isDirectory()) roots.push(candidate);
    } catch {
      // not a directory — skip
    }
  }
  return roots;
}

function claudeRoots(home: string, adapterId: string): string[] {
  const roots = [path.join(home, '.claude')];
  if (adapterId !== 'claude') {
    // Third-party Claude family (GLM/LongCat): persistent isolated home.
    roots.push(path.join(home, '.nexus', 'homes', adapterId, '.claude'));
  }
  roots.push(...ephemeralClaudeRoots(home));
  return roots;
}

function resolveClaudeTranscript(options: {
  home: string;
  adapterId: string;
  cwd?: string;
  sessionId?: string;
  transcriptPath?: string;
}): TranscriptHit | null {
  // The hook-captured path is authoritative (recent Claude Code names the
  // transcript with a UUID that differs from the hook session_id).
  if (options.transcriptPath) {
    const hit = statHit(options.transcriptPath);
    if (hit) return hit;
  }
  if (!options.cwd) return null;
  const slug = claudeProjectSlug(options.cwd);
  const roots = claudeRoots(options.home, options.adapterId);
  if (options.sessionId) {
    for (const root of roots) {
      const hit = statHit(
        path.join(root, 'projects', slug, `${options.sessionId}.jsonl`),
      );
      if (hit) return hit;
    }
  }
  // Fallback: newest transcript of this cwd across every candidate home.
  // Ambiguous when several panes share a cwd — best effort, documented.
  let best: TranscriptHit | null = null;
  for (const root of roots) {
    const hit = newestJsonlInDir(path.join(root, 'projects', slug));
    if (hit && (!best || hit.mtimeMs > best.mtimeMs)) best = hit;
  }
  return best;
}

/**
 * F-1418: transcript EXATO de uma sessão Claude (caminho do hook ou
 * `<root>/projects/<slug>/<sessionId>.jsonl`) — sem o fallback "mais novo do
 * cwd", que atribuiria a conversa de outro pane. Usado como prova de pedido.
 */
export function resolveExactClaudeTranscriptPath(options: {
  home: string;
  adapterId: string;
  cwd?: string;
  sessionId?: string;
  transcriptPath?: string;
}): string | null {
  if (options.transcriptPath) {
    const hit = statHit(options.transcriptPath);
    if (hit) return hit.file;
  }
  if (!options.cwd || !options.sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(options.sessionId)) {
    return null;
  }
  const slug = claudeProjectSlug(options.cwd);
  for (const root of claudeRoots(options.home, options.adapterId)) {
    const hit = statHit(path.join(root, 'projects', slug, `${options.sessionId}.jsonl`));
    if (hit) return hit.file;
  }
  return null;
}

const CODEX_MAX_DAY_DIRS = 14;
const CODEX_HEAD_PROBE_FILES = 5;

/** Date-partitioned rollout dirs (sessions/YYYY/MM/DD), newest first. */
function codexDayDirs(sessionsRoot: string, max = CODEX_MAX_DAY_DIRS): string[] {
  const readSortedDesc = (dir: string): string[] => {
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => /^\d{2,4}$/.test(name))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  const out: string[] = [];
  for (const year of readSortedDesc(sessionsRoot)) {
    const yearDir = path.join(sessionsRoot, year);
    for (const month of readSortedDesc(yearDir)) {
      const monthDir = path.join(yearDir, month);
      for (const day of readSortedDesc(monthDir)) {
        out.push(path.join(monthDir, day));
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

function findCodexRollout(
  sessionsRoot: string,
  options: { cwd?: string; sessionId?: string },
): TranscriptHit | null {
  const candidates: TranscriptHit[] = [];
  for (const dir of codexDayDirs(sessionsRoot)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).slice(0, MAX_DIR_ENTRIES);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      // rollout-<ts>-<sessionId>.jsonl — exact session match by file name.
      if (options.sessionId && !name.includes(options.sessionId)) continue;
      const hit = statHit(path.join(dir, name));
      if (hit) candidates.push(hit);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (options.sessionId) return candidates[0] ?? null;
  // Without cwd or session id the newest rollout could belong to ANY project —
  // attribution would be a guess; degrade instead of lying on the card.
  if (!options.cwd) return null;
  // Attribute by workspace: probe the session_meta cwd of the newest files.
  for (const hit of candidates.slice(0, CODEX_HEAD_PROBE_FILES)) {
    const head = readFileHead(hit.file, 16 * 1024);
    for (const line of head.split('\n')) {
      const parsed = parseCodexLine(line);
      if (parsed?.kind === 'meta') {
        if (parsed.meta.cwd === options.cwd) return hit;
        break;
      }
    }
  }
  return null;
}

function resolveCodexTranscript(options: {
  home: string;
  cwd?: string;
  accountId?: string;
  sessionId?: string;
  transcriptPath?: string;
}): TranscriptHit | null {
  if (options.transcriptPath) {
    const hit = statHit(options.transcriptPath);
    if (hit) return hit;
  }
  const roots: string[] = [];
  if (options.accountId) {
    try {
      roots.push(managedHomePath('codex', options.accountId, options.home));
    } catch {
      // invalid account id — fall through to the real home
    }
  }
  roots.push(path.join(options.home, '.codex'));
  for (const root of roots) {
    const hit = findCodexRollout(path.join(root, 'sessions'), {
      cwd: options.cwd,
      sessionId: options.sessionId,
    });
    if (hit) return hit;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Summary computation.                                                 *
 * ------------------------------------------------------------------ */

export interface PaneActivityQuery {
  adapterId: string;
  cwd?: string;
  accountId?: string;
}

export interface PaneActivityDeps {
  /** Injectable home root (tests never touch the real user home). */
  home?: string;
  /**
   * Provider session captured by the status hooks (exact transcript path +
   * session id). Injected so tests never touch SQLite.
   */
  providerSession?: () => { id: string; transcriptPath?: string } | null;
  /**
   * Live/recent PTY tail (pane-registry ring buffer, kept 5 min after exit).
   * Injected so tests never touch the session registry.
   */
  tail?: () => { text: string; stoppedAt: number | null } | null;
}

interface ResolvedPaneActivity {
  summary: PaneActivitySummary;
  /** Transcript backing the summary (cache invalidation by mtime). */
  file: string | null;
  mtimeMs: number | null;
}

function readTranscriptActivity(
  file: string,
  flavor: TranscriptFlavor,
): { title: string | null; lastLine: string | null } {
  const firstUser =
    flavor === 'claude' ? extractClaudeFirstUserMessage : extractCodexFirstUserMessage;
  const entryText =
    flavor === 'claude' ? extractClaudeEntryText : extractCodexEntryText;

  let title: string | null = null;
  const head = readFileHead(file);
  if (head) {
    const lines = head.split('\n').slice(0, PANE_ACTIVITY_HEAD_LINES);
    for (const line of lines) {
      const text = firstUser(line);
      if (text) {
        title = sanitizeActivityLine(text);
        break;
      }
    }
  }

  let lastLine: string | null = null;
  const tail = readFileTail(file);
  if (tail) {
    // The tail window may cut the first line mid-JSON — drop it.
    const lines = tail.split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const text = entryText(lines[i] ?? '');
      if (text) {
        lastLine = sanitizeActivityLine(text);
        break;
      }
    }
  }
  return { title, lastLine };
}

function safeInvoke<T>(fn: (() => T) | undefined): T | null {
  if (!fn) return null;
  try {
    return fn();
  } catch {
    return null;
  }
}

function resolvePaneActivityDetailed(
  query: PaneActivityQuery,
  deps: PaneActivityDeps = {},
): ResolvedPaneActivity {
  try {
    const flavor = classifyTranscriptFlavor(query.adapterId);
    const session = safeInvoke(deps.providerSession);
    const home = deps.home ?? os.homedir();

    let title: string | null = null;
    let transcriptLine: string | null = null;
    let transcriptMtime: number | null = null;
    let file: string | null = null;

    if (flavor) {
      const hit =
        flavor === 'claude'
          ? resolveClaudeTranscript({
              home,
              adapterId: query.adapterId,
              cwd: query.cwd,
              sessionId: session?.id,
              transcriptPath: session?.transcriptPath,
            })
          : resolveCodexTranscript({
              home,
              cwd: query.cwd,
              accountId: query.accountId,
              sessionId: session?.id,
              transcriptPath: session?.transcriptPath,
            });
      if (hit) {
        file = hit.file;
        transcriptMtime = hit.mtimeMs;
        const parsed = readTranscriptActivity(hit.file, flavor);
        title = parsed.title;
        transcriptLine = parsed.lastLine;
      }
    }

    const tail = safeInvoke(deps.tail);
    const tailLine = tail ? lastSignificantLine(tail.text) : null;

    const lastLine = tailLine ?? transcriptLine;
    const source: PaneActivitySummary['source'] = tailLine
      ? 'tail'
      : title || transcriptLine
        ? 'transcript'
        : 'none';
    return {
      summary: {
        title,
        lastLine,
        // A live tail means the session is still running; a retained exited
        // buffer knows when it died; otherwise the transcript mtime is the
        // best "when it stopped" signal.
        stoppedAt: tail ? tail.stoppedAt : transcriptMtime,
        source,
      },
      file,
      mtimeMs: transcriptMtime,
    };
  } catch {
    return { summary: { ...EMPTY_SUMMARY }, file: null, mtimeMs: null };
  }
}

/** Pure activity resolution (transcript scan + injected tail). Never throws. */
export function resolvePaneActivity(
  query: PaneActivityQuery,
  deps: PaneActivityDeps = {},
): PaneActivitySummary {
  return resolvePaneActivityDetailed(query, deps).summary;
}

/* ------------------------------------------------------------------ *
 * Short in-memory cache: 30s TTL, invalidated by transcript mtime.     *
 * ------------------------------------------------------------------ */

interface CacheEntry {
  summary: PaneActivitySummary;
  file: string | null;
  mtimeMs: number | null;
  expiresAt: number;
}

export class PaneActivitySummaryCache {
  readonly #map = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs = PANE_ACTIVITY_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): PaneActivitySummary | null {
    const entry = this.#map.get(key);
    if (!entry) return null;
    if (this.now() >= entry.expiresAt) {
      this.#map.delete(key);
      return null;
    }
    // mtime invalidation: the transcript grew/rotated since the summary was
    // built — recompute instead of serving a stale card.
    if (entry.file) {
      const mtime = statMtime(entry.file);
      if (mtime === null || mtime !== entry.mtimeMs) {
        this.#map.delete(key);
        return null;
      }
    }
    return entry.summary;
  }

  set(
    key: string,
    summary: PaneActivitySummary,
    file: string | null,
    mtimeMs: number | null,
  ): void {
    this.#map.set(key, {
      summary,
      file,
      mtimeMs,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.#map.clear();
  }
}

/* ------------------------------------------------------------------ *
 * Production wiring: persisted mission pane → summary.                 *
 * ------------------------------------------------------------------ */

export interface MissionPaneActivityInput {
  owner: WebContents;
  scope: ProjectExecutionScope;
  paneId?: string;
  adapterId: string;
  cwd?: string;
  accountId?: string;
}

const defaultCache = new PaneActivitySummaryCache();

/** Test hook: drop the module-level cache between runs. */
export function resetPaneActivitySummaryCache(): void {
  defaultCache.clear();
}

function tailFromRegistry(
  owner: WebContents,
  paneId?: string,
): { text: string; stoppedAt: number | null } | null {
  if (!paneId) return null;
  const entry = findPaneOwnedBy(owner, paneId);
  if (!entry?.sessionId) return null;
  const text = readSessionOutput(entry.sessionId, 80);
  if (!text.trim()) return null;
  return { text, stoppedAt: sessionOutputExitedAt(entry.sessionId) };
}

/**
 * On-demand summary for one persisted mission pane (orch:missions.panes).
 * Cached per pane for 30s with mtime invalidation — the reopen hot path pays
 * at most one stat per pane on a cache hit. Never throws: errors → `none`.
 */
export function resolveMissionPaneActivity(
  input: MissionPaneActivityInput,
  options: { home?: string; cache?: PaneActivitySummaryCache } = {},
): PaneActivitySummary {
  try {
    const cache = options.cache ?? defaultCache;
    const key = [
      input.scope.projectId,
      input.scope.checkoutId,
      input.paneId ?? '',
      input.adapterId,
      input.cwd ?? '',
      input.accountId ?? '',
    ].join(':');
    const cached = cache.get(key);
    if (cached) return cached;

    const detailed = resolvePaneActivityDetailed(
      {
        adapterId: input.adapterId,
        cwd: input.cwd,
        accountId: input.accountId,
      },
      {
        home: options.home,
        providerSession: () => {
          if (!input.paneId) return null;
          const session = getProviderPaneSession(
            input.scope,
            input.paneId,
            input.adapterId,
            input.accountId,
          );
          return session
            ? { id: session.id, transcriptPath: session.transcriptPath }
            : null;
        },
        tail: () => tailFromRegistry(input.owner, input.paneId),
      },
    );
    cache.set(key, detailed.summary, detailed.file, detailed.mtimeMs);
    return detailed.summary;
  } catch {
    return { ...EMPTY_SUMMARY };
  }
}
