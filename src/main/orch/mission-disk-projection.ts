import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redactMissionBlockDetail } from "../../shared/mission-block-cause";
import { redactVisibleSecrets } from "../../shared/vision-ipc";
import type { ProjectExecutionScope } from "../../shared/types";
import type { MissionEvent } from "../../shared/mission-events";
import type { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { MissionEventJournal } from "./mission-event-journal";
import {
  getMissionEventRuntimeManager,
  setMissionEventAppendTap,
} from "./mission-event-emit";
import { normalizeSkillName, observerToolKind } from "./observer-tool-kind";
import { createScopedMissionStore } from "./mission-store";
import {
  requireProjectDomainStoreRegistry,
  type ProjectDomainStoreName,
  type ProjectDomainStoreRegistry,
  type ProjectDomainStoreSuite,
} from "./project-domain-store-registry";

/**
 * Disk projection of one mission, derived from the canonical SQLite runtime.
 * SQLite stays the single source of truth; these files exist so an operator
 * can diagnose a mission (`BOARD.md`, `status.json`, `events.jsonl`) without
 * opening the database. Never read back by the app.
 */

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const EVENT_LIMIT = 100;
const ORPHAN_TEMP_MAX_AGE_MS = 5 * 60 * 1_000;
const PROJECTION_TEMP_PATTERN =
  /^(?:BOARD\.md|status\.json|events\.jsonl)\.\d+\.[a-f0-9-]{36}\.tmp$/i;

/** Leading dot forbidden so `.`/`..`/dotfiles can never join the path. */
const MISSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface MissionDiskProjectionResult {
  readonly directory: string;
  readonly boardPath: string;
  readonly statusPath: string;
  readonly eventsPath: string;
}

function ensureRealDirectory(directory: string): void {
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(
        `mission projection path is not a real directory: ${directory}`,
      );
    }
    fs.chmodSync(directory, DIRECTORY_MODE);
    return;
  }
  fs.mkdirSync(directory, { mode: DIRECTORY_MODE });
}

function removeStaleProjectionTemps(directory: string, now: number): void {
  for (const name of fs.readdirSync(directory)) {
    if (!PROJECTION_TEMP_PATTERN.test(name)) continue;
    const candidate = path.join(directory, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (now - stat.mtimeMs < ORPHAN_TEMP_MAX_AGE_MS) continue;
      fs.unlinkSync(candidate);
    } catch (err) {
      console.warn("[mission-disk-projection] stale temp cleanup failed:", err);
    }
  }
}

/**
 * Last published fingerprint per file. A projection is rewritten on every
 * journal append, but most rewrites only move `generatedAt`; the fingerprint
 * lets those cost one lstat instead of a temp file and a rename.
 */
const publishedFingerprints = new Map<string, string>();
const MAX_PUBLISHED_FINGERPRINTS = 512;

/**
 * Atomic publish (temp + rename) of a diagnostic mirror. Deliberately no
 * fsync: SQLite is the source of truth and nothing reads these files back, so
 * a power loss only costs a stale mirror that the next refresh rebuilds. On
 * macOS `fsync` is F_FULLFSYNC (10-100 ms each, six per projection) and this
 * runs on the Main thread.
 */
function writeFileAtomicSecure(
  filePath: string,
  content: string,
  fingerprint: string = content,
): void {
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    throw new Error(`mission projection refuses symlink target: ${filePath}`);
  }
  if (
    existing &&
    (existing.mode & 0o777) === FILE_MODE &&
    publishedFingerprints.get(filePath) === fingerprint
  ) {
    return;
  }
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: FILE_MODE,
    });
    fs.renameSync(temporaryPath, filePath);
    if (publishedFingerprints.size >= MAX_PUBLISHED_FINGERPRINTS) {
      publishedFingerprints.clear();
    }
    publishedFingerprints.set(filePath, fingerprint);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

interface HandoffRow {
  readonly id: string;
  readonly from_agent: string | null;
  readonly status: string;
  readonly summary: string;
  readonly delivered: number;
  readonly created_at: number;
}

interface PaneRow {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  readonly adapter_id: string;
  readonly model: string | null;
  readonly agent_name: string | null;
}

