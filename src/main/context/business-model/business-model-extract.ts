import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ProcessGitRunner, type GitRunner } from '../../runtime/git-command';
import { isSafeBootstrapSourceLocator } from '../orientation/orientation-bootstrap-context';
import type { BootstrapDocProposal } from '../orientation/orientation-bootstrap-types';
import {
  BUSINESS_MODEL_JSON_MARKER,
  BUSINESS_MODEL_TARGET_PATH,
  type BusinessFlow,
  type BusinessInvariant,
  type BusinessModelDocument,
} from './business-model-contract';

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
 * exige cada fonte commitada no HEAD com o hash atestado.
 */

export const BUSINESS_MODEL_MARKER_LINE =
  '> Extraído deterministicamente pelo Nexus de fontes versionadas. Não edite à mão: o Nexus re-extrai quando as fontes mudam.';

const MAX_SOURCE_BYTES = 1_000_000;
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

function collapse(text: string, max = MAX_RULE_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
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

function parseSqlFiles(files: readonly { path: string; text: string }[]): SqlModel {
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
      functions.set(name, Object.freeze({
        name,
        file: file.path,
        line: lineOf(match.index),
        writes: collectNames(source, writes, known),
        reads: collectNames(source, reads, known),
        raises: Object.freeze(raises),
      }));
    }
    const dropFn = new RegExp(String.raw`\bdrop\s+function\s+(?:if\s+exists\s+)?${NAME}`, 'gi');
    for (const match of text.matchAll(dropFn)) {
      const name = normalizeName(match[1]!);
      const current = functions.get(name);
      if (current && current.file === file.path && current.line > lineOf(match.index)) continue;
      functions.delete(name);
    }
    const alter = new RegExp(
      String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+add\s+constraint\s+("?\w+"?)\s+(check|unique|exclude)\b`,
      'gi',
    );
    for (const match of text.matchAll(alter)) {
      const table = normalizeName(match[1]!);
      const key = `${table}.${match[2]!.replaceAll('"', '').toLowerCase()}`;
      constraints.set(key, Object.freeze({
        table,
        key,
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
      constraints.delete(`${normalizeName(match[1]!)}.${match[2]!.replaceAll('"', '').toLowerCase()}`);
    }
    const uniqueIndex = new RegExp(
      String.raw`\bcreate\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?("?\w+"?)\s+on\s+(?:only\s+)?${NAME}`,
      'gi',
    );
    for (const match of text.matchAll(uniqueIndex)) {
      const table = normalizeName(match[2]!);
      const key = `${table}.${match[1]!.replaceAll('"', '').toLowerCase()}`;
      constraints.set(key, Object.freeze({
        table,
        key,
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
          const key = `${table}#${text2}`;
          constraints.set(key, Object.freeze({
            table,
            key,
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
      triggers.set(`${table}.${name}`, Object.freeze({
        name,
        table,
        fn: normalizeName(match[3]!),
        file: file.path,
        line: lineOf(match.index),
      }));
    }
    const dropTrigger = new RegExp(String.raw`\bdrop\s+trigger\s+(?:if\s+exists\s+)?("?\w+"?)\s+on\s+${NAME}`, 'gi');
    for (const match of text.matchAll(dropTrigger)) {
      triggers.delete(`${normalizeName(match[2]!)}.${match[1]!.replaceAll('"', '').toLowerCase()}`);
    }
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
      const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (!bullet || !RULE_WORD.test(bullet[1]!)) continue;
      const text = collapse(bullet[1]!.replace(/\*\*|__|`/g, ''));
      const dedupe = text.toLowerCase();
      if (text.length < 12 || text.endsWith('?') || seen.has(dedupe)) continue;
      seen.add(dedupe);
      rules.push({ file: file.path, line: index + 1, text });
    }
  }
  return rules;
}

function listTrackedCleanFiles(root: string, git: GitRunner): TrackedFile[] | null {
  try {
    const inside = git.run(root, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null;
    const dirty = new Set<string>();
    const records = git.run(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=no']).stdout.split('\0');
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.length < 4) continue;
      dirty.add(record.slice(3));
      // Rename/cópia traz o caminho de origem no registro seguinte.
      if (/[RC]/.test(record.slice(0, 2))) dirty.add(records[++index] ?? '');
    }
    const files: TrackedFile[] = [];
    for (const record of git.run(root, ['ls-files', '-s', '-z']).stdout.split('\0')) {
      const match = /^\d+ ([0-9a-f]+) 0\t(.+)$/.exec(record);
      if (!match || dirty.has(match[2]!)) continue;
      const file = match[2]!;
      if (!isSafeBootstrapSourceLocator(file) || file.split('/').some((part) => NOISE_SEGMENT.test(part))) continue;
      files.push({ path: file, blob: match[1]! });
      if (files.length >= MAX_SCANNED_FILES) break;
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  } catch {
    return null;
  }
}

function readText(root: string, relative: string): string | null {
  try {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_BYTES) return null;
    const bytes = fs.readFileSync(absolute);
    if (bytes.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
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

function relatedFiles(
  root: string,
  files: readonly TrackedFile[],
  flows: readonly FlowDraft[],
): void {
  if (flows.length === 0) return;
  const byName = new Map(flows.map((flow) => [flow.fn.name.split('.').at(-1)!, flow]));
  const pattern = new RegExp(`\\b(${[...byName.keys()].map(escapeRegExp).join('|')})\\b`, 'g');
  for (const file of files) {
    const extension = path.extname(file.path).toLowerCase();
    const isTest = TEST_PATH.test(file.path);
    if (!CODE_EXTENSIONS.has(extension) && !(isTest && extension === '.sql')) continue;
    const text = readText(root, file.path);
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

const cache = new Map<string, { fingerprint: string; result: BusinessModelExtraction | null }>();

/** Test-only. */
export function __clearBusinessModelExtractionCacheForTests(): void {
  cache.clear();
}

export interface ExtractBusinessModelOptions {
  /** Ignora o cache por fingerprint (a revisão mecânica re-deriva do zero). */
  readonly fresh?: boolean;
  readonly git?: GitRunner;
}

/**
 * Extrai o modelo do projeto e devolve o draft source-bound. `null` quando não
 * há git, nem SQL com fluxo, nem regra do projeto. Sem mudança no fingerprint
 * (blobs git das fontes candidatas + conjunto sujo) não re-extrai.
 */
export function extractBusinessModel(
  root: string,
  options: ExtractBusinessModelOptions = {},
): BusinessModelExtraction | null {
  const git = options.git ?? new ProcessGitRunner();
  const tracked = listTrackedCleanFiles(root, git);
  if (!tracked) return null;
  const candidates = tracked.filter((file) => {
    const extension = path.extname(file.path).toLowerCase();
    return extension === '.sql' || isRuleDoc(file.path) || CODE_EXTENSIONS.has(extension);
  });
  const fingerprint = sha256(candidates.map((file) => `${file.path}\0${file.blob}`).join('\n'));
  const cached = cache.get(root);
  if (!options.fresh && cached?.fingerprint === fingerprint) return cached.result;

  const sqlFiles = candidates
    .filter((file) => file.path.toLowerCase().endsWith('.sql') && !TEST_PATH.test(file.path))
    .flatMap((file) => {
      const text = readText(root, file.path);
      return text ? [{ path: file.path, text }] : [];
    });
  const sql = parseSqlFiles(sqlFiles);
  const ruleFiles = [
    ...ROOT_RULE_DOCS.filter((file) => candidates.some((candidate) => candidate.path === file)),
    ...candidates.map((file) => file.path).filter((file) => !ROOT_RULE_DOCS.includes(file) && isRuleDoc(file)),
  ].flatMap((file) => {
    const text = readText(root, file);
    return text ? [{ path: file, text }] : [];
  });
  const rules = parseRules(ruleFiles);

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
  relatedFiles(root, candidates, ranked);
  const flows = ranked
    .map((flow) => ({
      flow,
      score: flow.score + (flow.callers.length > 0 ? 2 : 0) + (flow.tests.length > 0 ? 2 : 0) +
        (rules.some((rule) => rule.text.toLowerCase().includes(flow.fn.name)) ? 3 : 0),
    }))
    .sort((left, right) => right.score - left.score || left.flow.fn.name.localeCompare(right.flow.fn.name))
    .slice(0, MAX_FLOWS)
    .map((item) => item.flow);

  let result: BusinessModelExtraction | null = null;
  if (flows.length > 0 || rules.length > 0) {
    let kept = flows;
    let document = buildDocument(sql, kept, rules);
    let locators = citedFiles(document);
    while (locators.length > MAX_ATTESTED_SOURCES && kept.length > 0) {
      kept = kept.slice(0, -1);
      document = buildDocument(sql, kept, rules);
      locators = citedFiles(document);
    }
    const sources = locators.slice(0, MAX_ATTESTED_SOURCES).flatMap((locator) => {
      const text = readText(root, locator);
      return text === null ? [] : [{ type: 'file' as const, locator, sourceHash: sha256(Buffer.from(text, 'utf8')) }];
    });
    if (sources.length > 0) {
      result = Object.freeze({
        fingerprint,
        document,
        proposal: Object.freeze({
          targetPath: BUSINESS_MODEL_TARGET_PATH,
          content: renderBusinessModelDocument(document),
          sources: Object.freeze(sources.sort((left, right) => left.locator.localeCompare(right.locator))),
          rationale: 'Modelo de negócio extraído deterministicamente de migrations SQL, regras do projeto e testes',
        }),
      });
    }
  }
  cache.set(root, { fingerprint, result });
  return result;
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
