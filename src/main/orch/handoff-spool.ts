/**
 * F-795 — spool em disco dos handoffs que o Main não recebeu.
 *
 * Na Missão Terminais (03/10) o Main ficou minutos preso em JS: o F-768
 * perdeu o handoff para um erro de transporte MCP e depois para o timeout do
 * shim, o F-777 para ECONNRESET + timeout, e o `blocked` do DeepSeek nem
 * chegou a sair (o gate fail-closed bloqueava tudo). Trabalho de agente não
 * pode depender de o Main estar respondendo NAQUELE segundo.
 *
 * Contrato:
 *  - Cada worker de missão nasce com um diretório privado (0700) só dele,
 *    `<userData>/handoff-spool/v1/sessions/<spoolId>/`, concedido no sandbox
 *    junto com o shim, e com uma chave HMAC por sessão. Quando o Main não
 *    responde, o shim `nx`, a ponte stdio e o hook do gate gravam ali a
 *    entrada do handoff (0600, assinada) e respondem ao agente "guardado".
 *  - O vínculo (escopo, missão, sessão, agente, chave) é do Main e mora FORA
 *    do diretório do agente (`bindings/`, 0600). A atribuição do handoff vem
 *    dele, nunca do conteúdo da entrada.
 *  - O Main ingere no boot, quando o diretório muda (watch: dispara quando o
 *    loop volta a girar depois de um travamento), no fim de um submit adiado e
 *    no fim da sessão. Nada roda no caminho quente; o I/O é assíncrono.
 *  - Ingestão idempotente: a entrada é reivindicada por rename para
 *    `processing/`, validada (schema, nome, HMAC, limites do MCP), deduplicada
 *    (recibo `ingested/<entryId>`, artifact com o entryId, digest do payload
 *    cru igual ao de um handoff que o transporte original gravou) e gravada
 *    UMA vez pela via durável (`handoffs.submit`), sempre como evidência não
 *    verificada. Inválida vai para `quarantine/` com o motivo — nunca apagada.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { handoffStatusSchema, type Handoff, type HandoffStatus } from '../../shared/orch-types';
import { projectExecutionScopeSchema } from '../../shared/project-identity-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { embedTelemetryArtifact, sanitizeHandoffTelemetry } from '../../shared/handoff-telemetry';
import { trace } from '../observability/main-trace';
import { handoffRawPayloadSha256 } from './handoff-payload-identity';
import { capHandoffFullText, condenseHandoffSummary } from './handoff-summary-rule';
import { hasHandoffSubmitInFlight, onHandoffSubmitSettled } from './handoff-submit-inflight';
import { normalizeHandoffStatusInput } from './legacy-handoff';
import { validateToolArgs } from './mcp-args-validation';
import {
  HANDOFF_SPOOL_ENTRY_SCHEMA,
  HANDOFF_SPOOL_ENV_DIR,
  HANDOFF_SPOOL_ENV_ID,
  HANDOFF_SPOOL_ENV_KEY,
  HANDOFF_SPOOL_MAX_ENTRY_BYTES,
  HANDOFF_SPOOL_MAX_PAYLOAD_BYTES,
  HANDOFF_SPOOL_TRANSPORTS,
  handoffSpoolSigningInput,
} from './handoff-spool-entry';

export const HANDOFF_SPOOL_ARTIFACT_KIND = 'nexus.handoff-spool';
const BINDING_SCHEMA = 'nexus.handoff-spool-binding/v1';
const MAX_ENTRIES_PER_PASS = 32;
/** Vínculo de sessão de OUTRO processo do Main, vazio: some depois disso. */
const FOREIGN_BINDING_TTL_MS = 48 * 60 * 60 * 1000;
const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_TEMP_MS = 60 * 60 * 1000;
const BOOT_INGEST_DELAY_MS = 3_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENTRY_FILE_RE =
  /^(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
/** Só os status que o agente pode declarar (os sintéticos são do Main). */
const AGENT_STATUSES: ReadonlySet<HandoffStatus> = new Set(['success', 'partial', 'blocked', 'failed']);

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);

