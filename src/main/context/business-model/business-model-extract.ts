import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncProcessGitRunner, type AsyncGitRunner } from '../../runtime/git-command';
import { isSafeBootstrapSourceLocator } from '../orientation/orientation-bootstrap-context';
import type { BootstrapDocProposal } from '../orientation/orientation-bootstrap-types';
import { maskSqlComments } from '../orientation/orientation-sql-scan';
import {
  BUSINESS_MODEL_JSON_MARKER,
  BUSINESS_MODEL_TARGET_PATH,
  type BusinessFlow,
  type BusinessInvariant,
  type BusinessModelDocument,
} from './business-model-contract';
import {
  isHurdleDoc,
  parseBusinessHurdles,
  type BusinessHurdle,
} from './business-model-hurdles';

/**
 * Extração DETERMINÍSTICA do modelo de negócio: nenhuma interpretação, só
 * cópia com proveniência (arquivo:linha) de fontes versionadas e limpas.
 *
 *  - migrations SQL: função que escreve tabela = fluxo; RAISE EXCEPTION da
 *    função, CHECK/UNIQUE das tabelas que ela escreve e triggers nessas
 *    tabelas = invariantes/acoplamentos do fluxo;
 *  - AGENTS.md / CLAUDE.md / GEMINI.md e docs de regras/specs: linhas de lista
 *    com "nunca/sempre/must/never…" = regras do projeto;
 *  - testes e código: arquivos que citam a função (`rpc('fn')`, nome no teste).
 *
 * Só arquivos rastreados e sem alteração local entram: o commit do `.context`
 * exige cada fonte commitada no HEAD com o hash atestado. Fonte relevante com
 * alteração local vai para `pendingSources` (o bootstrap adia em vez de
 * publicar um modelo que parece completo sem ela).
 *
 * Dois modos de leitura (`options.source`):
 *  - `worktree` (padrão): o comportamento acima, para o doc revisado;
 *  - `head`: lê o modelo do HEAD — arquivo limpo vem do disco, arquivo sujo
 *    vem do blob `HEAD:<path>`, então AGENTS.md sujo ou migration editada não
 *    adiam nada. `pendingSources` fica vazio por definição.
 *
 * Roda no processo main: git assíncrono e leitura de arquivo com `await`, então
 * a varredura cede o event loop a cada arquivo (IPC/PTY seguem atendidos).
 */

export const BUSINESS_MODEL_MARKER_LINE =
  '> Extraído deterministicamente pelo Nexus de fontes versionadas. Não edite à mão: o Nexus re-extrai quando as fontes mudam.';

