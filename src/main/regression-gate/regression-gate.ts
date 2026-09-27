/**
 * Portão de regressão (0.76.110): antes de aceitar trabalho de escrita, roda
 * SÓ os testes impactados pelo diff e checa os invariantes tocados.
 *
 *   diff (git status + commits desde a base + arquivos declarados)
 *     → arquivos tocados
 *     → testes impactados (grafo de imports reverso + teste co-localizado
 *       + extensões: blast radius com `tests` e invariantes estruturados)
 *     → runner do PROJETO ALVO (vitest/jest; pytest trivial)
 *     → resultado estruturado: passou | falhou | sem teste para a área X.
 *
 * Custo: cache por hash do conteúdo do diff (o mesmo diff nunca roda duas
 * vezes), teto de arquivos de teste e timeout; nunca a suíte inteira.
 * Fail-open: sem runner, sem git ou erro de infraestrutura devolvem
 * `unavailable` com aviso — o portão só bloqueia com teste que FALHOU.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  buildOrientationImportGraphFromFacts,
  extractOrientationImportSpecifiers,
  isOrientationImportSource,
  type OrientationImportFileFact,
} from '../context/orientation/orientation-import-graph';
import { walkOrientationTreeAsync } from '../context/orientation/orientation-walker';
import {
  DEFAULT_ORIENTATION_LIMITS,
  type OrientationLimits,
} from '../context/orientation/orientation-types';
import { ensureBlastRadius } from '../context/orientation/orientation-blast-radius';
import { tryGetProjectOrientationService } from '../context/orientation/orientation-service';
import { readWorkspaceTextFile } from '../orch/workspace-file';
import { listDirtyPathsUnderCwd } from '../orch/worker-delivery-evidence';
import { ProcessGitRunner, type GitRunner } from '../runtime/git-command';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';

const GATE_VERSION = 'regression-gate-v1';
const TEST_FILE_RE = /(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.[^/]+$)/iu;
const E2E_FILE_RE = /(?:^|\/)(?:e2e|playwright)\/|\.e2e\.[^/]+$/iu;
const PY_TEST_RE = /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/iu;
const UNTESTED_IGNORE_RE =
  /(?:^|\/)(?:generated|dist|build|out|scripts|migrations)\/|\.d\.ts$|\.config\.[^/]+$/iu;
const MAX_CHANGED_FILES = 256;
const MAX_HASH_FILE_BYTES = 2 * 1024 * 1024;
const REVERSE_DEPTH = 3;
const MAX_REVERSE_VISITS = 4_000;
// O walk só faz stat (conta bytes de todo arquivo, não só fonte); a leitura
// fica restrita a TS/JS. Tetos menores truncam repositórios grandes na ordem
// alfabética e somem com importadores reais.
const GRAPH_LIMITS: OrientationLimits = Object.freeze({
  ...DEFAULT_ORIENTATION_LIMITS,
  maxFileBytes: 512 * 1024,
});
const CACHE_LIMIT = 32;

export const DEFAULT_REGRESSION_TEST_TIMEOUT_MS = 120_000;
export const DEFAULT_REGRESSION_MAX_TEST_FILES = 40;

/**
 * Contrato do modelo-negócio (writer 3): invariante estruturado. Os campos em
 * português espelham o `.context` de negócio. Só `id`, `regra` e `arquivos`
 * são usados hoje; `tabelas` casam com as tabelas que o blast radius
 * estendido (writer 4) apontar.
 */
export interface RegressionInvariant {
  readonly id: string;
  readonly fluxo?: string;
  readonly regra: string;
  readonly arquivos?: readonly string[];
  readonly tabelas?: readonly string[];
  readonly funcoes?: readonly string[];
  readonly testes?: readonly string[];
}

/** Contrato do codemap-banco (writer 4): blast radius estendido. */
export interface RegressionBlastRadiusExtension {
  readonly tests?: readonly string[];
  readonly tables?: readonly string[];
}

/**
 * Pontos de extensão tipados e fail-open. Ausentes, o portão usa só o grafo
 * de imports e o mapeamento teste↔fonte que já existem.
 */
