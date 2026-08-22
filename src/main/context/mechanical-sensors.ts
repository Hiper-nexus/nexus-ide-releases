import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Sensores mecânicos Nexus-owned (Etapa 2 do plano dev-sênior).
 *
 * Diferença essencial para os sensores do context-doctor: estes NÃO dependem
 * de scripts no package.json do projeto-alvo. Enquanto existir tsconfig ou
 * lockfile, o Nexus verifica sozinho — projeto greenfield não pode concluir
 * sem NENHUMA verificação só porque ninguém escreveu "typecheck": "..." nele.
 *
 * Fail-open como todo o resto: ferramenta ausente, timeout ou binário quebrado
 * devolvem 'unavailable' com motivo — nunca bloqueiam por infraestrutura.
 */

const execFileAsync = promisify(execFile);

const TYPECHECK_TIMEOUT_MS = 120_000;
const AUDIT_TIMEOUT_MS = 45_000;
const MAX_FINDINGS_PER_SENSOR = 20;

export type MechanicalSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface MechanicalFinding {
  readonly severity: MechanicalSeverity;
  readonly file: string;
  readonly evidence: string;
  readonly recommendation: string;
}

export type MechanicalCheckKind = 'typecheck' | 'dependency-audit';

export interface MechanicalCheckResult {
  readonly kind: MechanicalCheckKind;
  readonly status: 'passed' | 'failed' | 'unavailable';
  /** Frase curta em PT para o laudo da missão. */
  readonly summary: string;
  readonly findings: readonly MechanicalFinding[];
}

export interface MechanicalExecOptions {
  readonly cwd: string;
  readonly timeout: number;
  readonly windowsHide: boolean;
}