const bindingSchema = z
  .object({
    schema: z.literal(BINDING_SCHEMA),
    spoolId: z.uuid(),
    key: z.string().regex(/^[a-f0-9]{64}$/),
    scope: projectExecutionScopeSchema,
    missionId: identifierSchema,
    sessionId: identifierSchema.optional(),
    workerIncarnationId: identifierSchema.optional(),
    agentLabel: z.string().trim().min(1).max(256).regex(/^[^\u0000-\u001F\u007F]+$/u),
    providerId: z.string().min(1).max(128).optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
type HandoffSpoolBinding = z.infer<typeof bindingSchema>;

const entrySchema = z
  .object({
    schema: z.literal(HANDOFF_SPOOL_ENTRY_SCHEMA),
    spoolId: z.uuid(),
    entryId: z.uuid(),
    createdAt: z.number().int().nonnegative(),
    transport: z.enum(HANDOFF_SPOOL_TRANSPORTS),
    toolName: z.literal('nexus_handoff_submit'),
    requestId: z.uuid().optional(),
    payload: z.string().min(2).max(HANDOFF_SPOOL_MAX_PAYLOAD_BYTES),
    mac: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type HandoffSpoolEntry = z.infer<typeof entrySchema>;

export interface HandoffSpoolSubmitInput {
  readonly status: HandoffStatus;
  readonly summary: string;
  readonly artifacts: unknown[];
  readonly missionId: string;
  readonly sessionId?: string;
  readonly workerIncarnationId?: string;
  readonly fromAgent: string;
}

/** O pedaço das stores que a ingestão usa (injetado: o spool não puxa o PTY). */
export interface HandoffSpoolStores {
  readonly missions: { get(id: string): unknown };
  readonly handoffs: {
    list(filter: {
      missionId?: string | null;
      includeDelivered?: boolean;
      sessionIds?: string[];
    }): readonly Handoff[];
    submit(input: HandoffSpoolSubmitInput): Handoff;
  };
}

export interface HandoffSpoolDeps {
  readonly getStores: (scope: ProjectExecutionScope) => HandoffSpoolStores;
  /** Acorda o orquestrador (idle-delivery); falha não desfaz o handoff durável. */
  readonly deliver: (handoff: Handoff, scope: ProjectExecutionScope) => unknown;
  readonly now?: () => number;
}

export interface HandoffSpoolIngestReport {
  ingested: number;
  duplicates: number;
  deferred: number;
  quarantined: number;
  failed: number;
}

export interface HandoffSpoolSession {
  readonly spoolId: string;
  /** Caminho real do diretório da sessão (o que vai para env e sandbox). */
  readonly dir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  bindSession(sessionId: string): void;
  /** Fim da sessão: ingestão final; o diretório some quando esvaziar. */
  dispose(): void;
  /** Spawn falhou: nenhum agente rodou, apaga tudo agora. */
  discard(): void;
}

interface Layout {
  readonly root: string;
  readonly sessions: string;
  readonly bindings: string;
  readonly processing: string;
  readonly ingested: string;
  readonly quarantine: string;
}

interface LiveSpool {
  readonly spoolId: string;
  readonly dir: string;
  binding: HandoffSpoolBinding;
  watcher: fs.FSWatcher | null;
}

interface SpoolState {
  readonly root: string;
  readonly deps: HandoffSpoolDeps;
  readonly watch: boolean;
}

let state: SpoolState | null = null;
const liveSpools = new Map<string, LiveSpool>();
const spoolIdBySession = new Map<string, string>();
const disposedInProcess = new Set<string>();
const deferredSessions = new Set<string>();
let ingestTimer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
let ingesting: Promise<HandoffSpoolIngestReport> | null = null;
let rerun = false;
let unsubscribeSettled: (() => void) | null = null;
const RETIRED_SPOOL = Symbol('retired handoff spool');

function assertCurrent(owner: SpoolState): void {
  if (state !== owner) throw RETIRED_SPOOL;
}

async function waitCurrent<T>(owner: SpoolState, physical: Promise<T>): Promise<T> {
  try {
    const result = await physical;
    assertCurrent(owner);
    return result;
  } catch (error) {
    assertCurrent(owner);
    throw error;
  }
}

export function handoffSpoolRoot(userDataPath: string): string {
  return path.join(userDataPath, 'handoff-spool', 'v1');
}

function layoutOf(root: string): Layout {
  return {
    root,
    sessions: path.join(root, 'sessions'),
    bindings: path.join(root, 'bindings'),
    processing: path.join(root, 'processing'),
    ingested: path.join(root, 'ingested'),
    quarantine: path.join(root, 'quarantine'),
  };
}

function ensurePrivateDirectorySync(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('handoff spool path is not a private directory');
  }
  fs.chmodSync(directory, 0o700);
}

async function ensurePrivateDirectory(directory: string, owner: SpoolState): Promise<void> {
  assertCurrent(owner);
  await waitCurrent(owner, fs.promises.mkdir(directory, { recursive: true, mode: 0o700 }));
  const stat = await waitCurrent(owner, fs.promises.lstat(directory));
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('handoff spool path is not a private directory');
  }
  await waitCurrent(owner, fs.promises.chmod(directory, 0o700));
}

function bindingPath(layout: Layout, spoolId: string): string {
  return path.join(layout.bindings, `${spoolId}.json`);
}

function writeBindingSync(layout: Layout, binding: HandoffSpoolBinding): void {
  const target = bindingPath(layout, binding.spoolId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(binding)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Configura o spool (boot do servidor MCP). Sem configuração, nenhum spawn
 * ganha spool — os testes que não o ligam continuam com o comportamento antigo.
 */
export function startHandoffSpool(input: {
  readonly root: string;
  readonly deps: HandoffSpoolDeps;
  readonly bootDelayMs?: number;
  /** Testes determinísticos desligam o watch; produção sempre observa. */
  readonly watch?: boolean;
}): void {
  // Same-root replacement retains live bindings, but retires every old pass
  // and queued watcher callback. The physical ingest flight stays single.
  if (state?.root === input.root) {
    for (const live of liveSpools.values()) closeWatcher(live);
    if (ingestTimer) clearTimeout(ingestTimer);
    if (bootTimer) clearTimeout(bootTimer);
    ingestTimer = null; bootTimer = null;
    unsubscribeSettled?.();
  } else {
    void stopHandoffSpool();
  }
  state = { root: input.root, deps: input.deps, watch: input.watch !== false };
  const owner = state;
  unsubscribeSettled = onHandoffSubmitSettled((sessionId) => {
    if (state !== owner) return;
    if (deferredSessions.delete(sessionId)) scheduleHandoffSpoolIngest('submit-settled');
  });
  for (const live of liveSpools.values()) startWatcher(live);
  // Boot: o que ficou de um Main que travou ou fechou entra sem esperar evento.
  bootTimer = setTimeout(() => {
    if (state !== owner) return;
    bootTimer = null;
    scheduleHandoffSpoolIngest('boot', 0);
  }, input.bootDelayMs ?? BOOT_INGEST_DELAY_MS);
  bootTimer.unref?.();
}

/** Para watchers e timers; nunca apaga nada do disco (o próximo boot ingere). */
export function stopHandoffSpool(): Promise<void> {
  const physical = ingesting;
  state = null;
  rerun = false;
  for (const live of liveSpools.values()) closeWatcher(live);
  liveSpools.clear();
  spoolIdBySession.clear();
  deferredSessions.clear();
  if (ingestTimer) clearTimeout(ingestTimer);
  if (bootTimer) clearTimeout(bootTimer);
  ingestTimer = null;
  bootTimer = null;
  unsubscribeSettled?.();
  unsubscribeSettled = null;
  // Revocation is synchronous; the exact read/write/delivery flight must
  // physically settle before its domain registry may be closed.
  return physical ? physical.then(() => undefined, () => undefined) : Promise.resolve();
}

function closeWatcher(live: LiveSpool): void {
  try {
    live.watcher?.close();
  } catch {
    // Watcher já fechado.
  }
  live.watcher = null;
}

/**
 * Cria o diretório e o vínculo de uma sessão de worker de missão. Síncrono
 * de propósito (o hook de spawn é síncrono, como o shim): dois mkdir e um
 * arquivo pequeno por spawn, nunca por chunk de PTY.
 */
export function createHandoffSpoolSession(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly workerIncarnationId?: string;
  readonly agentLabel: string;
  readonly providerId?: string;
}): HandoffSpoolSession | null {
  if (!state) return null;
  const owner = state;
  const layout = layoutOf(owner.root);
  ensurePrivateDirectorySync(path.dirname(owner.root));
  for (const directory of [layout.root, layout.sessions, layout.bindings]) {
    ensurePrivateDirectorySync(directory);
  }
  const spoolId = randomUUID();
  const created = path.join(layout.sessions, spoolId);
  ensurePrivateDirectorySync(created);
  const dir = fs.realpathSync.native(created);
  const binding = bindingSchema.parse({
    schema: BINDING_SCHEMA,
    spoolId,
    key: randomBytes(32).toString('hex'),
    // Só os campos do schema: o escopo em memória pode trazer extras.
    scope: {
      version: input.scope.version,
      installationId: input.scope.installationId,
      projectId: input.scope.projectId,
      checkoutId: input.scope.checkoutId,
      rootRealPath: input.scope.rootRealPath,
      ...(input.scope.workspaceRootDevice !== undefined
        ? { workspaceRootDevice: input.scope.workspaceRootDevice, workspaceRootInode: input.scope.workspaceRootInode }
        : {}),
      identitySource: input.scope.identitySource,
    },
    missionId: input.missionId,
    ...(input.workerIncarnationId ? { workerIncarnationId: input.workerIncarnationId } : {}),
    // Mesmo contrato do rótulo do handoff: sem controle, até 256.
    agentLabel: input.agentLabel.replace(/[\u0000-\u001F\u007F]+/gu, ' ').trim().slice(0, 256) || 'worker',
    ...(input.providerId ? { providerId: input.providerId } : {}),
    createdAt: (owner.deps.now ?? Date.now)(),
  });
  writeBindingSync(layout, binding);
  const live: LiveSpool = { spoolId, dir, binding, watcher: null };
  liveSpools.set(spoolId, live);
  return {
    spoolId,
    dir,
    env: Object.freeze({
      [HANDOFF_SPOOL_ENV_DIR]: dir,
      [HANDOFF_SPOOL_ENV_ID]: spoolId,
      [HANDOFF_SPOOL_ENV_KEY]: binding.key,
    }),
    readPaths: Object.freeze([dir]),
    writePaths: Object.freeze([dir]),
    bindSession(sessionId) {
      if (state !== owner || liveSpools.get(spoolId) !== live) return;
      live.binding = bindingSchema.parse({ ...live.binding, sessionId });
      writeBindingSync(layout, live.binding);
      spoolIdBySession.set(sessionId, spoolId);
      startWatcher(live);
    },
    dispose() {
      if (liveSpools.get(spoolId) !== live) return;
      releaseLiveSpool(spoolId);
      scheduleHandoffSpoolIngest('session-end');
    },
    discard() {
      if (state !== owner || liveSpools.get(spoolId) !== live) return;
      releaseLiveSpool(spoolId);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(bindingPath(layout, spoolId), { force: true });
    },
  };
}

function startWatcher(live: LiveSpool): void {
  if (live.watcher || !state?.watch) return;
  const owner = state;
  try {
    // Evento de diretório chega quando o loop do Main volta a girar — é a
    // "reconexão" depois de um travamento, sem polling.
    const watcher = fs.watch(live.dir, { persistent: false }, () => {
      if (state !== owner || liveSpools.get(live.spoolId) !== live) return;
      scheduleHandoffSpoolIngest('watch');
    });
    watcher.on('error', () => { if (live.watcher === watcher) closeWatcher(live); });
    live.watcher = watcher;
  } catch {
    // Sem watch (plataforma/limite de inotify): boot e fim de sessão cobrem.
  }
}

function releaseLiveSpool(spoolId: string): void {
  const live = liveSpools.get(spoolId);
  if (live) closeWatcher(live);
  liveSpools.delete(spoolId);
  disposedInProcess.add(spoolId);
  for (const [sessionId, candidate] of spoolIdBySession) {
    if (candidate === spoolId) spoolIdBySession.delete(sessionId);
  }
}

export function disposeHandoffSpoolBySession(sessionId: string): void {
  const spoolId = spoolIdBySession.get(sessionId);
  if (!spoolId) return;
  releaseLiveSpool(spoolId);
  scheduleHandoffSpoolIngest('session-end');
}

/** Agenda uma passada (coalescida); nunca lança. */
export function scheduleHandoffSpoolIngest(reason: string, delayMs = 250): void {
  if (!state) return;
  if (ingesting) {
    rerun = true;
    return;
  }
  if (ingestTimer) return;
  const owner = state;
  ingestTimer = setTimeout(() => {
    if (state !== owner) return;
    ingestTimer = null;
    void runScheduledIngest(reason);
  }, delayMs);
  ingestTimer.unref?.();
}

function emptyReport(): HandoffSpoolIngestReport {
  return { ingested: 0, duplicates: 0, deferred: 0, quarantined: 0, failed: 0 };
}

async function runScheduledIngest(reason: string): Promise<HandoffSpoolIngestReport> {
  if (!state) return emptyReport();
  if (ingesting) {
    rerun = true;
    return ingesting;
  }
  const current = state;
  const physical = (async () => {
    const total = emptyReport();
    do {
      rerun = false;
      const pass = await runIngestPass(current);
      for (const key of Object.keys(total) as Array<keyof HandoffSpoolIngestReport>) {
        total[key] += pass[key];
      }
    } while (rerun && state === current);
    return total;
  })();
  ingesting = physical;
  try {
    const report = await physical;
    if (state === current && Object.values(report).some((count) => count > 0)) {
      trace({ kind: 'handoff-spool-pass', trigger: reason, ...report });
    }
    return report;
  } catch (error) {
    if (error === RETIRED_SPOOL) return emptyReport();
    console.warn('[handoff-spool] passada de ingestão falhou:', error);
    return emptyReport();
  } finally {
    if (ingesting === physical) ingesting = null;
    // Pedido que chegou enquanto uma passada de OUTRA configuração rodava
    // (reinício do spool) não pode se perder: reagenda sob a atual.
    if (state && (rerun || state !== current)) {
      rerun = false;
      scheduleHandoffSpoolIngest('rerun', 0);
    }
  }
}

/** Testes e diagnóstico: roda uma passada agora (espera a que estiver em curso). */
export async function ingestHandoffSpoolNow(): Promise<HandoffSpoolIngestReport> {
  if (ingesting) await ingesting.catch(() => undefined);
  return runScheduledIngest('manual');
}

async function readdirSafe(directory: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(directory)).sort();
  } catch {
    return [];
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch {
    return false;
  }
}

type BindingResult =
  | { readonly ok: true; readonly binding: HandoffSpoolBinding }
  | { readonly ok: false; readonly reason: string };

async function loadBinding(layout: Layout, spoolId: string, owner: SpoolState): Promise<BindingResult> {
  assertCurrent(owner);
  const live = liveSpools.get(spoolId);
  if (live) return { ok: true, binding: live.binding };
  const read = await readClaimedEntry(bindingPath(layout, spoolId), owner, 64 * 1024);
  assertCurrent(owner);
  if (!read.ok) return { ok: false, reason: read.reason === 'entry-unreadable' ? 'binding-missing' : 'binding-invalid' };
  try {
    const parsed = bindingSchema.safeParse(JSON.parse(read.text));
    if (!parsed.success || parsed.data.spoolId !== spoolId) return { ok: false, reason: 'binding-invalid' };
    return { ok: true, binding: parsed.data };
  } catch {
    return { ok: false, reason: 'binding-invalid' };
  }
}

type ReadResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

async function readClaimedEntry(file: string, owner: SpoolState, cap = HANDOFF_SPOOL_MAX_ENTRY_BYTES): Promise<ReadResult> {
  assertCurrent(owner);
  let handle: FileHandle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    assertCurrent(owner);
    return { ok: false, reason: 'entry-unreadable' };
  }
  try {
    // Capture the returned handle before fencing: a late open still owns an
    // FD which must be closed physically even after cancellation.
    assertCurrent(owner);
    const stat = await waitCurrent(owner, handle.stat());
    if (!stat.isFile()) return { ok: false, reason: 'entry-not-regular' };
    // Link físico apontaria para fora do diretório do agente.
    if (stat.nlink !== 1) return { ok: false, reason: 'entry-hardlinked' };
    if (stat.size > cap) return { ok: false, reason: 'entry-too-large' };
    const bytes = Buffer.alloc(cap + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await waitCurrent(owner, handle.read(bytes, offset, bytes.length - offset, null));
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > cap) return { ok: false, reason: 'entry-too-large' };
    return { ok: true, text: bytes.subarray(0, offset).toString('utf8') };
  } finally {
    await handle.close();
  }
}

function sameMac(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

type ParsedEntry =
  | {
      readonly ok: true;
      readonly entry: HandoffSpoolEntry;
      readonly payload: Record<string, unknown>;
      readonly status: HandoffStatus;
      readonly summary: string;
    }
  | { readonly ok: false; readonly reason: string };

function parseEntry(
  text: string,
  binding: HandoffSpoolBinding,
  spoolId: string,
  entryName: string,
): ParsedEntry {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'entry-not-json' };
  }
  const parsed = entrySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'entry-schema-invalid' };
  const entry = parsed.data;
  const name = ENTRY_FILE_RE.exec(entryName);
  if (
    entry.spoolId !== spoolId ||
    !name ||
    name[1] !== String(entry.createdAt).padStart(13, '0') ||
    name[2] !== entry.entryId
  ) {
    return { ok: false, reason: 'entry-identity-mismatch' };
  }
  const { mac, ...unsigned } = entry;
  const expected = createHmac('sha256', binding.key).update(handoffSpoolSigningInput(unsigned)).digest('hex');
  if (!sameMac(mac, expected)) return { ok: false, reason: 'entry-mac-invalid' };
  let payload: unknown;
  try {
    payload = JSON.parse(entry.payload);
  } catch {
    return { ok: false, reason: 'payload-not-json' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload-not-object' };
  }
  try {
    // Mesmos limites do despacho MCP (256 KiB, profundidade, chaves, arrays).
    validateToolArgs('nexus_handoff_submit', payload);
  } catch {
    return { ok: false, reason: 'payload-limits' };
  }
  const record = payload as Record<string, unknown>;
  const status = handoffStatusSchema.safeParse(normalizeHandoffStatusInput(record.status));
  if (!status.success || !AGENT_STATUSES.has(status.data)) return { ok: false, reason: 'payload-status-invalid' };
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  if (!summary) return { ok: false, reason: 'payload-summary-missing' };
  if (record.artifacts !== undefined && !Array.isArray(record.artifacts)) {
    return { ok: false, reason: 'payload-artifacts-invalid' };
  }
  return { ok: true, entry, payload: record, status: status.data, summary };
}

