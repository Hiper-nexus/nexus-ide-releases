import type { ProjectExecutionScope } from '../../shared/types';
import { resolveRootForScope } from '../orch/workspace-path';
import { formatHashlineHeader, formatNumberedLines } from '../../vendor/omp/hashline/format';
import { Patch } from '../../vendor/omp/hashline/input';
import { normalizeToLF, stripBom } from '../../vendor/omp/hashline/normalize';
import { Patcher } from '../../vendor/omp/hashline/patcher';
import { InMemorySnapshotStore } from '../../vendor/omp/hashline/snapshots';
import { EditorBufferHashlineFs, openEditorDocuments } from './hashline-fs';
import {
  assertMcpInvocationCurrent,
  type McpToolInvocation,
} from '../orch/mcp-protocol';

/**
 * Hashline patch-bus session layer (oh-my-pi integration, entrega B3).
 *
 * A hashline section header `[path#TAG]` carries an opaque 4-hex tag minted by
 * a read in the SAME session; the SnapshotStore is what binds tag → exact file
 * content. This module keeps one in-memory store per MCP session token, with
 * TTL + LRU bounds so long-lived orchestrators do not accumulate file text
 * forever.
 */

/** Idle lifetime of a session's snapshot store. */
const SESSION_TTL_MS = 45 * 60 * 1000;
/** Maximum simultaneously tracked sessions (LRU eviction beyond it). */
const MAX_SESSIONS = 64;
/** Full-file read cap for hashline tag minting (UTF-16 code units). */
const MAX_HASHLINE_READ_CHARS = 8 * 1024 * 1024;

interface SessionEntry {
  store: InMemorySnapshotStore;
  lastUsedAt: number;
}

const sessions = new Map<string, SessionEntry>();

