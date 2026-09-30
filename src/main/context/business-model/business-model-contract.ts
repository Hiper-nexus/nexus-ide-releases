import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import { openWorkspaceFileForRead, readWorkspaceTextFile } from '../../orch/workspace-file';
import { resolveProjectExecutionScopeCached } from '../../persistence/project-identity';
import {
  ATTESTATION_ROOT,
  parseContextAttestation,
  type ContextAttestation,
} from '../context-attestation';
import { isAttestedBusinessModelHash } from './business-model-attested-store';
import { readBusinessModelAt, readLatestBusinessModel } from './business-model-store';
import type { StoredBusinessModel } from './business-model-store';
import type { BusinessHurdle } from './business-model-hurdles';
import { ProcessGitRunner } from '../../runtime/git-command';

/**
 * CONTRATO do modelo de negócio do projeto (`.context/docs/business-model.md`).
 *
 * O doc é extraído deterministicamente de fontes versionadas (migrations SQL,
 * AGENTS.md, specs, testes) e aplicado pelo fluxo de draft/revisão do
 * `.context`. Além das seções legíveis, ele carrega um bloco JSON estruturado
 * depois de `BUSINESS_MODEL_JSON_MARKER`; é esse bloco que este módulo lê.
 * Consumidores: o bloco `<business-model>` do brief/primeiro prompt e o portão
 * de regressão (que cruza arquivos alterados com `arquivos`/`testes`).
 *
 * Só vale o doc REVISADO: o hash dos bytes em disco precisa estar no registro
 * do Main (`business-model-attested-store`, fora do checkout), gravado só pelo
 * caminho do extrator+revisor. A atestação em `.context/nexus/attestations/` é
 * espelho informativo: o agente escreve ali, então ela não autoriza nada. Um doc
 * editado à mão ou plantado por um worker (mesmo com marcador, JSON e atestação
 * válidos) não vira instrução de nenhum pane. A leitura é escopada ao projeto:
 * symlink em qualquer componente do caminho (`.context`, `.context/docs`) é recusado.
 */

export const BUSINESS_MODEL_TARGET_PATH = '.context/docs/business-model.md';
export const BUSINESS_MODEL_JSON_MARKER = '<!-- nexus:business-model:v1 -->';
/** Autor (extrator) das atestações que o contrato aceita. */
export const BUSINESS_MODEL_EXTRACTOR_ID = 'nexus-business-model-extractor';
const MAX_DOC_BYTES = 1024 * 1024;
const MAX_ATTESTATION_BYTES = 1024 * 1024;

export interface BusinessInvariant {
  /** Estável enquanto a regra não muda de posição dentro do fluxo. */
  readonly id: string;
  /** Nome do fluxo (função SQL que escreve tabelas) ou `projeto` para regra global. */
  readonly fluxo: string;
  /** Texto copiado da fonte (mensagem de RAISE, constraint, linha de regra). */
  readonly regra: string;
  /** `arquivo:linha` de onde a regra foi copiada. */
  readonly origem: string;
  readonly arquivos: readonly string[];
  readonly tabelas: readonly string[];
  readonly funcoes: readonly string[];
  readonly testes: readonly string[];
}

export interface BusinessFlow {
  readonly fluxo: string;
  /** `arquivo:linha` da definição vigente (última na ordem das migrations). */
  readonly definicao: string;
  readonly escreve: readonly string[];
  readonly le: readonly string[];
  readonly funcoes: readonly string[];
  readonly arquivos: readonly string[];
  readonly testes: readonly string[];
}

export interface BusinessModelDocument {
  readonly schemaVersion: 1;
  readonly flows: readonly BusinessFlow[];
  readonly invariants: readonly BusinessInvariant[];
}

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? Object.freeze([...value])
    : null;
}

function parseInvariant(value: unknown): BusinessInvariant | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const arquivos = stringArray(raw.arquivos);
  const tabelas = stringArray(raw.tabelas);
  const funcoes = stringArray(raw.funcoes);
  const testes = stringArray(raw.testes);
  if (
    typeof raw.id !== 'string' ||
    typeof raw.fluxo !== 'string' ||
    typeof raw.regra !== 'string' ||
    typeof raw.origem !== 'string' ||
    !arquivos || !tabelas || !funcoes || !testes
  ) {
    return null;
  }
  return Object.freeze({
    id: raw.id,
    fluxo: raw.fluxo,
    regra: raw.regra,
    origem: raw.origem,
    arquivos,
    tabelas,
    funcoes,
    testes,
  });
}