const MAX_SOURCE_BYTES = 1_000_000;
/** Doc de regra pode ser grande (AGENTS-HURDLES.md real tem ~2.3 MB). */
const MAX_RULE_DOC_BYTES = 8_000_000;
const MAX_SCANNED_FILES = 30_000;
const MAX_ATTESTED_SOURCES = 256;
const MAX_CANDIDATE_FLOWS = 60;
const MAX_FLOWS = 24;
const MAX_INVARIANTS_PER_FLOW = 8;
const MAX_RAISES_PER_FLOW = 3;
const MAX_TRIGGERS_PER_FLOW = 2;
const MAX_PROJECT_RULES = 30;
const MAX_REFS_PER_FLOW = 6;
const MAX_RULE_CHARS = 220;

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
const ROOT_RULE_DOCS = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
const RULE_DOC_BASENAME = /(regra|rule|invariant|business|neg[oó]cio|hurdle|domain|dom[ií]nio|spec)/i;
const NOISE_SEGMENT = /^(node_modules|vendor|dist|build|coverage|\.next|out)$|\.bak|^_bmad(?!-output)/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go)$|(^|\/)test_[^/]*\.py$/i;
const RULE_WORD = /\b(nunca|jamais|sempre|obrigat[óo]ri[oa]s?|proibid[oa]|n[ãa]o pode|must|never|always|required|do not|don't)\b/i;
const NAME = String.raw`((?:"?[A-Za-z_][\w$]*"?\.)?"?[A-Za-z_][\w$]*"?)`;

interface TrackedFile {
  readonly path: string;
  readonly blob: string;
}

interface SqlFunction {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly writes: readonly string[];
  readonly reads: readonly string[];
  readonly raises: readonly { readonly line: number; readonly message: string }[];
}

interface SqlConstraint {
  readonly table: string;
  readonly key: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

interface SqlTrigger {
  readonly name: string;
  readonly table: string;
  readonly fn: string;
  readonly file: string;
  readonly line: number;
}

interface SqlModel {
  readonly tables: Map<string, string>;
  readonly functions: Map<string, SqlFunction>;
  readonly constraints: Map<string, SqlConstraint>;
  readonly triggers: Map<string, SqlTrigger>;
}

interface ProjectRule {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface BusinessModelExtraction {
  readonly fingerprint: string;
  readonly document: BusinessModelDocument;
  readonly proposal: BootstrapDocProposal;
  /** Fontes relevantes (SQL, regra, código/teste que cita um fluxo) com alteração local. */
  readonly pendingSources: readonly string[];
  /** Hurdles normalizadas dos docs de armadilha (inertes, com proveniência). */
  readonly hurdles: readonly BusinessHurdle[];
}

function normalizeName(raw: string): string {
  const parts = raw.replaceAll('"', '').toLowerCase().split('.');
  return parts.length === 2 && parts[0] === 'public' ? parts[1]! : parts.join('.');
}

function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/** Uma linha só, sem caractere de controle (ESC/BEL cru da fonte derrubaria o prompt do PTY). */
function collapse(text: string, max = MAX_RULE_CHARS): string {
  const flat = text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function statementAt(text: string, offset: number): string {
  const end = text.indexOf(';', offset);
  return collapse(text.slice(offset, end < 0 ? undefined : end));
}

/** Corpo entre o primeiro `$tag$` após o cabeçalho e o `$tag$` que o fecha. */
function functionBody(text: string, from: number): { start: number; end: number } | null {
  const opener = /\$([A-Za-z_]\w*)?\$/g;
  opener.lastIndex = from;
  const open = opener.exec(text);
  if (!open) return null;
  // Um `;` antes do corpo encerra o CREATE sem corpo dollar-quoted.
  const semicolon = text.indexOf(';', from);
  if (semicolon >= 0 && semicolon < open.index) return null;
  const close = text.indexOf(open[0], open.index + open[0].length);
  if (close < 0) return null;
  return { start: open.index + open[0].length, end: close };
}

function collectNames(body: string, pattern: RegExp, tables: ReadonlySet<string>): string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(pattern)) {
    const name = normalizeName(match[1]!);
    if (tables.has(name)) names.add(name);
  }
  return [...names].sort();
}

function parseSqlFiles(sources: readonly { path: string; text: string }[]): SqlModel {
  // Os padrões abaixo casam sobre o texto: comentário (`-- drop function x`,
  // `/* create function y( */`) não pode virar fluxo, drop nem regra.
  const files = sources.map((file) => ({ path: file.path, text: maskSqlComments(file.text) }));
  const tables = new Map<string, string>();
  const functions = new Map<string, SqlFunction>();
  const constraints = new Map<string, SqlConstraint>();
  const triggers = new Map<string, SqlTrigger>();
  // Tabelas primeiro: o corpo de uma função só cita tabelas conhecidas.
  for (const file of files) {
    const lineOf = lineIndex(file.text);
    const create = new RegExp(String.raw`\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${NAME}`, 'gi');
    for (const match of file.text.matchAll(create)) {
      const name = normalizeName(match[1]!);
      if (!tables.has(name)) tables.set(name, `${file.path}:${lineOf(match.index)}`);
    }
  }
  const known = new Set(tables.keys());
  const writes = new RegExp(String.raw`\b(?:insert\s+into|update|delete\s+from)\s+(?:only\s+)?${NAME}`, 'gi');
  const reads = new RegExp(String.raw`\b(?:from|join)\s+(?:only\s+)?${NAME}`, 'gi');
  for (const file of files) {
    const { text } = file;
    const lineOf = lineIndex(text);
    // Cada CREATE/DROP vira um evento no seu offset e os eventos são aplicados
    // na ordem do arquivo: `DROP TRIGGER IF EXISTS x; CREATE TRIGGER x` (e o
    // mesmo com constraint/função) termina com o objeto vigente, não apagado.
    const events: { offset: number; apply: () => void }[] = [];
    const at = (offset: number, apply: () => void): void => {
      events.push({ offset, apply });
    };
    const fnHeader = new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+${NAME}\s*\(`, 'gi');
    for (const match of text.matchAll(fnHeader)) {
      const name = normalizeName(match[1]!);
      const body = functionBody(text, match.index + match[0].length);
      if (!body) continue;
      const source = text.slice(body.start, body.end);
      const raises: { line: number; message: string }[] = [];
      for (const raise of source.matchAll(/\braise\s+exception\s+'((?:[^']|'')*)'/gi)) {
        const message = collapse(raise[1]!.replaceAll("''", "'"));
        if (raises.some((item) => item.message === message)) continue;
        raises.push({ line: lineOf(body.start + raise.index), message });
      }
      // Ordem das migrations: a última definição é a vigente.
      const fn = Object.freeze({
        name,
        file: file.path,
        line: lineOf(match.index),
        writes: collectNames(source, writes, known),
        reads: collectNames(source, reads, known),
        raises: Object.freeze(raises),
      });
      at(match.index, () => functions.set(name, fn));
    }
    const dropFn = new RegExp(String.raw`\bdrop\s+function\s+(?:if\s+exists\s+)?${NAME}`, 'gi');
    for (const match of text.matchAll(dropFn)) {
      const name = normalizeName(match[1]!);
      at(match.index, () => functions.delete(name));
    }
    const setConstraint = (offset: number, constraint: SqlConstraint): void =>
      at(offset, () => constraints.set(constraint.key, constraint));
    const alter = new RegExp(
      String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+add\s+constraint\s+("?\w+"?)\s+(check|unique|exclude)\b`,
      'gi',
    );
    for (const match of text.matchAll(alter)) {
      const table = normalizeName(match[1]!);
      setConstraint(match.index, Object.freeze({
        table,
        key: `${table}.${match[2]!.replaceAll('"', '').toLowerCase()}`,
        file: file.path,
        line: lineOf(match.index),
        text: statementAt(text, match.index),
      }));
    }
    const dropConstraint = new RegExp(
      String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+drop\s+constraint\s+(?:if\s+exists\s+)?("?\w+"?)`,
      'gi',
    );
    for (const match of text.matchAll(dropConstraint)) {
      const key = `${normalizeName(match[1]!)}.${match[2]!.replaceAll('"', '').toLowerCase()}`;
      at(match.index, () => constraints.delete(key));
    }
    const uniqueIndex = new RegExp(
      String.raw`\bcreate\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?("?\w+"?)\s+on\s+(?:only\s+)?${NAME}`,
      'gi',
    );
    for (const match of text.matchAll(uniqueIndex)) {
      const table = normalizeName(match[2]!);
      setConstraint(match.index, Object.freeze({
        table,
        key: `${table}.${match[1]!.replaceAll('"', '').toLowerCase()}`,
        file: file.path,
        line: lineOf(match.index),
        text: statementAt(text, match.index),
      }));
    }
    const tableBlock = new RegExp(String.raw`\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${NAME}\s*\(`, 'gi');
    for (const match of text.matchAll(tableBlock)) {
      const table = normalizeName(match[1]!);
      let depth = 1;
      let cursor = match.index + match[0].length;
      const start = cursor;
      while (cursor < text.length && depth > 0) {
        const char = text[cursor];
        if (char === '(') depth += 1;
        else if (char === ')') depth -= 1;
        cursor += 1;
      }
      const block = text.slice(start, cursor - 1);
      let lineStart = 0;
      for (const rawLine of block.split('\n')) {
        if (/\b(check\s*\(|unique\b)/i.test(rawLine)) {
          const text2 = collapse(rawLine.replace(/,\s*$/, ''));
          setConstraint(start + lineStart, Object.freeze({
            table,
            key: `${table}#${text2}`,
            file: file.path,
            line: lineOf(start + lineStart),
            text: text2,
          }));
        }
        lineStart += rawLine.length + 1;
      }
    }
    const trigger = new RegExp(
      String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+("?\w+"?)[^;]*?\bon\s+(?:only\s+)?${NAME}[^;]*?\bexecute\s+(?:function|procedure)\s+${NAME}\s*\(`,
      'gi',
    );
    for (const match of text.matchAll(trigger)) {
      const table = normalizeName(match[2]!);
      const name = match[1]!.replaceAll('"', '').toLowerCase();
      const record = Object.freeze({
        name,
        table,
        fn: normalizeName(match[3]!),
        file: file.path,
        line: lineOf(match.index),
      });
      at(match.index, () => triggers.set(`${table}.${name}`, record));
    }
    const dropTrigger = new RegExp(String.raw`\bdrop\s+trigger\s+(?:if\s+exists\s+)?("?\w+"?)\s+on\s+${NAME}`, 'gi');
    for (const match of text.matchAll(dropTrigger)) {
      const key = `${normalizeName(match[2]!)}.${match[1]!.replaceAll('"', '').toLowerCase()}`;
      at(match.index, () => triggers.delete(key));
    }
    events.sort((left, right) => left.offset - right.offset);
    for (const event of events) event.apply();
  }
  return { tables, functions, constraints, triggers };
}

function isRuleDoc(file: string): boolean {
  if (ROOT_RULE_DOCS.includes(file)) return true;
  if (!file.toLowerCase().endsWith('.md')) return false;
  const segments = file.split('/');
  return (segments[0] === 'docs' || segments.includes('specs')) &&
    RULE_DOC_BASENAME.test(segments.at(-1) ?? '');
}

function isBulletContinuation(line: string): boolean {
  return /^\s+\S/.test(line) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(line) && !/^\s*```/.test(line);
}

function parseRules(files: readonly { path: string; text: string }[]): ProjectRule[] {
  const seen = new Set<string>();
  const rules: ProjectRule[] = [];
  for (const file of files) {
    let fenced = false;
    const lines = file.text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      const start = index;
      const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (!bullet) continue;
      // Bullet quebrado em várias linhas: as linhas indentadas seguintes continuam a regra.
      let body = bullet[1]!;
      while (index + 1 < lines.length && isBulletContinuation(lines[index + 1]!)) {
        body += ` ${lines[index + 1]!}`;
        index += 1;
      }
      if (!RULE_WORD.test(body)) continue;
      const text = collapse(body.replace(/\*\*|__|`/g, ''));
      const dedupe = text.toLowerCase();
      if (text.length < 12 || text.endsWith('?') || seen.has(dedupe)) continue;
      seen.add(dedupe);
      rules.push({ file: file.path, line: start + 1, text });
    }
  }
  return rules;
}

interface TrackedFiles {
  readonly clean: TrackedFile[];
  /** Todo caminho rastreado com alteração local (staged ou não). */
  readonly dirty: ReadonlySet<string>;
  /** Todo caminho rastreado, inclusive sujo — o modo `head` lê estes via `git show`. */
  readonly indexed: TrackedFile[];
}

async function listTrackedFiles(root: string, git: AsyncGitRunner): Promise<TrackedFiles | null> {
  try {
    const inside = await git.run(root, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null;
    const dirty = new Set<string>();
    const records = (await git.run(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=no'])).stdout.split('\0');
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.length < 4) continue;
      dirty.add(record.slice(3));
      // Rename/cópia traz o caminho de origem no registro seguinte.
      if (/[RC]/.test(record.slice(0, 2))) dirty.add(records[++index] ?? '');
    }
    const clean: TrackedFile[] = [];
    const indexed: TrackedFile[] = [];
    for (const record of (await git.run(root, ['ls-files', '-s', '-z'])).stdout.split('\0')) {
      const match = /^\d+ ([0-9a-f]+) 0\t(.+)$/.exec(record);
      if (!match) continue;
      const file = match[2]!;
      if (!isSafeBootstrapSourceLocator(file) || file.split('/').some((part) => NOISE_SEGMENT.test(part))) continue;
      indexed.push({ path: file, blob: match[1]! });
      if (!dirty.has(file)) clean.push({ path: file, blob: match[1]! });
      if (indexed.length >= MAX_SCANNED_FILES) break;
    }
    const byPath = (left: TrackedFile, right: TrackedFile) => left.path.localeCompare(right.path);
    return {
      clean: clean.sort(byPath),
      dirty,
      indexed: indexed.sort(byPath),
    };
  } catch {
    return null;
  }
}

/** Teto por tipo de fonte: doc de regra (hurdles) pode passar de 1 MB. */
function sourceCap(file: string): number {
  return isRuleDoc(file) ? MAX_RULE_DOC_BYTES : MAX_SOURCE_BYTES;
}

async function readText(root: string, relative: string, maxBytes: number): Promise<string | null> {
  try {
    const absolute = path.join(root, relative);
    const stat = await fs.promises.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    const bytes = await fs.promises.readFile(absolute);
    if (bytes.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Conteúdo do blob `HEAD:<relative>` — o modelo do HEAD ignora a sujeira do worktree. */
async function readHeadText(
  root: string,
  relative: string,
  git: AsyncGitRunner,
  maxBytes: number,
): Promise<string | null> {
  try {
    const result = await git.run(
      root,
      ['--no-optional-locks', 'show', `HEAD:${relative}`],
      { allowFailure: true },
    );
    if (result.status !== 0) return null;
    if (Buffer.byteLength(result.stdout, 'utf8') > maxBytes) return null;
    // Binário/mal-decodificado (UTF-8 inválido vira U+FFFD) não é fonte de texto.
    if (result.stdout.includes('\0') || result.stdout.includes('\uFFFD')) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface FlowDraft {
  readonly fn: SqlFunction;
  readonly score: number;
  callers: string[];
  tests: string[];
}

function flowNamePattern(flows: readonly FlowDraft[]): RegExp | null {
  if (flows.length === 0) return null;
  const names = [...new Set(flows.map((flow) => flow.fn.name.split('.').at(-1)!))];
  return new RegExp(`\\b(${names.map(escapeRegExp).join('|')})\\b`, 'g');
}

function isReferenceFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  return CODE_EXTENSIONS.has(extension) || (TEST_PATH.test(file) && extension === '.sql');
}

type SourceReader = (relative: string, maxBytes: number) => Promise<string | null>;

async function relatedFiles(
  files: readonly TrackedFile[],
  flows: readonly FlowDraft[],
  readSource: SourceReader,
): Promise<void> {
  const pattern = flowNamePattern(flows);
  if (!pattern) return;
  const byName = new Map(flows.map((flow) => [flow.fn.name.split('.').at(-1)!, flow]));
  for (const file of files) {
    if (!isReferenceFile(file.path)) continue;
    const isTest = TEST_PATH.test(file.path);
    const text = await readSource(file.path, MAX_SOURCE_BYTES);
    if (!text) continue;
    const lineOf = lineIndex(text);
    const hit = new Set<string>();
    for (const match of text.matchAll(pattern)) {
      const flow = byName.get(match[1]!)!;
      if (hit.has(match[1]!)) continue;
      if (isTest) {
        hit.add(match[1]!);
        if (flow.tests.length < MAX_REFS_PER_FLOW) flow.tests.push(file.path);
        continue;
      }
      // Código de produção só conta quando chama a RPC pelo nome.
      const before = text.slice(Math.max(0, match.index - 12), match.index);
      if (!/rpc\s*\(\s*['"`]$/.test(before)) continue;
      hit.add(match[1]!);
      if (flow.callers.length < MAX_REFS_PER_FLOW) flow.callers.push(`${file.path}:${lineOf(match.index)}`);
    }
  }
}