/** Assinatura estrutural mínima — injetável sem herdar o tipo do promisify. */
export type MechanicalExec = (
  file: string,
  args: readonly string[],
  options: MechanicalExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface MechanicalRunnerDeps {
  readonly exec?: MechanicalExec;
  readonly exists?: (path: string) => boolean;
  readonly now?: () => number;
}

const execDefault: MechanicalExec = (file, args, options) =>
  execFileAsync(file, args, {
    ...options,
    encoding: 'utf8',
  }) as unknown as Promise<{ stdout: string; stderr: string }>;

function truncate(text: string, max = 240): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/* ------------------------------------------------------------------ */
/* Typecheck — tsc --noEmit quando existe tsconfig.json                */
/* ------------------------------------------------------------------ */

const TSC_ERROR_LINE =
  /^\s*([^(\s]+)\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)$/u;

export async function runTypecheckSensor(
  root: string,
  deps: MechanicalRunnerDeps = {},
): Promise<MechanicalCheckResult> {
  const exec = deps.exec ?? execDefault;
  const exists = deps.exists ?? existsSync;
  if (!exists(join(root, 'tsconfig.json'))) {
    return {
      kind: 'typecheck',
      status: 'unavailable',
      summary: 'Typecheck indisponível (sem tsconfig.json no projeto).',
      findings: [],
    };
  }
  const bin = join(root, 'node_modules', '.bin', 'tsc');
  const useLocal = exists(bin);
  if (!useLocal && !exists(join(root, 'package.json'))) {
    return {
      kind: 'typecheck',
      status: 'unavailable',
      summary: 'Typecheck indisponível (TypeScript não instalado no projeto).',
      findings: [],
    };
  }
  try {
    await exec(
      useLocal ? bin : 'npx',
      useLocal
        ? ['--noEmit', '--pretty', 'false']
        : ['--no-install', 'tsc', '--noEmit', '--pretty', 'false'],
      { cwd: root, timeout: TYPECHECK_TIMEOUT_MS, windowsHide: true },
    );
    return {
      kind: 'typecheck',
      status: 'passed',
      summary: 'Typecheck: ✓ compila sem erros.',
      findings: [],
    };
  } catch (error) {
    const err = error as { code?: unknown; stdout?: unknown; killed?: unknown };
    if (err.killed === true) {
      return {
        kind: 'typecheck',
        status: 'unavailable',
        summary: 'Typecheck indisponível (tempo limite excedido).',
        findings: [],
      };
    }
    if (typeof err.code === 'string') {
      // ENOENT etc.: binário não executável é infraestrutura, não código.
      return {
        kind: 'typecheck',
        status: 'unavailable',
        summary: 'Typecheck indisponível (TypeScript não instalado no projeto).',
        findings: [],
      };
    }
    const stdout = typeof err.stdout === 'string' ? err.stdout : '';
    const findings: MechanicalFinding[] = [];
    for (const line of stdout.split('\n')) {
      const match = TSC_ERROR_LINE.exec(line);
      if (!match) continue;
      findings.push({
        severity: 'high',
        file: match[1]!,
        evidence: `TS ${match[3]}: ${truncate(match[4]!)}`,
        recommendation: 'Corrija o erro de compilação antes de concluir.',
      });
      if (findings.length >= MAX_FINDINGS_PER_SENSOR) break;
    }
    if (findings.length === 0) {
      return {
        kind: 'typecheck',
        status: 'failed',
        summary: `Typecheck: ✗ falhou (${truncate(stdout.trim() || 'erro desconhecido', 160)})`,
        findings: [
          {
            severity: 'high',
            file: '(saída do compilador)',
            evidence: truncate(stdout.trim(), 400),
            recommendation: 'Corrija os erros de compilação antes de concluir.',
          },
        ],
      };
    }
    return {
      kind: 'typecheck',
      status: 'failed',
      summary: `Typecheck: ✗ ${findings.length} erro(s) de compilação.`,
      findings,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Dependency audit — npm audit --omit=dev quando existe lockfile       */
/* ------------------------------------------------------------------ */

interface AuditVulnerability {
  readonly name?: string;
  readonly severity?: string;
}

interface AuditPayload {
  readonly metadata?: {
    readonly vulnerabilities?: {
      readonly critical?: number;
      readonly high?: number;
      readonly moderate?: number;
      readonly low?: number;
    };
  };
  readonly vulnerabilities?: Record<string, AuditVulnerability>;
}

const LOCKFILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
] as const;

function auditFindings(payload: AuditPayload): MechanicalFinding[] {
  const findings: MechanicalFinding[] = [];
  const vulns = payload.vulnerabilities ?? {};
  for (const [name, info] of Object.entries(vulns)) {
    const severity =
      info.severity === 'critical'
        ? 'critical'
        : info.severity === 'high'
          ? 'high'
          : null;
    if (!severity) continue;
    findings.push({
      severity,
      file: `(dependência) ${name}`,
      evidence: `Dependência "${name}" com vulnerabilidade ${severity === 'critical' ? 'CRÍTICA' : 'ALTA'} em produção.`,
      recommendation: `Atualize ou substitua "${name}" (npm audit fix / upgrade da versão).`,
    });
    if (findings.length >= MAX_FINDINGS_PER_SENSOR) break;
  }
  return findings;
}

export async function runDependencyAuditSensor(
  root: string,
  deps: MechanicalRunnerDeps = {},
): Promise<MechanicalCheckResult> {
  const exec = deps.exec ?? execDefault;
  const exists = deps.exists ?? existsSync;
  if (!exists(join(root, 'package.json'))) {
    return {
      kind: 'dependency-audit',
      status: 'unavailable',
      summary: 'Auditoria de dependências indisponível (sem package.json).',
      findings: [],
    };
  }
  if (!LOCKFILES.some((lock) => exists(join(root, lock)))) {
    return {
      kind: 'dependency-audit',
      status: 'unavailable',
      summary: 'Auditoria de dependências indisponível (sem lockfile).',
      findings: [],
    };
  }
  let stdout: string;
  try {
    const result = await exec(
      'npm',
      ['audit', '--omit=dev', '--json'],
      { cwd: root, timeout: AUDIT_TIMEOUT_MS, windowsHide: true },
    );
    stdout = result.stdout;
  } catch (error) {
    const err = error as { code?: unknown; stdout?: unknown; killed?: unknown };
    // npm audit sai com código ≠ 0 QUANDO encontra vulnerabilidades — o JSON
    // vem mesmo assim. Só timeout/rede/binário ausente são indisponíveis.
    if (err.killed === true || err.code === 'ENOENT') {
      return {
        kind: 'dependency-audit',
        status: 'unavailable',
        summary:
          err.killed === true
            ? 'Auditoria de dependências indisponível (tempo limite — offline?).'
            : 'Auditoria de dependências indisponível (npm não encontrado).',
        findings: [],
      };
    }
    if (typeof err.stdout !== 'string' || !err.stdout.trim().startsWith('{')) {
      return {
        kind: 'dependency-audit',
        status: 'unavailable',
        summary: 'Auditoria de dependências indisponível (registry inacessível).',
        findings: [],
      };
    }
    stdout = err.stdout;
  }
  let payload: AuditPayload;
  try {
    payload = JSON.parse(stdout) as AuditPayload;
  } catch {
    return {
      kind: 'dependency-audit',
      status: 'unavailable',
      summary: 'Auditoria de dependências indisponível (resposta inválida).',
      findings: [],
    };
  }
  const counts = payload.metadata?.vulnerabilities ?? {};
  const blocking = auditFindings(payload);
  if (blocking.length === 0) {
    const moderate = counts.moderate ?? 0;
    const low = counts.low ?? 0;
    return {
      kind: 'dependency-audit',
      status: 'passed',
      summary:
        moderate + low > 0
          ? `Auditoria: ✓ sem vulnerabilidades críticas/altas (${moderate} média(s), ${low} baixa(s)).`
          : 'Auditoria: ✓ nenhuma vulnerabilidade conhecida.',
      findings: [],
    };
  }
  const critical = blocking.filter((f) => f.severity === 'critical').length;
  const high = blocking.length - critical;
  return {
    kind: 'dependency-audit',
    status: 'failed',
    summary: `Auditoria: ✗ ${critical} crítica(s), ${high} alta(s) em produção.`,
    findings: blocking,
  };
}