/**
 * Payload keys allowed out of the database. Everything else (PTY output,
 * observer frames, tool arguments, credentials) stays SQLite-only; the
 * projection is a diagnostic surface, never an export channel.
 */
const SAFE_PAYLOAD_KEYS = [
  "kind",
  "step",
  "reason",
  "actionKind",
  "status",
  "mode",
  "detail",
] as const;
const SAFE_VALUE_MAX_LENGTH = 120;
const VISIBLE_REDACTION_MARKER = /\[REDACTED(?:_(?:PRIVATE_KEY|JWT))?\]/g;
const DIAGNOSTIC_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const REDACTED_IDENTIFIER = "<redacted-id>";

function safeIdentifier(raw: string, maxLength: number): string {
  if (
    raw.length > maxLength ||
    !DIAGNOSTIC_IDENTIFIER_PATTERN.test(raw) ||
    redactVisibleSecrets(raw) !== raw
  ) {
    return REDACTED_IDENTIFIER;
  }
  return raw;
}

function safePayloadSummary(
  payload: Readonly<Record<string, unknown>>,
): string | null {
  const parts: string[] = [];
  for (const key of SAFE_PAYLOAD_KEYS) {
    const value = payload[key];
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      continue;
    }
    parts.push(`${key}=${singleLine(String(value), SAFE_VALUE_MAX_LENGTH)}`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

const OBSERVER_TOOL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "observer.tool_call",
  "observer.tool_result",
]);

/**
 * F-780: nome e categoria da tool de um evento do observer — o que a auditoria
 * de 03/10 procurou no events.jsonl e não achou (o nome ficava só dentro de
 * `observer`, fora de SAFE_PAYLOAD_KEYS). Só o rótulo, validado como
 * identificador (sem espaço, caminho ou segredo); argumento e saída da tool
 * nunca saem do SQLite. Eventos gravados antes do F-780 têm o nome só no
 * quadro aninhado e também são projetados.
 */
function observerToolFields(event: MissionEvent): {
  readonly toolName?: string;
  readonly toolKind?: string;
  readonly skillName?: string;
} {
  if (!OBSERVER_TOOL_EVENT_TYPES.has(event.type)) return {};
  const nested = event.payload.observer;
  const observer =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Readonly<Record<string, unknown>>)
      : {};
  const rawName =
    typeof event.payload.toolName === "string"
      ? event.payload.toolName
      : observer.toolName;
  const toolName =
    typeof rawName === "string" && rawName.trim()
      ? safeIdentifier(rawName.trim(), SAFE_VALUE_MAX_LENGTH)
      : null;
  const toolKind = observerToolKind(
    rawName,
    event.payload.toolKind ?? observer.toolKind,
  );
  // Rótulo da skill: revalidado no padrão estrito antes de sair do SQLite.
  const skillName = normalizeSkillName(
    event.payload.skillName ?? observer.skillName,
  );
  return {
    ...(toolName ? { toolName } : {}),
    ...(toolKind ? { toolKind } : {}),
    ...(skillName ? { skillName } : {}),
  };
}

function eventLine(event: MissionEvent): string {
  const summary = safePayloadSummary(event.payload);
  return JSON.stringify({
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    type: event.type,
    origin: event.origin,
    runId: safeIdentifier(event.runId, 128),
    ...observerToolFields(event),
    ...(summary ? { summary } : {}),
  });
}