function fileOf(reference: string): string {
  return reference.replace(/:\d+$/, '');
}

function buildDocument(
  sql: SqlModel,
  flows: readonly FlowDraft[],
  rules: readonly ProjectRule[],
): BusinessModelDocument {
  const flowRecords: BusinessFlow[] = [];
  const invariants: BusinessInvariant[] = [];
  for (const flow of flows) {
    const { fn } = flow;
    // Trigger que não escreve tabela (updated_at, validação local) não acopla fluxos.
    const coupled = [...sql.triggers.values()]
      .filter((trigger) =>
        fn.writes.includes(trigger.table) &&
        trigger.fn !== fn.name &&
        (sql.functions.get(trigger.fn)?.writes.length ?? 0) > 0)
      .sort((left, right) => left.table.localeCompare(right.table) || left.name.localeCompare(right.name));
    const triggerFns = coupled.map((trigger) => trigger.fn);
    const funcoes = [...new Set([fn.name, ...triggerFns.sort()])];
    const arquivos = [...new Set([fn.file, ...flow.callers.map(fileOf)])];
    const testes = [...flow.tests].sort();
    flowRecords.push(Object.freeze({
      fluxo: fn.name,
      definicao: `${fn.file}:${fn.line}`,
      escreve: Object.freeze([...fn.writes]),
      le: Object.freeze(fn.reads.filter((table) => !fn.writes.includes(table))),
      funcoes: Object.freeze(funcoes),
      arquivos: Object.freeze(arquivos),
      testes: Object.freeze(testes),
    }));
    const own: Omit<BusinessInvariant, 'id'>[] = [
      ...fn.raises.slice(0, MAX_RAISES_PER_FLOW).map((raise) => ({
        fluxo: fn.name,
        regra: `${fn.name} recusa: ${raise.message}`,
        origem: `${fn.file}:${raise.line}`,
        arquivos,
        tabelas: fn.writes,
        funcoes,
        testes,
      })),
      ...coupled.slice(0, MAX_TRIGGERS_PER_FLOW).map((trigger) => {
        const target = sql.functions.get(trigger.fn)!;
        return {
          fluxo: fn.name,
          regra: `escrever em ${trigger.table} dispara o trigger ${trigger.name} → ${trigger.fn} (escreve ${target.writes.join(', ')})`,
          origem: `${trigger.file}:${trigger.line}`,
          arquivos: [...new Set([...arquivos, trigger.file, target.file])],
          tabelas: [trigger.table, ...target.writes.filter((table) => table !== trigger.table)],
          funcoes,
          testes,
        };
      }),
      ...[...sql.constraints.values()]
        .filter((constraint) => fn.writes.includes(constraint.table))
        .sort((left, right) => left.table.localeCompare(right.table) || left.key.localeCompare(right.key))
        .map((constraint) => ({
          fluxo: fn.name,
          regra: `${constraint.table}: ${constraint.text}`,
          origem: `${constraint.file}:${constraint.line}`,
          arquivos: [...new Set([...arquivos, constraint.file])],
          tabelas: [constraint.table],
          funcoes,
          testes,
        })),
    ];
    own.slice(0, MAX_INVARIANTS_PER_FLOW).forEach((invariant, index) => {
      invariants.push(Object.freeze({
        id: `${fn.name}#${index + 1}`,
        ...invariant,
        arquivos: Object.freeze([...invariant.arquivos]),
        tabelas: Object.freeze([...new Set(invariant.tabelas)]),
        funcoes: Object.freeze([...invariant.funcoes]),
        testes: Object.freeze([...invariant.testes]),
      }));
    });
  }
  rules.slice(0, MAX_PROJECT_RULES).forEach((rule, index) => {
    const lower = rule.text.toLowerCase();
    const flow = flowRecords.find((candidate) =>
      lower.includes(candidate.fluxo) || candidate.escreve.some((table) => new RegExp(`\\b${escapeRegExp(table)}\\b`).test(lower)));
    invariants.push(Object.freeze({
      id: `projeto#${index + 1}`,
      fluxo: flow?.fluxo ?? 'projeto',
      regra: rule.text,
      origem: `${rule.file}:${rule.line}`,
      arquivos: Object.freeze(flow ? [...new Set([rule.file, ...flow.arquivos])] : [rule.file]),
      tabelas: Object.freeze(flow ? [...flow.escreve] : []),
      funcoes: Object.freeze(flow ? [...flow.funcoes] : []),
      testes: Object.freeze(flow ? [...flow.testes] : []),
    }));
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    flows: Object.freeze(flowRecords),
    invariants: Object.freeze(invariants),
  });
}