function isSpoolArtifactFor(artifact: unknown, entryId: string): boolean {
  if (!artifact || typeof artifact !== 'object') return false;
  const value = artifact as { kind?: unknown; payload?: unknown };
  return (
    value.kind === HANDOFF_SPOOL_ARTIFACT_KIND &&
    !!value.payload &&
    typeof value.payload === 'object' &&
    (value.payload as { entryId?: unknown }).entryId === entryId
  );
}

function findDuplicate(
  existing: readonly Handoff[],
  binding: HandoffSpoolBinding,
  entry: HandoffSpoolEntry,
  rawPayloadSha256: string,
): { readonly kind: 'already-ingested' | 'delivered-by-transport'; readonly handoffId: string } | null {
  for (const handoff of existing) {
    if (binding.sessionId && handoff.sessionId !== binding.sessionId) continue;
    if (handoff.artifacts.some((artifact) => isSpoolArtifactFor(artifact, entry.entryId))) {
      return { kind: 'already-ingested', handoffId: handoff.id };
    }
    if (handoff.mcpProvenance?.rawPayloadSha256 === rawPayloadSha256) {
      return { kind: 'delivered-by-transport', handoffId: handoff.id };
    }
  }
  return null;
}

/** Mesma forma dos artifacts que `nexus_handoff_submit` deriva dos campos extras. */
function derivedArtifacts(payload: Record<string, unknown>): Array<{ kind: string; payload: unknown }> {
  const artifacts: Array<{ kind: string; payload: unknown }> = [];
  if (typeof payload.briefId === 'string' && payload.briefId) {
    artifacts.push({ kind: 'overclock.briefId', payload: payload.briefId });
  }
  if (typeof payload.to === 'string' && payload.to) artifacts.push({ kind: 'overclock.to', payload: payload.to });
  if (typeof payload.fullText === 'string' && payload.fullText) {
    artifacts.push({ kind: 'overclock.fullText', payload: capHandoffFullText(payload.fullText) });
  }
  if (payload.evidence !== undefined) artifacts.push({ kind: 'overclock.evidence', payload: payload.evidence });
  for (const field of ['accomplished', 'blockers', 'nextSteps'] as const) {
    if (payload[field] !== undefined) artifacts.push({ kind: `context.${field}`, payload: payload[field] });
  }
  if (payload.contextDag !== undefined) artifacts.push({ kind: 'context.dag', payload: payload.contextDag });
  return artifacts;
}