export interface RegressionGateExtensions {
  readonly blastRadius?: (input: {
    readonly scope: ProjectExecutionScope;
    readonly changedFiles: readonly string[];
  }) => Promise<RegressionBlastRadiusExtension | null> | RegressionBlastRadiusExtension | null;
  readonly invariants?: (input: {
    readonly scope: ProjectExecutionScope;
  }) => Promise<readonly RegressionInvariant[]> | readonly RegressionInvariant[];
}

let registeredExtensions: RegressionGateExtensions = {};

/** Flag `feature.orch.regressionGate` (Labs), default LIGADO. */
export function isRegressionGateEnabled(): boolean {
  try {
    return getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.regressionGate);
  } catch {
    return true;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Default do contrato do codemap-banco: lê `tests`/`tables` do blast radius
 * da orientação quando existirem (o writer 4 os acrescenta ao
 * BlastRadiusResult). Sem serviço ou sem os campos → null, portão segue.
 */
export async function orientationBlastRadiusExtension(input: {
  readonly scope: ProjectExecutionScope;
  readonly changedFiles: readonly string[];
}): Promise<RegressionBlastRadiusExtension | null> {
  const service = tryGetProjectOrientationService();
  if (!service) return null;
  const radius: object = await ensureBlastRadius(
    input.scope,
    { seedFiles: input.changedFiles, depth: 1 },
    service,
  );
  const tests = stringList((radius as { tests?: unknown }).tests);
  const tables = stringList((radius as { tables?: unknown }).tables);
  return tests.length > 0 || tables.length > 0 ? { tests, tables } : null;
}

/** Writers 3/4 registram aqui seus provedores, sem acoplar este módulo a eles. */
export function registerRegressionGateExtensions(
  extensions: RegressionGateExtensions,
): void {
  registeredExtensions = { ...registeredExtensions, ...extensions };
}

export type RegressionRunnerKind = 'vitest' | 'jest' | 'pytest';

export interface RegressionTestFailure {
  readonly file: string;
  readonly message: string;
}

export type RegressionGateStatus =
  | 'passed'
  | 'failed'
  | 'no-tests'
  | 'clean'
  | 'unavailable';

export interface RegressionGateResult {
  readonly version: typeof GATE_VERSION;
  readonly status: RegressionGateStatus;
  readonly diffHash: string;
  readonly changedFiles: readonly string[];
  readonly testsRun: readonly string[];
  readonly failures: readonly RegressionTestFailure[];
  /** Arquivos-fonte tocados sem nenhum teste mapeado — aviso, não bloqueia. */
  readonly untestedFiles: readonly string[];
  readonly invariantsTouched: readonly Pick<RegressionInvariant, 'id' | 'regra'>[];
  readonly runner: RegressionRunnerKind | null;
  readonly warnings: readonly string[];
  readonly cached: boolean;
  readonly durationMs: number;
}

export interface RegressionExecResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type RegressionExec = (
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number; readonly env: NodeJS.ProcessEnv },
) => Promise<RegressionExecResult>;

export interface RunRegressionGateInput {
  readonly scope: ProjectExecutionScope;
  /** Arquivos declarados pelo agente (somados aos observados no git). */
  readonly declaredFiles?: readonly string[];
  /** Base para somar os commits do worktree isolado (`base...HEAD`). */
  readonly baseSha?: string;
  readonly timeoutMs?: number;
  readonly maxTestFiles?: number;
}

export interface RegressionGateDependencies {
  readonly exec?: RegressionExec;
  readonly git?: GitRunner;
  readonly extensions?: RegressionGateExtensions;
  readonly now?: () => number;
}

const cache = new Map<string, RegressionGateResult>();
const inflight = new Map<string, Promise<RegressionGateResult>>();

export function __resetRegressionGateForTests(): void {
  cache.clear();
  inflight.clear();
  registeredExtensions = {};
}

function normalizeRelative(value: string): string | null {
  const raw = value.trim().replace(/\\/g, '/');
  if (!raw || /[\0\r\n]/u.test(raw)) return null;
  const normalized = path.posix.normalize(raw);
  if (
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    path.posix.isAbsolute(normalized) ||
    normalized.startsWith('.git/') ||
    normalized.startsWith('.nexus/') ||
    normalized.includes('node_modules/')
  ) {
    return null;
  }
  return normalized;
}