function list(values: readonly string[]): string {
  return values.length > 0 ? values.map((value) => `\`${value}\``).join(', ') : '—';
}

export function renderBusinessModelDocument(document: BusinessModelDocument): string {
  const lines = [
    '# Modelo de negócio',
    '',
    BUSINESS_MODEL_MARKER_LINE,
    '> Cada regra cita `arquivo:linha` da fonte. Antes de escrever código: identifique o fluxo tocado, confira os invariantes dele e rode os testes listados.',
    '',
    '## Fluxos críticos',
    '',
  ];
  if (document.flows.length === 0) lines.push('- Nenhuma função SQL que escreve tabelas foi encontrada nas fontes versionadas.', '');
  for (const flow of document.flows) {
    lines.push(
      `### ${flow.fluxo}`,
      '',
      `- Definição vigente: \`${flow.definicao}\``,
      `- Escreve: ${list(flow.escreve)}`,
      `- Lê: ${list(flow.le)}`,
      `- Funções acopladas: ${list(flow.funcoes)}`,
      `- Arquivos: ${list(flow.arquivos)}`,
      `- Testes: ${list(flow.testes)}`,
      '',
    );
  }
  lines.push('## Invariantes', '');
  if (document.invariants.length === 0) lines.push('- Nenhum invariante foi encontrado nas fontes.');
  for (const invariant of document.invariants) {
    lines.push(`- **${invariant.id}** (${invariant.fluxo}) ${invariant.regra} — \`${invariant.origem}\``);
  }
  lines.push('', '## Tabelas e funções por fluxo', '', '| Fluxo | Tabelas escritas | Funções |', '| --- | --- | --- |');
  for (const flow of document.flows) {
    lines.push(`| ${flow.fluxo} | ${flow.escreve.join(', ') || '—'} | ${flow.funcoes.join(', ')} |`);
  }
  lines.push('', '## Testes que protegem cada fluxo', '');
  for (const flow of document.flows) {
    lines.push(`- ${flow.fluxo}: ${flow.testes.length > 0 ? list(flow.testes) : 'nenhum teste cita este fluxo — escreva um antes de mudá-lo'}`);
  }
  lines.push(
    '',
    BUSINESS_MODEL_JSON_MARKER,
    '```json',
    JSON.stringify(document),
    '```',
    '',
  );
  return lines.join('\n');
}