function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function buildSubmitInput(
  binding: HandoffSpoolBinding,
  parsed: Extract<ParsedEntry, { ok: true }>,
  rawPayloadSha256: string,
  ingestedAt: number,
): HandoffSpoolSubmitInput {
  const { entry, payload } = parsed;
  const condensed = condenseHandoffSummary(parsed.summary);
  const declaredFullText = typeof payload.fullText === 'string' && payload.fullText.length > 0;
  const telemetry = sanitizeHandoffTelemetry(payload.telemetry);
  const filesModified = Array.isArray(payload.filesModified)
    ? payload.filesModified
    : Array.isArray(payload['files-modified'])
      ? payload['files-modified']
      : undefined;
  return {
    status: parsed.status,
    // O orquestrador lê isto colado no PTY: diz que chegou atrasado e por quê.
    summary: `[via spool ${clock(entry.createdAt)}] ${condensed.summary}`,
    artifacts: [
      ...(Array.isArray(payload.artifacts) ? payload.artifacts : []),
      ...derivedArtifacts(payload),
      ...(condensed.condensed && condensed.original !== undefined && !declaredFullText
        ? [{ kind: 'overclock.fullText', payload: capHandoffFullText(condensed.original) }]
        : []),
      ...(telemetry ? [embedTelemetryArtifact(telemetry)] : []),
      {
        kind: HANDOFF_SPOOL_ARTIFACT_KIND,
        payload: {
          entryId: entry.entryId,
          spoolId: entry.spoolId,
          transport: entry.transport,
          spooledAt: entry.createdAt,
          ingestedAt,
          rawPayloadSha256,
          ...(entry.requestId ? { requestId: entry.requestId } : {}),
          // Evidência declarada NÃO é resolvida: o spool nunca vira handoff confiável.
          ...(Array.isArray(payload.evidenceIds) ? { declaredEvidenceIds: payload.evidenceIds } : {}),
          ...(filesModified ? { declaredFilesModified: filesModified } : {}),
        },
      },
    ],
    missionId: binding.missionId,
    ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
    ...(binding.workerIncarnationId ? { workerIncarnationId: binding.workerIncarnationId } : {}),
    fromAgent: binding.agentLabel,
  };
}

