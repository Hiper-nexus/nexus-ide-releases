import fs from 'node:fs';
import path from 'node:path';

/**
 * CONTRATO do modelo de negócio do projeto (`.context/docs/business-model.md`).
 *
 * O doc é extraído deterministicamente de fontes versionadas (migrations SQL,
 * AGENTS.md, specs, testes) e aplicado pelo fluxo de draft/revisão do
 * `.context`. Além das seções legíveis, ele carrega um bloco JSON estruturado
 * depois de `BUSINESS_MODEL_JSON_MARKER`; é esse bloco que este módulo lê.
 * Consumidores: o bloco `<business-model>` do brief/primeiro prompt e o portão
 * de regressão (que cruza arquivos alterados com `arquivos`/`testes`).
 */

export const BUSINESS_MODEL_TARGET_PATH = '.context/docs/business-model.md';
export const BUSINESS_MODEL_JSON_MARKER = '<!-- nexus:business-model:v1 -->';
const MAX_DOC_BYTES = 1024 * 1024;

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

/**
 * Lê o doc aplicado do projeto. Ausente, symlink, grande demais ou sem bloco
 * estruturado → null. Nunca lança: quem consome é spawn/portão, que seguem
 * sem modelo em vez de quebrar.
 */
export function readBusinessModelDocument(projectRoot: string): BusinessModelDocument | null {
  try {
    const absolute = path.join(projectRoot, BUSINESS_MODEL_TARGET_PATH);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DOC_BYTES) return null;
    return parseBusinessModelDocument(fs.readFileSync(absolute, 'utf8'));
  } catch {
    return null;
  }
}

/** Invariantes estruturados do projeto ({id, fluxo, regra, arquivos, tabelas, funcoes, testes}). */
export function readBusinessModelInvariants(projectRoot: string): readonly BusinessInvariant[] {
  return readBusinessModelDocument(projectRoot)?.invariants ?? Object.freeze([]);
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
