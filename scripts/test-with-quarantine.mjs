import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUARANTINE_PATH = path.join(ROOT, 'tests', 'quarantine.json');

function normalizeFile(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) return null;
  const normalized = value.replaceAll('\\', '/');
  return normalized.startsWith('../') || normalized.includes('/../') || /[*?\[\]{}]/u.test(normalized) ? null : normalized;
}

/** Lê a lista versionada sem aceitar curingas que esconderiam uma regressão nova. */
export function parseQuarantine(value) {
  if (!value || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.tests)) {
    throw new Error('tests/quarantine.json deve ter { version: 1, tests: [...] }');
  }
  const entries = new Map();
  for (const entry of value.tests) {
    const file = normalizeFile(entry?.file);
    if (!file || typeof entry?.reason !== 'string' || entry.reason.trim().length < 12 || entries.has(file)) {
      throw new Error('entrada inválida ou repetida em tests/quarantine.json');
    }
    entries.set(file, entry.reason.trim());
  }
  return entries;
}

function reportFile(root, name) {
  if (typeof name !== 'string') return null;
  const relative = (path.isAbsolute(name) ? path.relative(root, name) : name).replaceAll(path.sep, '/');
  return normalizeFile(relative);
}

/** Separação pura do relatório JSON do Vitest, exercitada sem rodar a suíte. */
export function classifyVitestReport(report, quarantine, root = ROOT) {
  const failed = new Set();
  for (const result of Array.isArray(report?.testResults) ? report.testResults : []) {
    const assertions = Array.isArray(result?.assertionResults) ? result.assertionResults : [];
    if (result?.status !== 'failed' && !assertions.some((assertion) => assertion?.status === 'failed')) continue;
    const file = reportFile(root, result?.name);
    if (file) failed.add(file);
  }
  const quarantined = [];
  const newFailures = [];
  for (const file of [...failed].sort((left, right) => left.localeCompare(right))) {
    const reason = quarantine.get(file);
    (reason ? quarantined : newFailures).push(reason ? { file, reason } : { file });
  }
  return { quarantined, newFailures };
}

export function formatQuarantineReport(result) {
  const lines = [];
  lines.push(`Vitest: ${result.quarantined.length} falha(s) em quarentena; ${result.newFailures.length} falha(s) nova(s).`);
  if (result.quarantined.length) {
    lines.push('Em quarentena:');
    for (const entry of result.quarantined) lines.push(`- ${entry.file}: ${entry.reason}`);
  }
  if (result.newFailures.length) {
    lines.push('Falhas novas:');
    for (const entry of result.newFailures) lines.push(`- ${entry.file}`);
  }
  return lines.join('\n');
}

function run() {
  if (process.argv.slice(2).some((argument) => argument === '--outputFile' || argument.startsWith('--outputFile='))) {
    throw new Error('test-with-quarantine controla --outputFile para classificar falhas');
  }
  const quarantine = parseQuarantine(JSON.parse(fs.readFileSync(QUARANTINE_PATH, 'utf8')));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-vitest-report-'));
  const outputFile = path.join(directory, 'report.json');
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--reporter=json', `--outputFile=${outputFile}`, ...process.argv.slice(2)],
      { cwd: ROOT, stdio: 'inherit', env: process.env },
    );
    if (!fs.existsSync(outputFile)) {
      console.error('Vitest não produziu relatório JSON; a execução permanece falha.');
      return result.status ?? 1;
    }
    const classified = classifyVitestReport(JSON.parse(fs.readFileSync(outputFile, 'utf8')), quarantine);
    console.log(formatQuarantineReport(classified));
    // Saída não-zero sem caso nomeado no JSON (crash do runner, timeout, erro
    // de configuração) nunca entra na quarentena por acidente.
    return classified.newFailures.length === 0 && result.status !== null ? 0 : 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