async function writeReceipt(layout: Layout, entryId: string, receipt: Record<string, unknown>, owner: SpoolState): Promise<void> {
  await ensurePrivateDirectory(layout.ingested, owner);
  const target = path.join(layout.ingested, `${entryId}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await waitCurrent(owner, fs.promises.writeFile(temporary, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }));
    await waitCurrent(owner, fs.promises.rename(temporary, target));
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

async function quarantineClaimed(
  layout: Layout,
  claimedPath: string,
  spoolId: string,
  entryName: string,
  reason: string,
  now: number,
  owner: SpoolState,
): Promise<void> {
  await ensurePrivateDirectory(layout.quarantine, owner);
  const target = path.join(layout.quarantine, `${spoolId}--${entryName}`);
  try {
    await waitCurrent(owner, fs.promises.rename(claimedPath, target));
    await waitCurrent(owner, fs.promises.writeFile(
      `${target}.reason.json`,
      `${JSON.stringify({ reason, spoolId, entry: entryName, at: now })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    ));
  } catch (error) {
    if (error === RETIRED_SPOOL) throw error;
    console.warn('[handoff-spool] quarentena falhou (entrada mantida onde está):', error);
  }
  trace({ kind: 'handoff-spool-quarantined', spoolId, entry: entryName, reason });
}