const cache = new Map<string, {
  fingerprint: string;
  result: Omit<BusinessModelExtraction, 'pendingSources'> | null;
  flows: readonly FlowDraft[];
}>();

/** Test-only. */
export function __clearBusinessModelExtractionCacheForTests(): void {
  cache.clear();
}

export interface ExtractBusinessModelOptions {
  /** Ignora o cache por fingerprint (a revisão mecânica re-deriva do zero). */
  readonly fresh?: boolean;
  readonly git?: AsyncGitRunner;
  /**
   * `worktree` (padrão): só fontes limpas entram; sujas adiam via pendingSources.
   * `head`: o modelo do HEAD — fonte suja é lida do blob `HEAD:<path>`, então
   * o modelo extraído nunca depende do estado sujo do worktree.
   */
  readonly source?: 'worktree' | 'head';
}

/**
 * Fontes que mudariam o modelo mas estão com alteração local: SQL de schema,
 * doc de regra, ou código/teste que cita um fluxo pelo nome. Fica fora do
 * cache (o conteúdo sujo muda sem mudar o fingerprint).
 */
async function pendingSourcesOf(
  root: string,
  dirty: readonly string[],
  flows: readonly FlowDraft[],
): Promise<string[]> {
  const pattern = flowNamePattern(flows);
  const pending: string[] = [];
  for (const file of dirty) {
    const extension = path.extname(file).toLowerCase();
    if ((extension === '.sql' && !TEST_PATH.test(file)) || isRuleDoc(file)) {
      pending.push(file);
      continue;
    }
    if (!pattern || !isReferenceFile(file)) continue;
    const text = await readText(root, file, MAX_SOURCE_BYTES);
    pattern.lastIndex = 0;
    if (text !== null && pattern.test(text)) pending.push(file);
  }
  return pending;
}