function gitNames(git: GitRunner, cwd: string, args: readonly string[]): string[] {
  try {
    const result = git.run(cwd, args, { allowFailure: true });
    if (result.status !== 0) return [];
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Diff observado: sujo + não rastreado + commits desde a base + declarados. */
export function collectRegressionChangedFiles(
  root: string,
  input: Pick<RunRegressionGateInput, 'declaredFiles' | 'baseSha'>,
  git: GitRunner = new ProcessGitRunner(),
): string[] {
  const committed =
    input.baseSha && /^[a-f0-9]{7,64}$/iu.test(input.baseSha)
      ? gitNames(git, root, ['diff', '--name-only', '--no-renames', `${input.baseSha}...HEAD`])
      : [];
  const all = [
    ...listDirtyPathsUnderCwd(root, git),
    ...committed,
    ...(input.declaredFiles ?? []),
  ];
  const out = new Set<string>();
  for (const file of all) {
    const normalized = normalizeRelative(file);
    if (normalized) out.add(normalized);
    if (out.size >= MAX_CHANGED_FILES) break;
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** Hash do CONTEÚDO do diff: mesmo conjunto de arquivos com os mesmos bytes → cache. */
export function regressionDiffHash(root: string, changedFiles: readonly string[]): string {
  const hash = createHash('sha256').update(GATE_VERSION);
  for (const file of [...changedFiles].sort((a, b) => a.localeCompare(b))) {
    hash.update(`\0${file}\0`);
    try {
      const abs = path.join(root, file);
      const stat = fs.lstatSync(abs);
      if (!stat.isFile() || stat.size > MAX_HASH_FILE_BYTES) {
        hash.update(`meta:${stat.size}:${stat.mtimeMs}`);
      } else {
        hash.update(fs.readFileSync(abs));
      }
    } catch {
      hash.update('deleted');
    }
  }
  return hash.digest('hex');
}

interface RunnerDetection {
  readonly kind: RegressionRunnerKind;
  readonly bin: string;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Runner do projeto alvo: vitest > jest (package.json) > pytest (trivial). */
export function detectRegressionRunner(root: string): RunnerDetection | null {
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg) {
    const deps = {
      ...(pkg.dependencies as Record<string, unknown> | undefined),
      ...(pkg.devDependencies as Record<string, unknown> | undefined),
    };
    const localBin = (name: string) => path.join(root, 'node_modules', '.bin', name);
    if ('vitest' in deps && fs.existsSync(localBin('vitest'))) {
      return { kind: 'vitest', bin: localBin('vitest') };
    }
    if ('jest' in deps && fs.existsSync(localBin('jest'))) {
      return { kind: 'jest', bin: localBin('jest') };
    }
  }
  const pyproject = (() => {
    try {
      return fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8');
    } catch {
      return '';
    }
  })();
  if (
    fs.existsSync(path.join(root, 'pytest.ini')) ||
    fs.existsSync(path.join(root, 'conftest.py')) ||
    pyproject.includes('[tool.pytest')
  ) {
    return { kind: 'pytest', bin: 'python3' };
  }
  return null;
}

interface ImpactedTests {
  readonly tests: readonly string[];
  readonly untestedFiles: readonly string[];
  readonly e2eSkipped: readonly string[];
  readonly warnings: readonly string[];
}

async function buildReverseGraph(
  scope: ProjectExecutionScope,
): Promise<{ reverse: ReadonlyMap<string, readonly string[]>; files: readonly string[]; truncated: boolean }> {
  const walk = await walkOrientationTreeAsync(scope, GRAPH_LIMITS);
  const facts: OrientationImportFileFact[] = [];
  for (const file of walk.files) {
    if (!file.isSource || !isOrientationImportSource(file.ext)) continue;
    try {
      const read = readWorkspaceTextFile(scope, file.relativePath);
      facts.push({
        relativePath: file.relativePath,
        ext: file.ext,
        size: read.size,
        importSpecifiers: extractOrientationImportSpecifiers(read.content),
      });
    } catch {
      continue;
    }
    if (facts.length % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const graph = buildOrientationImportGraphFromFacts(facts, GRAPH_LIMITS);
  return {
    reverse: graph.reverse,
    files: walk.files.map((file) => file.relativePath),
    truncated: walk.truncated,
  };
}

function colocatedTests(file: string, allFiles: readonly string[]): string[] {
  const stem = file.replace(/\.[^./]+$/u, '');
  const base = path.posix.basename(stem);
  if (file.endsWith('.py')) {
    return allFiles.filter(
      (candidate) =>
        PY_TEST_RE.test(candidate) &&
        (path.posix.basename(candidate) === `test_${base}.py` ||
          path.posix.basename(candidate) === `${base}_test.py`),
    );
  }
  const dir = path.posix.dirname(file);
  return allFiles.filter(
    (candidate) =>
      TEST_FILE_RE.test(candidate) &&
      (candidate.startsWith(`${stem}.`) ||
        (candidate.startsWith(`${dir}/__tests__/`) &&
          path.posix.basename(candidate).startsWith(`${base}.`))),
  );
}

function isSourceNeedingTest(file: string): boolean {
  if (TEST_FILE_RE.test(file) || PY_TEST_RE.test(file) || UNTESTED_IGNORE_RE.test(file)) {
    return false;
  }
  return /\.(?:[cm]?[jt]sx?|py)$/u.test(file);
}

/**
 * Testes impactados: os próprios testes tocados, os co-localizados e os que
 * importam (direta ou transitivamente, até {@link REVERSE_DEPTH} saltos) um
 * arquivo tocado. Ordem = distância no grafo (testes diretos primeiro).
 */
export async function computeImpactedTests(
  scope: ProjectExecutionScope,
  changedFiles: readonly string[],
  extraTests: readonly string[] = [],
): Promise<ImpactedTests> {
  const { reverse, files, truncated } = await buildReverseGraph(scope);
  const fileSet = new Set(files);
  const ordered: string[] = [];
  const seenTests = new Set<string>();
  const addTest = (test: string) => {
    if (!fileSet.has(test) || seenTests.has(test)) return;
    seenTests.add(test);
    ordered.push(test);
  };
  const untested: string[] = [];
  for (const file of changedFiles) {
    if (TEST_FILE_RE.test(file) || PY_TEST_RE.test(file)) addTest(file);
  }
  for (const file of changedFiles) {
    if (TEST_FILE_RE.test(file) || PY_TEST_RE.test(file)) continue;
    const before = seenTests.size;
    for (const test of colocatedTests(file, files)) addTest(test);
    const seen = new Set<string>([file]);
    let frontier = [file];
    let visits = 0;
    for (let depth = 0; depth < REVERSE_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const importer of reverse.get(node) ?? []) {
          if (seen.has(importer) || ++visits > MAX_REVERSE_VISITS) continue;
          seen.add(importer);
          if (TEST_FILE_RE.test(importer)) addTest(importer);
          else next.push(importer);
        }
      }
      frontier = next;
    }
    if (seenTests.size === before && isSourceNeedingTest(file) && fileSet.has(file)) {
      untested.push(file);
    }
  }
  for (const test of extraTests) {
    const normalized = normalizeRelative(test);
    if (normalized) addTest(normalized);
  }
  const e2eSkipped = ordered.filter((test) => E2E_FILE_RE.test(test));
  return {
    tests: ordered.filter((test) => !E2E_FILE_RE.test(test)),
    untestedFiles: untested,
    e2eSkipped,
    warnings: truncated ? ['índice do projeto truncado: o grafo de imports pode estar incompleto'] : [],
  };
}

/** Env mínimo para o processo de teste: nada de tokens do Nexus ou chaves de API. */
function sanitizedTestEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'COMSPEC', 'PATHEXT'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, CI: '1', NODE_ENV: 'test', FORCE_COLOR: '0', NO_COLOR: '1' };
}

const execDefault: RegressionExec = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        env: options.env,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
        resolve({
          exitCode: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          timedOut: err?.killed === true,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') + (err && typeof err.code === 'string' ? `\n${err.code}` : ''),
        });
      },
    );
  });