/** Falha transitória (banco ocupado, store fora): volta para a fila da sessão. */
async function requeueClaimed(layout: Layout, claimedPath: string, spoolId: string, entryName: string, owner: SpoolState): Promise<void> {
  assertCurrent(owner);
  const sessionDir = path.join(layout.sessions, spoolId);
  if (!(await waitCurrent(owner, exists(sessionDir)))) return; // fica em processing/; o boot retoma
  try {
    await waitCurrent(owner, fs.promises.rename(claimedPath, path.join(sessionDir, entryName)));
  } catch (error) {
    if (error === RETIRED_SPOOL) throw error;
    // Fica em processing/; a próxima passada retoma de lá.
  }
}

async function processClaimed(
  layout: Layout,
  owner: SpoolState,
  spoolId: string,
  entryName: string,
  claimedPath: string,
  bindingResult: BindingResult,
  report: HandoffSpoolIngestReport,
): Promise<void> {
  assertCurrent(owner);
  const deps = owner.deps;
  const now = (deps.now ?? Date.now)();
  const quarantine = async (reason: string): Promise<void> => {
    await quarantineClaimed(layout, claimedPath, spoolId, entryName, reason, now, owner);
    report.quarantined += 1;
  };
  if (!bindingResult.ok) return quarantine(bindingResult.reason);
  const binding = bindingResult.binding;
  const read = await readClaimedEntry(claimedPath, owner);
  assertCurrent(owner);
  if (!read.ok) return quarantine(read.reason);
  const parsed = parseEntry(read.text, binding, spoolId, entryName);
  if (!parsed.ok) return quarantine(parsed.reason);
  const { entry } = parsed;
  const receiptPath = path.join(layout.ingested, `${entry.entryId}.json`);
  if (await waitCurrent(owner, exists(receiptPath))) {
    await waitCurrent(owner, fs.promises.rm(claimedPath, { force: true }));
    report.duplicates += 1;
    return;
  }
  const rawPayloadSha256 = handoffRawPayloadSha256(parsed.payload);
  try {
    assertCurrent(owner);
    const stores = deps.getStores(binding.scope);
    assertCurrent(owner);
    if (!stores.missions.get(binding.missionId)) return quarantine('mission-missing');
    const existing = stores.handoffs.list({
      missionId: binding.missionId,
      includeDelivered: true,
      ...(binding.sessionId ? { sessionIds: [binding.sessionId] } : {}),
    });
    const duplicate = findDuplicate(existing, binding, entry, rawPayloadSha256);
    if (duplicate) {
      await writeReceipt(layout, entry.entryId, {
        entryId: entry.entryId, spoolId, outcome: duplicate.kind, handoffId: duplicate.handoffId, at: now,
      }, owner);
      await waitCurrent(owner, fs.promises.rm(claimedPath, { force: true }));
      report.duplicates += 1;
      trace({
        kind: 'handoff-spool-duplicate', spoolId, entryId: entry.entryId, outcome: duplicate.kind,
        handoffId: duplicate.handoffId, missionId: binding.missionId,
      });
      return;
    }
    assertCurrent(owner);
    const handoff = stores.handoffs.submit(buildSubmitInput(binding, parsed, rawPayloadSha256, now));
    // Recibo ANTES de qualquer efeito opcional: a partir daqui a entrada é feita.
    await writeReceipt(layout, entry.entryId, {
      entryId: entry.entryId, spoolId, outcome: 'ingested', handoffId: handoff.id,
      missionId: binding.missionId, transport: entry.transport, at: now,
    }, owner);
    await waitCurrent(owner, fs.promises.rm(claimedPath, { force: true }));
    report.ingested += 1;
    trace({
      kind: 'handoff-spool-ingested', spoolId, entryId: entry.entryId, transport: entry.transport,
      missionId: binding.missionId, ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
      handoffId: handoff.id, status: handoff.status, spooledAt: entry.createdAt,
    });
    try {
      assertCurrent(owner);
      await waitCurrent(owner, Promise.resolve(deps.deliver(handoff, binding.scope)));
    } catch (error) {
      if (error === RETIRED_SPOOL) throw error;
      // O handoff é durável; a outbox re-arma a entrega quando o Maestro voltar.
      console.warn('[handoff-spool] entrega ao orquestrador adiada:', error);
    }
  } catch (error) {
    if (error === RETIRED_SPOOL) throw error;
    await requeueClaimed(layout, claimedPath, spoolId, entryName, owner);
    report.failed += 1;
    trace({
      kind: 'handoff-spool-retry', spoolId, entryId: entry.entryId,
      detail: (error instanceof Error ? error.message : String(error)).slice(0, 200),
    });
  }
}

