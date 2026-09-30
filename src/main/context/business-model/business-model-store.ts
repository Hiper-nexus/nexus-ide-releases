import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import type { BusinessModelDocument } from './business-model-contract';
import type { BusinessHurdle } from './business-model-hurdles';

/**
 * Store do modelo EXTRAÍDO — separado do `business-model-attested-store`.
 *
 * O attested-store guarda os hashes do doc REVISADO `.context/docs/business-
 * model.md` (quem autoriza injetar esse doc como contexto). Aqui mora o modelo
 * que o Main extraiu deterministicamente do HEAD, por commit, fora do checkout:
 * a seleção por tarefa (Jev + fallback lexical) e o risco de negócio do portão
 * leem daqui, sem precisar que o doc revisado exista.
 *
 * Um arquivo por headSha por projeto (worktrees do mesmo projeto dividem o
 * store: escopo = installationId + projectId). Reuso barato: HEAD igual =
 * arquivo já gravado. Escrita atômica (temp + rename, 0600); leitura nunca
 * lança — store ausente/corrompido é só "sem modelo".
 */

const STORE_SCHEMA = 'nexus.business-model/v2';
const MAX_STORE_BYTES = 12 * 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_FILES_PER_PROJECT = 8;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

export interface StoredBusinessModel {
  readonly schema: typeof STORE_SCHEMA;
  readonly installationId: string;
  readonly projectId: string;
  readonly headSha: string;
  readonly fingerprint: string;
  readonly extractedAt: number;
  readonly document: BusinessModelDocument;
  readonly hurdles: readonly BusinessHurdle[];
}

export interface WriteBusinessModelInput {
  readonly headSha: string;
  readonly fingerprint: string;
  readonly document: BusinessModelDocument;
  readonly hurdles: readonly BusinessHurdle[];
  readonly extractedAt?: number;
}

let configuredDir: string | null = null;

/** Base explícita (testes, ambientes fora do Electron). `null` volta ao padrão. */
export function configureBusinessModelStore(dir: string | null): void {
  configuredDir = dir;
}

export function isBusinessModelStoreConfigured(): boolean {
  return configuredDir !== null;
}

function storeDir(): string {
  if (configuredDir) return configuredDir;
  // Require tardio: fora do Electron (vitest) `electron` não expõe `app`.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electron = require('electron') as { app?: { getPath(name: 'userData'): string } };
  if (typeof electron?.app?.getPath !== 'function') {
    throw new Error('business model store requires configureBusinessModelStore outside Electron');
  }
  return path.join(electron.app.getPath('userData'), 'business-model');
}

function projectDir(scope: ProjectExecutionScope): string {
  const key = createHash('sha256')
    .update(`${scope.installationId}\0${scope.projectId}`)
    .digest('hex')
    .slice(0, 32);
  return path.join(storeDir(), key);
}

function modelFile(scope: ProjectExecutionScope, headSha: string): string {
  return path.join(projectDir(scope), `${headSha}.json`);
}

function stringList(value: unknown, max = 64): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, max)
    : [];
}

function parseStoredDocument(raw: unknown): BusinessModelDocument | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const doc = raw as { schemaVersion?: unknown; flows?: unknown; invariants?: unknown };
  if (doc.schemaVersion !== 1 || !Array.isArray(doc.flows) || !Array.isArray(doc.invariants)) return null;
  const flows: BusinessModelDocument['flows'][number][] = [];
  for (const item of doc.flows) {
    if (typeof item !== 'object' || item === null) return null;
    const flow = item as Record<string, unknown>;
    if (typeof flow.fluxo !== 'string' || typeof flow.definicao !== 'string') return null;
    flows.push(Object.freeze({
      fluxo: flow.fluxo,
      definicao: flow.definicao,
      escreve: Object.freeze(stringList(flow.escreve)),
      le: Object.freeze(stringList(flow.le)),
      funcoes: Object.freeze(stringList(flow.funcoes)),
      arquivos: Object.freeze(stringList(flow.arquivos)),
      testes: Object.freeze(stringList(flow.testes)),
    }));
  }
  const invariants: BusinessModelDocument['invariants'][number][] = [];
  for (const item of doc.invariants) {
    if (typeof item !== 'object' || item === null) return null;
    const invariant = item as Record<string, unknown>;
    if (
      typeof invariant.id !== 'string' ||
      typeof invariant.fluxo !== 'string' ||
      typeof invariant.regra !== 'string' ||
      typeof invariant.origem !== 'string'
    ) return null;
    invariants.push(Object.freeze({
      id: invariant.id,
      fluxo: invariant.fluxo,
      regra: invariant.regra,
      origem: invariant.origem,
      arquivos: Object.freeze(stringList(invariant.arquivos)),
      tabelas: Object.freeze(stringList(invariant.tabelas)),
      funcoes: Object.freeze(stringList(invariant.funcoes)),
      testes: Object.freeze(stringList(invariant.testes)),
    }));
  }
  return Object.freeze({
    schemaVersion: 1,
    flows: Object.freeze(flows),
    invariants: Object.freeze(invariants),
  });
}