function truncate(text: string, max: number): string {
  const clean = text.replace(/\u001b\[[0-9;]*m/gu, '').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/** Relatório JSON estilo Jest (vitest --reporter=json é compatível). */
function parseJestLikeReport(root: string, raw: string): RegressionTestFailure[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const results = (parsed as { testResults?: unknown }).testResults;
  if (!Array.isArray(results)) return null;
  const failures: RegressionTestFailure[] = [];
  for (const entry of results as Array<Record<string, unknown>>) {
    if (entry.status !== 'failed') continue;
    const name = typeof entry.name === 'string' ? entry.name : '(desconhecido)';
    const file = path.isAbsolute(name) ? path.relative(root, name).replace(/\\/g, '/') : name;
    const assertions = Array.isArray(entry.assertionResults)
      ? (entry.assertionResults as Array<Record<string, unknown>>)
      : [];
    const failed = assertions.filter((assertion) => assertion.status === 'failed');
    const message =
      failed.length > 0
        ? failed
            .slice(0, 3)
            .map((assertion) => {
              const title = String(assertion.fullName ?? assertion.title ?? 'teste');
              const detail = Array.isArray(assertion.failureMessages)
                ? String(assertion.failureMessages[0] ?? '')
                : '';
              return `${title}: ${truncate(detail.split('\n')[0] ?? '', 200)}`;
            })
            .join(' | ')
        : truncate(String(entry.message ?? 'falhou ao carregar'), 300);
    failures.push({ file, message });
  }
  return failures;
}

async function runTests(
  root: string,
  runner: RunnerDetection,
  tests: readonly string[],
  timeoutMs: number,
  exec: RegressionExec,
): Promise<{ status: 'passed' | 'failed' | 'unavailable'; failures: RegressionTestFailure[]; warning?: string }> {
  const env = sanitizedTestEnv();
  if (runner.kind === 'pytest') {
    const result = await exec(runner.bin, ['-m', 'pytest', '-q', '--no-header', '-p', 'no:cacheprovider', ...tests], {
      cwd: root,
      timeoutMs,
      env,
    });
    if (result.timedOut) return { status: 'unavailable', failures: [], warning: `pytest excedeu ${timeoutMs}ms` };
    if (result.exitCode === 0 || result.exitCode === 5) return { status: 'passed', failures: [] };
    if (result.exitCode !== 1) {
      return { status: 'unavailable', failures: [], warning: `pytest não rodou (${truncate(result.stderr || result.stdout, 160)})` };
    }
    const failures = [...result.stdout.matchAll(/^FAILED (\S+?)(?:::(\S+))?(?: - (.*))?$/gmu)].map((match) => ({
      file: match[1]!,
      message: truncate(`${match[2] ?? ''} ${match[3] ?? ''}`, 300) || 'falhou',
    }));
    return {
      status: 'failed',
      failures: failures.length > 0 ? failures : [{ file: '(pytest)', message: truncate(result.stdout, 400) }],
    };
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-regression-'));
  const outFile = path.join(outDir, 'report.json');
  try {
    const args =
      runner.kind === 'vitest'
        ? ['run', '--reporter=json', `--outputFile=${outFile}`, '--passWithNoTests', ...tests]
        : ['--json', `--outputFile=${outFile}`, '--passWithNoTests', '--runTestsByPath', ...tests];
    const result = await exec(runner.bin, args, { cwd: root, timeoutMs, env });
    if (result.timedOut) {
      return { status: 'unavailable', failures: [], warning: `${runner.kind} excedeu ${timeoutMs}ms` };
    }
    const report = (() => {
      try {
        return fs.readFileSync(outFile, 'utf8');
      } catch {
        return null;
      }
    })();
    const failures = report ? parseJestLikeReport(root, report) : null;
    if (failures === null) {
      if (result.exitCode === 0) return { status: 'passed', failures: [] };
      // Sem relatório: o runner nem subiu (config quebrada, binário ausente).
      return {
        status: 'unavailable',
        failures: [],
        warning: `${runner.kind} não produziu relatório (${truncate(result.stderr || result.stdout, 160)})`,
      };
    }
    if (failures.length === 0 && result.exitCode === 0) return { status: 'passed', failures: [] };
    return {
      status: 'failed',
      failures:
        failures.length > 0
          ? failures
          : [{ file: `(${runner.kind})`, message: truncate(result.stderr || result.stdout, 400) }],
    };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

async function safeExtension<T>(label: string, warnings: string[], call: () => Promise<T> | T): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    warnings.push(`${label} indisponível: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
    return null;
  }
}

async function evaluate(
  input: RunRegressionGateInput,
  root: string,
  changedFiles: readonly string[],
  diffHash: string,
  deps: RegressionGateDependencies,
): Promise<RegressionGateResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const warnings: string[] = [];
  const extensions = deps.extensions ?? registeredExtensions;
  const base = { version: GATE_VERSION, diffHash, changedFiles, cached: false } as const;
  const finish = (partial: Omit<RegressionGateResult, keyof typeof base | 'durationMs' | 'warnings'>) =>
    Object.freeze({ ...base, ...partial, warnings: Object.freeze([...warnings]), durationMs: now() - started });

  const blastRadius = extensions.blastRadius ?? orientationBlastRadiusExtension;
  const radius = await safeExtension('blast radius estendido', warnings, () =>
    blastRadius({ scope: input.scope, changedFiles }));
  const invariants = extensions.invariants
    ? (await safeExtension('invariantes do modelo de negócio', warnings, () =>
        extensions.invariants!({ scope: input.scope }))) ?? []
    : [];
  const changedSet = new Set(changedFiles);
  const tables = new Set(radius?.tables ?? []);
  const touched = invariants.filter(
    (invariant) =>
      (invariant.arquivos ?? []).some((file) => changedSet.has(file.replace(/\\/g, '/'))) ||
      (invariant.tabelas ?? []).some((table) => tables.has(table)),
  );
  const extraTests = [...(radius?.tests ?? []), ...touched.flatMap((invariant) => invariant.testes ?? [])];

  let impacted: ImpactedTests;
  try {
    impacted = await computeImpactedTests(input.scope, changedFiles, extraTests);
  } catch (error) {
    warnings.push(`mapa de testes indisponível: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
    return finish({
      status: 'unavailable',
      testsRun: [],
      failures: [],
      untestedFiles: [],
      invariantsTouched: touched.map(({ id, regra }) => ({ id, regra })),
      runner: null,
    });
  }
  warnings.push(...impacted.warnings);
  if (impacted.e2eSkipped.length > 0) {
    warnings.push(
      `e2e impactado não executado (exige servidor/navegador): ${impacted.e2eSkipped.slice(0, 5).join(', ')}`,
    );
  }
  const invariantsTouched = touched.map(({ id, regra }) => ({ id, regra }));
  const maxTests = input.maxTestFiles ?? DEFAULT_REGRESSION_MAX_TEST_FILES;
  const tests = impacted.tests.slice(0, maxTests);
  if (impacted.tests.length > maxTests) {
    warnings.push(
      `raio grande: ${impacted.tests.length} testes impactados, rodando os ${maxTests} mais próximos do diff`,
    );
  }
  const common = { untestedFiles: impacted.untestedFiles, invariantsTouched };
  if (tests.length === 0) {
    return finish({ status: 'no-tests', testsRun: [], failures: [], runner: null, ...common });
  }
  const runner = detectRegressionRunner(root);
  if (!runner) {
    warnings.push('nenhum runner de teste detectado (vitest/jest/pytest): portão aberto sem rodar testes');
    return finish({ status: 'unavailable', testsRun: [], failures: [], runner: null, ...common });
  }
  const runnable = tests.filter((test) =>
    runner.kind === 'pytest' ? test.endsWith('.py') : !test.endsWith('.py'),
  );
  if (runnable.length === 0) {
    return finish({ status: 'no-tests', testsRun: [], failures: [], runner: runner.kind, ...common });
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_REGRESSION_TEST_TIMEOUT_MS;
  const exec = deps.exec ?? execDefault;
  let outcome = await runTests(root, runner, runnable, timeoutMs, exec);
  // Teste instável (tempo, ordem) não pode barrar entrega: os arquivos que
  // falharam rodam de novo uma vez, sozinhos; só a falha que se repete conta.
  const failedFiles = [...new Set(outcome.failures.map((failure) => failure.file))].filter(
    (file) => runnable.includes(file),
  );
  if (outcome.status === 'failed' && failedFiles.length === outcome.failures.length) {
    const retry = await runTests(root, runner, failedFiles, timeoutMs, exec);
    if (retry.status === 'passed') {
      warnings.push(`teste(s) instável(is), passaram na 2ª tentativa: ${failedFiles.slice(0, 5).join(', ')}`);
      outcome = retry;
    } else if (retry.status === 'failed') {
      outcome = retry;
    }
  }
  if (outcome.warning) warnings.push(outcome.warning);
  return finish({
    status: outcome.status,
    testsRun: runnable,
    failures: outcome.failures,
    runner: runner.kind,
    ...common,
  });
}

/**
 * Roda o portão sobre o diff atual do checkout do escopo. Mesmo diff (hash do
 * conteúdo) → resultado em cache; chamadas concorrentes compartilham a mesma
 * execução. `unavailable` não entra no cache: a próxima tentativa reavalia.
 */
export async function runRegressionGate(
  input: RunRegressionGateInput,
  deps: RegressionGateDependencies = {},
): Promise<RegressionGateResult> {
  const root = input.scope.rootRealPath;
  const changedFiles = collectRegressionChangedFiles(root, input, deps.git);
  const diffHash = regressionDiffHash(root, changedFiles);
  if (changedFiles.length === 0) {
    return Object.freeze({
      version: GATE_VERSION,
      status: 'clean',
      diffHash,
      changedFiles: [],
      testsRun: [],
      failures: [],
      untestedFiles: [],
      invariantsTouched: [],
      runner: null,
      warnings: [],
      cached: false,
      durationMs: 0,
    });
  }
  const key = `${root}\0${diffHash}`;
  const hit = cache.get(key);
  if (hit) return Object.freeze({ ...hit, cached: true });
  const running = inflight.get(key);
  if (running) return running;
  const promise = evaluate(input, root, changedFiles, diffHash, deps).then((result) => {
    if (result.status !== 'unavailable') {
      cache.set(key, result);
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    }
    return result;
  });
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

/** Texto pt-BR para o agente: o que quebrou, o que ficou sem teste. */
export function formatRegressionGateReport(result: RegressionGateResult): string {
  const lines: string[] = [];
  if (result.status === 'failed') {
    lines.push(
      `[Nexus · portão de regressão] Seu diff quebrou ${result.failures.length} arquivo(s) de teste impactado(s) — corrija antes de encerrar:`,
    );
    for (const failure of result.failures.slice(0, 8)) {
      lines.push(`- ${failure.file}: ${failure.message}`);
    }
    lines.push(
      `Testes impactados rodados (${result.runner}): ${result.testsRun.slice(0, 12).join(', ')}${result.testsRun.length > 12 ? '…' : ''}`,
    );
    lines.push('Se a falha já existia antes do seu diff, prove isso (rode o teste na base) e diga no relatório.');
  } else if (result.status === 'passed') {
    lines.push(
      `[Nexus · portão de regressão] ${result.testsRun.length} teste(s) impactado(s) passaram (${result.runner}).`,
    );
  }
  if (result.untestedFiles.length > 0) {
    lines.push(
      `Aviso: área tocada sem teste — ${result.untestedFiles.slice(0, 8).join(', ')}. Considere um teste pequeno que falhe se a lógica quebrar.`,
    );
  }
  if (result.invariantsTouched.length > 0) {
    lines.push(
      `Invariantes de negócio tocados: ${result.invariantsTouched
        .slice(0, 6)
        .map((invariant) => `${invariant.id} (${invariant.regra})`)
        .join('; ')}.`,
    );
  }
  for (const warning of result.warnings.slice(0, 4)) lines.push(`Aviso: ${warning}`);
  return lines.join('\n');
}