async function removeStaleTemp(directory: string, name: string, now: number, owner: SpoolState): Promise<void> {
  assertCurrent(owner);
  try {
    const stat = await waitCurrent(owner, fs.promises.lstat(path.join(directory, name)));
    if (now - stat.mtimeMs > STALE_TEMP_MS) await waitCurrent(owner, fs.promises.rm(path.join(directory, name), { force: true }));
  } catch (error) {
    if (error === RETIRED_SPOOL) throw error;
    // Escrita em curso ou já removido.
  }
}

async function maybeRemoveSession(
  layout: Layout,
  spoolId: string,
  bindingResult: BindingResult,
  now: number,
  owner: SpoolState,
): Promise<void> {
  assertCurrent(owner);
  if (liveSpools.has(spoolId)) return;
  const directory = path.join(layout.sessions, spoolId);
  if ((await waitCurrent(owner, readdirSafe(directory))).length > 0) return;
  const foreignAndRecent =
    !disposedInProcess.has(spoolId) &&
    bindingResult.ok &&
    now - bindingResult.binding.createdAt < FOREIGN_BINDING_TTL_MS;
  // Sessão de outro processo (pty-daemon pode mantê-la viva) fica por 48 h.
  if (foreignAndRecent) return;
  await waitCurrent(owner, fs.promises.rm(directory, { recursive: true, force: true }));
  await waitCurrent(owner, fs.promises.rm(bindingPath(layout, spoolId), { force: true }));
  disposedInProcess.delete(spoolId);
}