function parseFlow(value: unknown): BusinessFlow | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const escreve = stringArray(raw.escreve);
  const le = stringArray(raw.le);
  const funcoes = stringArray(raw.funcoes);
  const arquivos = stringArray(raw.arquivos);
  const testes = stringArray(raw.testes);
  if (
    typeof raw.fluxo !== 'string' ||
    typeof raw.definicao !== 'string' ||
    !escreve || !le || !funcoes || !arquivos || !testes
  ) {
    return null;
  }
  return Object.freeze({
    fluxo: raw.fluxo,
    definicao: raw.definicao,
    escreve,
    le,
    funcoes,
    arquivos,
    testes,
  });
}

/** Lê o bloco estruturado do doc. Doc sem bloco (escrito à mão) → null. */
export function parseBusinessModelDocument(content: string): BusinessModelDocument | null {
  const markerAt = content.indexOf(BUSINESS_MODEL_JSON_MARKER);
  if (markerAt < 0) return null;
  const rest = content.slice(markerAt + BUSINESS_MODEL_JSON_MARKER.length);
  const match = /```json\n([\s\S]*?)\n```/.exec(rest);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]!);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.flows) || !Array.isArray(record.invariants)) {
    return null;
  }
  const flows = record.flows.map(parseFlow);
  const invariants = record.invariants.map(parseInvariant);
  if (flows.some((item) => item === null) || invariants.some((item) => item === null)) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    flows: Object.freeze(flows as BusinessFlow[]),
    invariants: Object.freeze(invariants as BusinessInvariant[]),
  });
}

function scopeFor(target: ProjectExecutionScope | string): ProjectExecutionScope {
  return typeof target === 'string' ? resolveProjectExecutionScopeCached(target) : target;
}

/**
 * Atestação (espelho no repo) do extrator que vincula `targetHash` ao doc do
 * modelo neste projeto. Só informa o bootstrap (fontes citadas); quem autoriza
 * a injeção é o registro do Main (`isAttestedBusinessModelHash`).
 */
export function findBusinessModelAttestation(
  scope: ProjectExecutionScope,
  targetHash: string,
): ContextAttestation | null {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(scope.rootRealPath, ATTESTATION_ROOT)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const read = readWorkspaceTextFile(scope, `${ATTESTATION_ROOT}/${name}`);
      if (read.size > MAX_ATTESTATION_BYTES) continue;
      const attestation = parseContextAttestation(JSON.parse(read.content) as unknown);
      if (
        name === `${attestation.id}.json` &&
        attestation.projectId === scope.projectId &&
        attestation.targetPath === BUSINESS_MODEL_TARGET_PATH &&
        attestation.targetHash === targetHash &&
        attestation.author.id === BUSINESS_MODEL_EXTRACTOR_ID
      ) {
        return attestation;
      }
    } catch {
      // Atestação ilegível/inválida não concede nada.
    }
  }
  return null;
}

