import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

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

export type MechanicalCheckKind =
  | 'typecheck'
  | 'dependency-audit'
  | 'test-coverage';

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

const AUDIT_COUNT_SEVERITIES = ['critical', 'high', 'moderate', 'low'] as const;

const auditPayloadSchema = z.object({
  error: z.never().optional(),
  metadata: z.object({
    vulnerabilities: z.object({
      critical: z.number().int().nonnegative(),
      high: z.number().int().nonnegative(),
      moderate: z.number().int().nonnegative(),
      low: z.number().int().nonnegative(),
    }),
  }),
  vulnerabilities: z.record(z.string(), z.object({
    name: z.string().optional(),
    severity: z.enum(['info', 'low', 'moderate', 'high', 'critical']),
  })),
}).refine((payload) => {
  const vulnerabilities = Object.values(payload.vulnerabilities);
  return AUDIT_COUNT_SEVERITIES.every((severity) =>
    payload.metadata.vulnerabilities[severity] ===
    vulnerabilities.filter((vulnerability) => vulnerability.severity === severity).length,
  );
}, 'Contagens de vulnerabilidades divergentes dos registros');

type AuditPayload = z.infer<typeof auditPayloadSchema>;

const LOCKFILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
] as const;

function auditFindings(payload: AuditPayload): MechanicalFinding[] {
  const findings: MechanicalFinding[] = [];
  for (const [name, info] of Object.entries(payload.vulnerabilities)) {
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

/**
 * Leitura tolerante das contagens em `metadata.vulnerabilities` direto do JSON
 * cru, para quando o schema completo não valida. F-408: sem isto, uma resposta
 * com contagens bloqueantes mas mapa de registros em outro formato (`advisories`
 * no npm v6, ou re-chaveamento por proxy de registry) virava `unavailable`
 * silencioso. Devolve `null` quando nem as contagens são legíveis — aí sim é
 * indisponibilidade honesta.
 */
function readRawAuditCounts(
  stdout: string,
): { critical: number; high: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const metadata = (parsed as { metadata?: unknown }).metadata;
  if (typeof metadata !== 'object' || metadata === null) return null;
  const vulnerabilities = (metadata as { vulnerabilities?: unknown })
    .vulnerabilities;
  if (typeof vulnerabilities !== 'object' || vulnerabilities === null) {
    return null;
  }
  const read = (key: string): number => {
    const value = (vulnerabilities as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : 0;
  };
  return { critical: read('critical'), high: read('high') };
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
  // F-408: `npm audit` precisa de `package-lock.json` para resolver a árvore.
  // Num projeto pnpm/yarn/bun ele sai com ENOLOCK sem produzir dado nenhum, e o
  // resultado era `unavailable` com `findings: []` — que o consumidor
  // (civilian-auto-review) não bloqueia, porque ele monta `blocking` só a partir
  // de findings. Um controle de segurança que não executou não pode ser
  // registrado como satisfeito, então isto é bloqueante: ou a auditoria roda com
  // o gerenciador que o lockfile implica, ou a entrega espera.
  if (!exists(join(root, 'package-lock.json'))) {
    const detected = LOCKFILES.filter((lock) => exists(join(root, lock)));
    return {
      kind: 'dependency-audit',
      status: 'failed',
      summary:
        'Auditoria: ✗ não executada — o projeto usa ' +
        `${detected.join(', ')} e o sensor só sabe auditar package-lock.json.`,
      findings: [
        {
          severity: 'high',
          file: `(dependência) ${detected[0] ?? 'lockfile'}`,
          evidence:
            'O sensor de auditoria executa `npm audit`, que exige package-lock.json. ' +
            `Este projeto tem ${detected.join(', ')}, então nenhuma vulnerabilidade foi verificada.`,
          recommendation:
            'Rode a auditoria do gerenciador real do projeto (pnpm audit / yarn npm audit / bun audit) ' +
            'ou gere um package-lock.json. Não conclua a entrega sem uma auditoria executada.',
        },
      ],
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
    payload = auditPayloadSchema.parse(JSON.parse(stdout));
  } catch {
    // F-408: o schema tem um .refine() que detecta contagens em
    // `metadata.vulnerabilities` divergentes do mapa de registros — e esse
    // `catch` descartava a detecção, transformando-a em `unavailable` sem
    // findings, que o consumidor não bloqueia. npm v6 emite `advisories` em vez
    // de `vulnerabilities`, e um proxy de registry ou uma mudança de chave faz o
    // mesmo; em todos esses casos as contagens dizem que há critical/high e o
    // mapa não produz nada. Se o npm reportou contagens bloqueantes, isso é
    // bloqueante mesmo sem conseguirmos ler os registros.
    const raw = readRawAuditCounts(stdout);
    if (raw !== null && raw.critical + raw.high > 0) {
      return {
        kind: 'dependency-audit',
        status: 'failed',
        summary:
          `Auditoria: ✗ ${raw.critical} crítica(s), ${raw.high} alta(s) reportadas em produção, ` +
          'mas os registros individuais não puderam ser lidos.',
        findings: [
          {
            severity: raw.critical > 0 ? 'critical' : 'high',
            file: '(dependência) resumo da auditoria',
            evidence:
              `npm audit reportou ${raw.critical} crítica(s) e ${raw.high} alta(s) em metadata.vulnerabilities, ` +
              'mas o mapa de registros não veio no formato esperado, então os pacotes afetados não puderam ser nomeados.',
            recommendation:
              'Rode `npm audit --omit=dev` manualmente para ver os pacotes afetados e atualize-os. ' +
              'Não conclua a entrega com contagens bloqueantes não inspecionadas.',
          },
        ],
      };
    }
    return {
      kind: 'dependency-audit',
      status: 'unavailable',
      summary: 'Auditoria de dependências indisponível (resposta inválida).',
      findings: [],
    };
  }
  const counts = payload.metadata.vulnerabilities;
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

/* ------------------------------------------------------------------ */
/* Test Coverage — verificação adversarial de testes co-localizados     */
/* ------------------------------------------------------------------ */

const TEST_EXT_REGEX = /\.(test|spec)\.[jt]sx?$/u;
const CODE_EXT_REGEX = /\.[jt]sx?$/u;

export async function runTestCoverageSensor(
  root: string,
  productFiles: readonly string[] = [],
  deps: MechanicalRunnerDeps = {},
): Promise<MechanicalCheckResult> {
  const exists = deps.exists ?? existsSync;

  const sourceFiles = productFiles.filter((file) => {
    if (!CODE_EXT_REGEX.test(file)) return false;
    if (TEST_EXT_REGEX.test(file)) return false;
    if (file.endsWith('.d.ts')) return false;
    if (file.includes('.config.') || file.startsWith('scripts/')) return false;
    return true;
  });

  if (sourceFiles.length === 0) {
    return {
      kind: 'test-coverage',
      status: 'passed',
      summary: 'Cobertura de testes: ✓ dispensada (apenas testes, docs ou configs modificados).',
      findings: [],
    };
  }

  const missingTests: string[] = [];

  for (const sourceFile of sourceFiles) {
    const extMatch = sourceFile.match(/\.([jt]sx?)$/u);
    if (!extMatch) continue;
    const base = sourceFile.slice(0, -extMatch[0].length);
    const possibleTests = [
      `${base}.test.${extMatch[1]}`,
      `${base}.spec.${extMatch[1]}`,
      `${base}.test.ts`,
      `${base}.spec.ts`,
      `${base}.test.tsx`,
      `${base}.spec.tsx`,
    ];

    const hasSibling = possibleTests.some((candidate) => {
      return productFiles.includes(candidate) || exists(join(root, candidate));
    });

    if (!hasSibling) {
      missingTests.push(sourceFile);
    }
  }

  if (missingTests.length === 0) {
    return {
      kind: 'test-coverage',
      status: 'passed',
      summary: `Cobertura de testes: ✓ ${sourceFiles.length} arquivo(s) fonte possuem testes correspondentes.`,
      findings: [],
    };
  }

  const findings: MechanicalFinding[] = missingTests.slice(0, MAX_FINDINGS_PER_SENSOR).map((file) => {
    const siblingName = file.replace(/\.([jt]sx?)$/u, '.test.$1');
    return {
      severity: 'medium',
      file,
      evidence: 'Arquivo de código alterado sem teste automatizado sibling (.test.ts ou .spec.ts).',
      recommendation: `Crie um teste co-localizado (${siblingName}) cobrindo os novos fluxos e invariantes de ${file}.`,
    };
  });

  return {
    kind: 'test-coverage',
    status: 'passed',
    summary: `Cobertura de testes: ${missingTests.length} arquivo(s) de código sem teste sibling co-localizado.`,
    findings,
  };
}