async function gcReceipts(layout: Layout, now: number, owner: SpoolState): Promise<void> {
  for (const name of await waitCurrent(owner, readdirSafe(layout.ingested))) {
    const file = path.join(layout.ingested, name);
    try {
      const stat = await waitCurrent(owner, fs.promises.lstat(file));
      if (now - stat.mtimeMs > RECEIPT_TTL_MS) await waitCurrent(owner, fs.promises.rm(file, { force: true }));
    } catch (error) {
      if (error === RETIRED_SPOOL) throw error;
      // Já removido.
    }
  }
}

async function runIngestPass(owner: SpoolState): Promise<HandoffSpoolIngestReport> {
  assertCurrent(owner);
  const report = emptyReport();
  const layout = layoutOf(owner.root);
  const now = (owner.deps.now ?? Date.now)();
  if (!(await waitCurrent(owner, exists(layout.root)))) return report;
  for (const directory of [layout.processing, layout.ingested, layout.quarantine]) {
    await ensurePrivateDirectory(directory, owner);
  }
  // 1) Reivindicadas e não terminadas (o Main caiu no meio): o dedupe torna
  //    a retomada idempotente.
  for (const name of await waitCurrent(owner, readdirSafe(layout.processing))) {
    const match = /^([0-9a-f-]{36})--(.+)$/.exec(name);
    if (!match || !UUID_RE.test(match[1]) || !ENTRY_FILE_RE.test(match[2])) continue;
    await processClaimed(
      layout, owner, match[1], match[2], path.join(layout.processing, name),
      await loadBinding(layout, match[1], owner), report,
    );
  }
  // 2) Diretórios das sessões.
  for (const spoolId of await waitCurrent(owner, readdirSafe(layout.sessions))) {
    if (!UUID_RE.test(spoolId)) continue;
    const directory = path.join(layout.sessions, spoolId);
    try {
      const stat = await waitCurrent(owner, fs.promises.lstat(directory));
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    } catch (error) {
      if (error === RETIRED_SPOOL) throw error;
      continue;
    }
    const bindingResult = await loadBinding(layout, spoolId, owner);
    const names = await waitCurrent(owner, readdirSafe(directory));
    const pending = names.filter((name) => ENTRY_FILE_RE.test(name));
    if (
      pending.length > 0 &&
      bindingResult.ok &&
      bindingResult.binding.sessionId &&
      hasHandoffSubmitInFlight(bindingResult.binding.sessionId)
    ) {
      // O original ainda pode commitar: espera ele terminar (onHandoffSubmitSettled).
      deferredSessions.add(bindingResult.binding.sessionId);
      report.deferred += pending.length;
      continue;
    }
    let processed = 0;
    for (const name of names) {
      if (name.startsWith('.')) {
        await removeStaleTemp(directory, name, now, owner);
        continue;
      }
      if (!ENTRY_FILE_RE.test(name)) continue;
      if (processed >= MAX_ENTRIES_PER_PASS) {
        rerun = true;
        break;
      }
      const claimed = path.join(layout.processing, `${spoolId}--${name}`);
      try {
        await waitCurrent(owner, fs.promises.rename(path.join(directory, name), claimed));
      } catch (error) {
        if (error === RETIRED_SPOOL) throw error;
        continue; // outra passada pegou primeiro
      }
      processed += 1;
      await processClaimed(layout, owner, spoolId, name, claimed, bindingResult, report);
    }
    await maybeRemoveSession(layout, spoolId, bindingResult, now, owner);
  }
  await gcReceipts(layout, now, owner);
  return report;
}

/** Testes. */
export function resetHandoffSpoolForTests(): Promise<void> {
  const physical = stopHandoffSpool();
  disposedInProcess.clear();
  rerun = false;
  return physical;
}