/** Bytes do doc lidos pelo escopo do projeto (sem seguir symlink em nenhum componente). */
export function readBusinessModelTarget(
  scope: ProjectExecutionScope,
): { content: string; hash: string } | null {
  try {
    const handle = openWorkspaceFileForRead(scope, BUSINESS_MODEL_TARGET_PATH);
    try {
      if (handle.stat.size > MAX_DOC_BYTES) return null;
      const bytes = fs.readFileSync(handle.fd);
      return {
        content: bytes.toString('utf8'),
        hash: createHash('sha256').update(bytes).digest('hex'),
      };
    } finally {
      handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Lê o doc REVISADO do projeto. Ausente, fora do escopo, grande demais, sem
 * bloco estruturado ou com bytes que o Main não aplicou → null.
 * Nunca lança: quem consome é spawn/portão, que seguem sem modelo em vez de
 * quebrar. Aceita a raiz (resolve o escopo) ou o escopo já resolvido.
 */
export function readBusinessModelDocument(
  target: ProjectExecutionScope | string,
): BusinessModelDocument | null {
  try {
    const scope = scopeFor(target);
    const doc = readBusinessModelTarget(scope);
    if (!doc || !isAttestedBusinessModelHash(scope, doc.hash)) return null;
    return parseBusinessModelDocument(doc.content);
  } catch {
    return null;
  }
}

function sameProjectFallback(
  scope: ProjectExecutionScope,
  projectScope: ProjectExecutionScope | undefined,
): projectScope is ProjectExecutionScope {
  return Boolean(
    projectScope &&
      projectScope.installationId === scope.installationId &&
      projectScope.projectId === scope.projectId &&
      projectScope.rootRealPath !== scope.rootRealPath,
  );
}

// O store é por projeto — worktrees isoladas do MESMO projeto gravam na mesma
// pasta. "O mais novo gravado" podia ser o HEAD de um worker (revisão F-227):
// o pane do operador herdava o modelo da branch errada. Lê-se SÓ o modelo do
// HEAD atual do checkout; sem ele, vale o doc atestado.
const headReadCache = new Map<string, { at: number; headSha: string | null }>();
const HEAD_READ_TTL_MS = 5_000;
const syncGit = new ProcessGitRunner();

function currentHeadSha(rootRealPath: string): string | null {
  const now = Date.now();
  const cached = headReadCache.get(rootRealPath);
  if (cached && now - cached.at < HEAD_READ_TTL_MS) return cached.headSha;
  let headSha: string | null = null;
  try {
    const result = syncGit.run(rootRealPath, ['rev-parse', 'HEAD'], { timeoutMs: 5_000 });
    const sha = result.status === 0 ? result.stdout.trim() : '';
    headSha = /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    headSha = null;
  }
  headReadCache.set(rootRealPath, { at: now, headSha });
  return headSha;
}

function extractedAtHead(scope: ProjectExecutionScope): StoredBusinessModel | null {
  const headSha = currentHeadSha(scope.rootRealPath);
  // Sem HEAD não há branch para confundir (fixture, pasta sem repo): o
  // "mais novo" do projeto ainda é a melhor aproximação.
  return headSha
    ? readBusinessModelAt(scope, headSha)
    : readLatestBusinessModel(scope);
}

/**
 * Modelo de negócio para execução (contexto de prompt, risco do portão). A
 * ordem vale: o modelo EXTRAÍDO do HEAD atual do checkout vem primeiro; sem
 * ele, o doc REVISADO atestado cumpre o papel. Worktree de aba cai no escopo
 * do projeto (mesma instalação/projeto, raiz diferente). Nunca lança.
 */
export function readBusinessModelForExecution(
  scope: ProjectExecutionScope,
  projectScope?: ProjectExecutionScope,
): BusinessModelDocument | null {
  return extractedAtHead(scope)?.document ??
    readBusinessModelDocument(scope) ??
    (sameProjectFallback(scope, projectScope)
      ? extractedAtHead(projectScope)?.document ?? readBusinessModelDocument(projectScope)
      : null);
}

/**
 * Hurdles normalizadas do store extraído (doc revisado não as carrega).
 * Nunca lança: sem store → lista vazia.
 */
export function readBusinessHurdles(
  scope: ProjectExecutionScope,
  projectScope?: ProjectExecutionScope,
): readonly BusinessHurdle[] {
  return extractedAtHead(scope)?.hurdles ??
    (sameProjectFallback(scope, projectScope)
      ? extractedAtHead(projectScope)?.hurdles
      : undefined) ??
    Object.freeze([]);
}

/** Invariantes estruturados do projeto ({id, fluxo, regra, arquivos, tabelas, funcoes, testes}). */
export function readBusinessModelInvariants(
  target: ProjectExecutionScope | string,
): readonly BusinessInvariant[] {
  return readBusinessModelDocument(target)?.invariants ?? Object.freeze([]);
}

/**
 * Invariantes cujo fluxo é tocado por algum dos arquivos alterados (caminhos
 * relativos à raiz). Regras globais (`projeto`) só entram quando o próprio
 * arquivo de origem muda.
 */
export function invariantsTouchedBy(
  invariants: readonly BusinessInvariant[],
  changedFiles: readonly string[],
): readonly BusinessInvariant[] {
  const changed = new Set(changedFiles.map((file) => file.replaceAll('\\', '/').replace(/^\.\//, '')));
  return Object.freeze(
    invariants.filter((invariant) =>
      invariant.arquivos.some((file) => changed.has(file)) ||
      invariant.testes.some((file) => changed.has(file)),
    ),
  );
}