/** Resumo de uma linha de "Recent events" no BOARD.md. */
function boardEventSummary(event: MissionEvent): string | null {
  const tool = observerToolFields(event);
  const parts = [
    safePayloadSummary(event.payload),
    tool.toolName ? `tool=${tool.toolName}` : null,
    tool.toolKind ? `toolKind=${tool.toolKind}` : null,
    tool.skillName ? `skill=${tool.skillName}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Collapse agent-authored text to one bounded, markdown-safe line: no ANSI or
 * control characters, no `|` cell breaks, no minted headings/lines. Board
 * structure is owned by this module, never by mission content.
 */
function singleLine(raw: string, maxLength: number): string {
  const visibleSecretsRedacted = redactVisibleSecrets(raw).replace(
    VISIBLE_REDACTION_MARKER,
    "<token>",
  );
  const collapsed = redactMissionBlockDetail(visibleSecretsRedacted)
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

function renderBoard(input: {
  readonly missionId: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: number;
  readonly milestones: readonly { label: string; status: string }[];
  readonly panes: readonly PaneRow[];
  readonly handoffs: readonly HandoffRow[];
  readonly events: readonly MissionEvent[];
}): string {
  const lines: string[] = [
    `# ${singleLine(input.title, 120)}`,
    "",
    `- Mission: \`${input.missionId}\``,
    `- Status: **${input.status}**`,
    `- Updated: ${new Date(input.updatedAt).toISOString()}`,
    "",
  ];
  if (input.milestones.length > 0) {
    lines.push("## Milestones", "");
    for (const milestone of input.milestones) {
      const mark = milestone.status === "done" ? "x" : " ";
      const suffix =
        milestone.status === "done" ? "" : ` _(${milestone.status})_`;
      lines.push(`- [${mark}] ${singleLine(milestone.label, 160)}${suffix}`);
    }
    lines.push("");
  }
  if (input.panes.length > 0) {
    lines.push(
      "## Workers",
      "",
      "| Pane | Role | Adapter | Model |",
      "| --- | --- | --- | --- |",
    );
    for (const pane of input.panes) {
      const label = singleLine(pane.agent_name ?? pane.title, 60);
      lines.push(
        `| ${label} | ${singleLine(pane.role, 24)} | ${singleLine(pane.adapter_id, 24)} | ${pane.model ? singleLine(pane.model, 40) : "—"} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Handoffs", "");
  if (input.handoffs.length === 0) {
    lines.push("_none yet_");
  }
  for (const handoff of input.handoffs) {
    const at = new Date(handoff.created_at).toISOString();
    // Handoff text is agent-authored prose — redacted before it leaves SQLite
    // so the diagnostic mirror never becomes a secret export channel, then
    // collapsed so it cannot mint board structure either.
    const summary = singleLine(handoff.summary, 300);
    const from = singleLine(handoff.from_agent ?? "unknown", 60);
    lines.push(
      `- [${singleLine(handoff.status, 24)}] ${from} — ${summary || "_redacted_"} (${at})`,
    );
  }
  lines.push("", "## Recent events", "");
  if (input.events.length === 0) {
    lines.push("_none yet_");
  }
  for (const event of input.events) {
    const summary = boardEventSummary(event);
    lines.push(
      `- ${event.sequence} · ${new Date(event.occurredAt).toISOString()} · ${event.type} (${event.origin})${summary ? ` — ${singleLine(summary, 240)}` : ""}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Project one mission from SQLite to its readable on-disk mirror. Returns the
 * written paths, or null when the mission does not exist. Throws on unsafe
 * mission ids, symlinked targets, or write failures — callers own recovery.
 */
export function projectMissionToDisk(
  manager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  missionId: string,
  options: { readonly now?: () => number } = {},
): MissionDiskProjectionResult | null {
  if (!MISSION_ID_PATTERN.test(missionId)) {
    throw new Error(
      `mission id is not safe for a disk projection path: ${JSON.stringify(missionId)}`,
    );
  }
  const runtimeDirectory = manager.locationFor(scope).directory;
  const directory = path.join(runtimeDirectory, "missions", missionId);
  if (
    path.relative(runtimeDirectory, directory).startsWith("..") ||
    path.isAbsolute(path.relative(runtimeDirectory, directory))
  ) {
    throw new Error(
      `mission projection path escapes the runtime directory: ${directory}`,
    );
  }

  const mission = createScopedMissionStore(manager, scope).get(missionId);
  if (!mission) return null;

  const db = manager.open(scope).db;
  const panes = db
    .prepare(
      `SELECT id, title, role, adapter_id, model, agent_name
       FROM mission_panes WHERE mission_id = ? ORDER BY created_at`,
    )
    .all(missionId) as PaneRow[];
  const handoffs = db
    .prepare(
      `SELECT id, from_agent, status, summary, delivered, created_at
       FROM handoffs WHERE mission_id = ? ORDER BY created_at`,
    )
    .all(missionId) as HandoffRow[];
  const events = new MissionEventJournal(manager, scope).projectRecent(
    missionId,
    EVENT_LIMIT,
  );

  ensureRealDirectory(path.join(runtimeDirectory, "missions"));
  ensureRealDirectory(directory);
  const now = options.now ?? Date.now;
  const generatedAt = now();
  removeStaleProjectionTemps(directory, generatedAt);

  const boardPath = path.join(directory, "BOARD.md");
  const statusPath = path.join(directory, "status.json");
  const eventsPath = path.join(directory, "events.jsonl");
  const lastEvent = events.at(-1);

  writeFileAtomicSecure(
    boardPath,
    renderBoard({
      missionId,
      title: mission.title,
      status: mission.status,
      updatedAt: mission.updatedAt,
      milestones: mission.milestones,
      panes,
      handoffs,
      events,
    }),
  );
  const status = {
    missionId,
    title: singleLine(mission.title, 120),
    status: mission.status,
    intentState: mission.intentState ?? null,
    squadId: mission.squadId ? safeIdentifier(mission.squadId, 128) : null,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    paneCount: panes.length,
    handoffCount: handoffs.length,
    lastEventSequence: lastEvent?.sequence ?? 0,
    lastEventAt: lastEvent?.occurredAt ?? null,
  };
  writeFileAtomicSecure(
    statusPath,
    `${JSON.stringify({ generatedAt, ...status }, null, 2)}\n`,
    JSON.stringify(status),
  );
  writeFileAtomicSecure(
    eventsPath,
    events.map((event) => `${eventLine(event)}\n`).join(""),
  );

  return { directory, boardPath, statusPath, eventsPath };
}

/**
 * Main-owned seam: refresh the disk mirror after each durable journal append,
 * debounced per (project, checkout, mission) so event bursts cost one rewrite.
 * Failures are logged and never reach the emitter.
 */
const DEFAULT_DEBOUNCE_MS = 500;
const pendingRefreshes = new Map<string, NodeJS.Timeout>();
const RELEVANT_STORE_CHANGES = new Set<ProjectDomainStoreName>([
  "missions",
  "mission-panes",
  "handoffs",
]);
let installed = false;
let unsubscribeStoreChanges: (() => void) | null = null;
let unsubscribeScopes: (() => void) | null = null;

function queueProjectionRefresh(
  scope: ProjectExecutionScope,
  missionId: string,
  debounceMs: number,
): void {
  const key = `${scope.installationId}:${scope.projectId}:${scope.checkoutId}:${missionId}`;
  if (pendingRefreshes.has(key)) return;
  const timer = setTimeout(() => {
    pendingRefreshes.delete(key);
    const manager = getMissionEventRuntimeManager();
    if (!manager) return;
    try {
      projectMissionToDisk(manager, scope, missionId);
    } catch (err) {
      console.warn("[mission-disk-projection] refresh failed:", err);
    }
  }, debounceMs);
  timer.unref?.();
  pendingRefreshes.set(key, timer);
}

function queueScopeRefresh(
  scope: ProjectExecutionScope,
  suite: ProjectDomainStoreSuite,
  debounceMs: number,
): void {
  for (const mission of suite.missions.list()) {
    queueProjectionRefresh(scope, mission.id, debounceMs);
  }
}

export function installMissionDiskProjection(
  options: {
    readonly debounceMs?: number;
    readonly registry?: ProjectDomainStoreRegistry;
  } = {},
): () => void {
  if (installed) return uninstallMissionDiskProjection;
  installed = true;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const registry = options.registry ?? requireProjectDomainStoreRegistry();
  unsubscribeStoreChanges = registry.onChange((scope, store) => {
    if (!RELEVANT_STORE_CHANGES.has(store)) return;
    queueScopeRefresh(scope, registry.forScope(scope), debounceMs);
  });
  unsubscribeScopes = registry.onScope((scope, suite) => {
    queueScopeRefresh(scope, suite, debounceMs);
  });
  setMissionEventAppendTap((scope, missionId) => {
    queueProjectionRefresh(scope, missionId, debounceMs);
  });
  return uninstallMissionDiskProjection;
}

export function uninstallMissionDiskProjection(): void {
  unsubscribeStoreChanges?.();
  unsubscribeStoreChanges = null;
  unsubscribeScopes?.();
  unsubscribeScopes = null;
  for (const timer of pendingRefreshes.values()) clearTimeout(timer);
  pendingRefreshes.clear();
  publishedFingerprints.clear();
  setMissionEventAppendTap(null);
  installed = false;
}