function parseStoredHurdles(raw: unknown): BusinessHurdle[] {
  if (!Array.isArray(raw)) return [];
  const hurdles: BusinessHurdle[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const hurdle = item as Record<string, unknown>;
    if (
      typeof hurdle.id !== 'string' ||
      typeof hurdle.titulo !== 'string' ||
      typeof hurdle.resumo !== 'string' ||
      typeof hurdle.origem !== 'string'
    ) continue;
    hurdles.push(Object.freeze({
      id: hurdle.id,
      titulo: hurdle.titulo,
      resumo: hurdle.resumo,
      origem: hurdle.origem,
    }));
  }
  return hurdles;
}

function parseStored(raw: unknown, scope: ProjectExecutionScope): StoredBusinessModel | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (
    value.schema !== STORE_SCHEMA ||
    value.installationId !== scope.installationId ||
    value.projectId !== scope.projectId ||
    typeof value.headSha !== 'string' ||
    !SHA_PATTERN.test(value.headSha) ||
    typeof value.fingerprint !== 'string' ||
    typeof value.extractedAt !== 'number' ||
    !Number.isFinite(value.extractedAt)
  ) return null;
  const document = parseStoredDocument(value.document);
  if (!document) return null;
  return Object.freeze({
    schema: STORE_SCHEMA,
    installationId: scope.installationId,
    projectId: scope.projectId,
    headSha: value.headSha,
    fingerprint: value.fingerprint,
    extractedAt: value.extractedAt,
    document,
    hurdles: Object.freeze(parseStoredHurdles(value.hurdles)),
  });
}

function readModelFile(file: string, scope: ProjectExecutionScope): StoredBusinessModel | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) return null;
    return parseStored(JSON.parse(fs.readFileSync(file, 'utf8')), scope);
  } catch {
    return null;
  }
}

function pruneProjectDir(dir: string, keep: string): void {
  try {
    const entries = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json') && name !== keep)
      .map((name) => ({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const entry of entries.slice(MAX_FILES_PER_PROJECT - 1)) {
      try {
        fs.rmSync(path.join(dir, entry.name), { force: true });
      } catch {
        // Poda é best-effort: um arquivo a mais nunca impede o modelo.
      }
    }
  } catch {
    // Diretório legível é requisito só da leitura, não da escrita.
  }
}

/**
 * Grava o modelo extraído do HEAD. Nunca lança por I/O ou tamanho — o chamador
 * mantém o objeto em memória mesmo quando o disco falha. Devolve o registro
 * gravado (ou o que seria gravado) para o chamador não depender do disco.
 */
export function writeBusinessModel(
  scope: ProjectExecutionScope,
  input: WriteBusinessModelInput,
): StoredBusinessModel {
  const record = Object.freeze({
    schema: STORE_SCHEMA,
    installationId: scope.installationId,
    projectId: scope.projectId,
    headSha: input.headSha,
    fingerprint: input.fingerprint,
    extractedAt: input.extractedAt ?? Date.now(),
    document: input.document,
    hurdles: Object.freeze([...input.hurdles]),
  }) as StoredBusinessModel;
  try {
    const serialized = JSON.stringify(record);
    // headSha fora do padrão nunca vira nome de arquivo (path traversal).
    if (Buffer.byteLength(serialized, 'utf8') > MAX_WRITE_BYTES || !SHA_PATTERN.test(record.headSha)) {
      return record;
    }
    const file = modelFile(scope, record.headSha);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, serialized, { mode: 0o600 });
    fs.renameSync(temp, file);
    pruneProjectDir(path.dirname(file), path.basename(file));
  } catch {
    // Falha de disco não apaga o modelo da sessão.
  }
  return record;
}

/** Modelo extraído de um commit específico. Nunca lança. */
export function readBusinessModelAt(
  scope: ProjectExecutionScope,
  headSha: string,
): StoredBusinessModel | null {
  if (!SHA_PATTERN.test(headSha)) return null;
  try {
    return readModelFile(modelFile(scope, headSha), scope);
  } catch {
    return null;
  }
}

/** Modelo mais recente gravado (qualquer HEAD). Nunca lança. */
export function readLatestBusinessModel(
  scope: ProjectExecutionScope,
): StoredBusinessModel | null {
  try {
    const dir = projectDir(scope);
    const candidates = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          return { name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs };
        } catch {
          return { name, mtimeMs: 0 };
        }
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const candidate of candidates) {
      const model = readModelFile(path.join(dir, candidate.name), scope);
      if (model) return model;
    }
    return null;
  } catch {
    return null;
  }
}