function sweepSessions(now: number): void {
  for (const [key, entry] of sessions) {
    if (now - entry.lastUsedAt > SESSION_TTL_MS) sessions.delete(key);
  }
  while (sessions.size > MAX_SESSIONS) {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of sessions) {
      if (entry.lastUsedAt < oldestAt) {
        oldestAt = entry.lastUsedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    sessions.delete(oldestKey);
  }
}

/** Snapshot store bound to one MCP session token (created on first use). */
export function hashlineSnapshotStoreFor(sessionKey: string): InMemorySnapshotStore {
  const now = Date.now();
  sweepSessions(now);
  const existing = sessions.get(sessionKey);
  if (existing) {
    existing.lastUsedAt = now;
    return existing.store;
  }
  const entry: SessionEntry = {
    store: new InMemorySnapshotStore(),
    lastUsedAt: now,
  };
  sessions.set(sessionKey, entry);
  return entry.store;
}

/** Drop one session's snapshot history (e.g. when its gate token is revoked). */
export function disposeHashlineSession(sessionKey: string): void {
  sessions.delete(sessionKey);
}

/** Test seam: wipe every session store. */
export function resetHashlineSessions(): void {
  sessions.clear();
}

export interface HashlineAppliedSection {
  /** Section path as authored (workspace-relative). */
  path: string;
  /** `create` | `update` | `delete` | `noop`. */
  op: 'create' | 'update' | 'delete' | 'noop';
  /** Number of low-level edits parsed for this section (0 for REM/MV-only). */
  edits: number;
  /** Fresh `[path#TAG]` header to anchor follow-up edits on this file. */
  header: string;
  /** 1-indexed first changed line, when the apply changed anything. */
  firstChangedLine: number | null;
  /** Parser/applier/recovery warnings for this section. */
  warnings: string[];
  /** Destination path when the section carried `MV DEST`. */
  moveDest?: string;
}

export interface HashlineApplyOutcome {
  applied: HashlineAppliedSection[];
  summary: string;
}

/**
 * Parse and apply a multi-section hashline patch document against the scoped
 * workspace. All sections are prepared (read + tag validation + in-memory
 * apply) before any write lands, so a failure in any section aborts the whole
 * patch — the vendored Patcher's all-or-nothing contract is preserved.
 *
 * Staleness surfaces as the vendored MismatchError, whose message already
 * embeds the anchored-context diagnostic; callers should let it propagate.
 */
export async function applyHashlinePatch(
  scope: ProjectExecutionScope,
  sessionKey: string,
  patchText: string,
  invocation?: McpToolInvocation,
): Promise<HashlineApplyOutcome> {
  const root = resolveRootForScope(scope);
  const patch = Patch.parse(patchText, { cwd: root });
  if (patch.sections.length === 0) {
    throw new Error(
      'patch contains no file sections; start with a "[path#TAG]" header line',
    );
  }

  const fs = new EditorBufferHashlineFs(scope, openEditorDocuments);
  const snapshots = hashlineSnapshotStoreFor(sessionKey);
  const patcher = new Patcher({
    fs,
    snapshots,
    assertCurrentAuthority: () => assertMcpInvocationCurrent(invocation),
  });
  const result = await patcher.apply(patch);

  const applied: HashlineAppliedSection[] = result.sections.map(
    (section, index) => {
      const parsedEdits = patch.sections[index]?.edits.length ?? 0;
      const entry: HashlineAppliedSection = {
        path: section.path,
        op: section.op,
        edits: parsedEdits,
        header: section.header,
        firstChangedLine: section.firstChangedLine ?? null,
        warnings: [...section.warnings],
      };
      if (section.moveDest !== undefined) entry.moveDest = section.moveDest;
      return entry;
    },
  );

  const summary = applied
    .map((section) => {
      const suffix =
        section.op === 'delete'
          ? 'deleted'
          : section.op === 'noop'
            ? 'no changes'
            : `${section.edits} edit${section.edits === 1 ? '' : 's'}`;
      const move =
        section.moveDest !== undefined ? ` -> ${section.moveDest}` : '';
      return `${section.path}${move} (${section.op}: ${suffix})`;
    })
    .join('; ');

  return { applied, summary };
}

export interface HashlineReadResult {
  /** Section header `[path#TAG]` minting this snapshot for follow-up edits. */
  header: string;
  /** The 4-hex content tag by itself. */
  tag: string;
  /** Displayed lines in hashline `LINE:TEXT` form, prefixed by the header. */
  content: string;
  /** 1-indexed first displayed line. */
  offset: number;
  /** Number of lines displayed. */
  lines: number;
  /** Total lines in the file. */
  totalLines: number;
}

/**
 * Read a workspace file in hashline mode: mint (or refresh) the session
 * snapshot tag for its full normalized content and return the requested line
 * range formatted as `LINE:TEXT` under a `[path#TAG]` header — the exact
 * format the vendored prompt teaches the model to anchor edits against.
 *
 * The whole file is always read and hashed (the tag fingerprints the full
 * content); `offset`/`limit` only bound what is DISPLAYED, and only displayed
 * lines join the snapshot's seen-line provenance, so the patcher can refuse
 * blind edits on lines this session never surfaced.
 */
export async function readWorkspaceFileAsHashline(
  scope: ProjectExecutionScope,
  sessionKey: string,
  relativePath: string,
  options: { offset?: number; limit?: number } = {},
): Promise<HashlineReadResult> {
  const fs = new EditorBufferHashlineFs(scope, openEditorDocuments);
  const raw = await fs.readText(relativePath);
  if (raw.length > MAX_HASHLINE_READ_CHARS) {
    throw new Error(
      `file exceeds ${MAX_HASHLINE_READ_CHARS} characters; hashline mode needs the full content to mint a tag`,
    );
  }
  const normalized = normalizeToLF(stripBom(raw).text);
  const fileLines = normalized.split('\n');
  const totalLines = fileLines.length;

  const start = Math.min(
    Math.max(1, Math.trunc(options.offset ?? 1)),
    totalLines,
  );
  const boundedLimit = Math.max(
    1,
    Math.trunc(options.limit ?? totalLines),
  );
  const displayed = fileLines.slice(start - 1, start - 1 + boundedLimit);

  const seenLines: number[] = [];
  for (let i = 0; i < displayed.length; i += 1) seenLines.push(start + i);

  const store = hashlineSnapshotStoreFor(sessionKey);
  const tag = store.record(fs.canonicalPath(relativePath), normalized, seenLines);
  const header = formatHashlineHeader(relativePath, tag);
  const body = formatNumberedLines(displayed.join('\n'), start);

  return {
    header,
    tag,
    content: `${header}\n${body}`,
    offset: start,
    lines: displayed.length,
    totalLines,
  };
}