/**
 * Extrai o modelo do projeto e devolve o draft source-bound. `null` quando não
 * há git, nem SQL com fluxo, nem regra do projeto. Sem mudança no fingerprint
 * (blobs git das fontes candidatas + conjunto sujo) não re-extrai.
 */
export async function extractBusinessModel(
  root: string,
  options: ExtractBusinessModelOptions = {},
): Promise<BusinessModelExtraction | null> {
  const git = options.git ?? new AsyncProcessGitRunner();
  const headMode = options.source === 'head';
  const tracked = await listTrackedFiles(root, git);
  if (!tracked) return null;
  // Modo head: arquivo sujo vem do blob HEAD (determinístico); limpo, do disco.
  const readSource: SourceReader = headMode
    ? (relative, maxBytes) =>
        tracked.dirty.has(relative)
          ? readHeadText(root, relative, git, maxBytes)
          : readText(root, relative, maxBytes)
    : (relative, maxBytes) => readText(root, relative, maxBytes);
  const withPending = async (
    core: { result: Omit<BusinessModelExtraction, 'pendingSources'> | null; flows: readonly FlowDraft[] },
  ): Promise<BusinessModelExtraction | null> =>
    core.result
      ? Object.freeze({
          ...core.result,
          pendingSources: Object.freeze(
            headMode
              ? []
              : await pendingSourcesOf(
                  root,
                  [...tracked.dirty]
                    .filter((file) =>
                      file &&
                      isSafeBootstrapSourceLocator(file) &&
                      !file.split('/').some((part) => NOISE_SEGMENT.test(part)))
                    .sort(),
                  core.flows,
                ),
          ),
        })
      : null;
  const candidates = (headMode ? tracked.indexed : tracked.clean).filter((file) => {
    const extension = path.extname(file.path).toLowerCase();
    return extension === '.sql' || isRuleDoc(file.path) || CODE_EXTENSIONS.has(extension);
  });
  const fingerprint = sha256(
    `${headMode ? 'head' : 'worktree'}\n` +
      candidates.map((file) => `${file.path}\0${file.blob}`).join('\n'),
  );
  const cacheKey = `${headMode ? 'head' : 'worktree'}\0${root}`;
  const cached = cache.get(cacheKey);
  if (!options.fresh && cached?.fingerprint === fingerprint) return withPending(cached);

  const readAll = async (paths: readonly string[]): Promise<{ path: string; text: string }[]> => {
    const read: { path: string; text: string }[] = [];
    for (const file of paths) {
      const text = await readSource(file, sourceCap(file));
      if (text !== null) read.push({ path: file, text });
    }
    return read;
  };
  const sql = parseSqlFiles(await readAll(candidates
    .map((file) => file.path)
    .filter((file) => file.toLowerCase().endsWith('.sql') && !TEST_PATH.test(file))));
  const ruleDocTexts = await readAll([
    ...ROOT_RULE_DOCS.filter((file) => candidates.some((candidate) => candidate.path === file)),
    ...candidates.map((file) => file.path).filter((file) => !ROOT_RULE_DOCS.includes(file) && isRuleDoc(file)),
  ]);
  const rules = parseRules(ruleDocTexts);
  const hurdles = Object.freeze(
    ruleDocTexts
      .filter((file) => isHurdleDoc(file.path))
      .flatMap((file) => parseBusinessHurdles(file.path, file.text)),
  );

  const ranked: FlowDraft[] = [...sql.functions.values()]
    .filter((fn) => fn.writes.length > 0)
    .map((fn) => ({
      fn,
      score: fn.writes.length * 3 + fn.raises.length * 2 +
        [...sql.constraints.values()].filter((constraint) => fn.writes.includes(constraint.table)).length,
      callers: [] as string[],
      tests: [] as string[],
    }))
    .sort((left, right) => right.score - left.score || left.fn.name.localeCompare(right.fn.name))
    .slice(0, MAX_CANDIDATE_FLOWS);
  await relatedFiles(candidates, ranked, readSource);
  const flows = ranked
    .map((flow) => ({
      flow,
      score: flow.score + (flow.callers.length > 0 ? 2 : 0) + (flow.tests.length > 0 ? 2 : 0) +
        (rules.some((rule) => rule.text.toLowerCase().includes(flow.fn.name)) ? 3 : 0),
    }))
    .sort((left, right) => right.score - left.score || left.flow.fn.name.localeCompare(right.flow.fn.name))
    .slice(0, MAX_FLOWS)
    .map((item) => item.flow);

  let result: Omit<BusinessModelExtraction, 'pendingSources'> | null = null;
  if (flows.length > 0 || rules.length > 0) {
    let kept = flows;
    let document = buildDocument(sql, kept, rules);
    let locators = citedFiles(document);
    while (locators.length > MAX_ATTESTED_SOURCES && kept.length > 0) {
      kept = kept.slice(0, -1);
      document = buildDocument(sql, kept, rules);
      locators = citedFiles(document);
    }
    const sources = (await readAll(locators.slice(0, MAX_ATTESTED_SOURCES))).map(({ path: locator, text }) =>
      ({ type: 'file' as const, locator, sourceHash: sha256(Buffer.from(text, 'utf8')) }));
    if (sources.length > 0) {
      result = Object.freeze({
        fingerprint,
        document,
        hurdles,
        proposal: Object.freeze({
          targetPath: BUSINESS_MODEL_TARGET_PATH,
          content: renderBusinessModelDocument(document),
          sources: Object.freeze(sources.sort((left, right) => left.locator.localeCompare(right.locator))),
          rationale: 'Modelo de negócio extraído deterministicamente de migrations SQL, regras do projeto e testes',
        }),
      });
    }
  }
  const core = { fingerprint, result, flows: ranked };
  cache.set(cacheKey, core);
  return withPending(core);
}

function citedFiles(document: BusinessModelDocument): string[] {
  const files = new Set<string>();
  for (const flow of document.flows) {
    files.add(fileOf(flow.definicao));
    for (const file of flow.arquivos) files.add(file);
    for (const file of flow.testes) files.add(file);
  }
  for (const invariant of document.invariants) {
    files.add(fileOf(invariant.origem));
    for (const file of invariant.arquivos) files.add(file);
    for (const file of invariant.testes) files.add(file);
  }
  return [...files].sort();
}
