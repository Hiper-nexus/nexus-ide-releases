import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * F-1217 (generaliza o F-715): suítes que montam o PRÓPRIO nexus-pty-supervisor
 * não rodam sob outro.
 *
 * O supervisor recusa a autorização de lançamento quando o processo
 * responsável (macOS responsibility) já é um nexus-pty-supervisor
 * (`native/darwin-pty-supervisor/main.c`, `responsible_is_supervisor`) e sai
 * com 76. Todo processo nascido num pane ou terminal do Nexus — inclusive a
 * suíte que um agente roda ali — herda essa responsabilidade, então essas
 * suítes falhavam com 76 por ambiente, e agentes liam como regressão.
 *
 * Detector barato e sem falso negativo prático:
 * - um ancestral cujo executável é `nexus-pty-supervisor` (uma leitura de
 *   `ps`, cacheada; cobre também terminais humanos e a fila heavy, que roda o
 *   comando sob `__run-disclaimed-heavy-job`);
 * - ou `NEXUS_PANE_KEY`/`NEXUS_PANE_ID`, que o pane de agente exporta e que
 *   sobrevivem a um filho reparentado (a responsabilidade também sobrevive).
 * Fora do Nexus — launchd, CI, terminal comum — nada disso existe e as suítes
 * rodam normalmente.
 */
export const PTY_SUPERVISOR_EXECUTABLE = 'nexus-pty-supervisor';

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

export function nestedPtySupervisorEvidence(input: {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly env: NodeJS.ProcessEnv;
  readonly processes: readonly ProcessRow[] | null;
}): string | undefined {
  if (input.platform !== 'darwin') return undefined;
  const byPid = new Map((input.processes ?? []).map((row) => [row.pid, row]));
  let current = byPid.get(input.pid);
  for (let hops = 0; current && current.ppid > 1 && hops < 128; hops += 1) {
    const parent = byPid.get(current.ppid);
    if (!parent) break;
    if (path.basename(parent.command) === PTY_SUPERVISOR_EXECUTABLE) return `ancestral pid ${parent.pid} é ${PTY_SUPERVISOR_EXECUTABLE}`;
    current = parent;
  }
  const pane = input.env.NEXUS_PANE_KEY?.trim() ? 'NEXUS_PANE_KEY' : input.env.NEXUS_PANE_ID?.trim() ? 'NEXUS_PANE_ID' : undefined;
  return pane ? `${pane} herdado de um pane do Nexus` : undefined;
}

export function parseProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return rows;
}

function readProcessTable(): ProcessRow[] | null {
  try {
    return parseProcessTable(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }));
  } catch {
    // Sandbox sem process-info: sobra o sinal do ambiente.
    return null;
  }
}

let cached: { readonly reason: string | undefined } | undefined;

/** Motivo para pular (texto do reporter), ou `undefined` quando a suíte pode montar o próprio supervisor. */
export function nestedPtySupervisorSkipReason(): string | undefined {
  if (!cached) {
    const evidence = nestedPtySupervisorEvidence({
      platform: process.platform,
      pid: process.pid,
      env: process.env,
      processes: process.platform === 'darwin' ? readProcessTable() : null,
    });
    cached = {
      reason: evidence
        ? `AMBIENTE-PANE (F-715/F-1217): este processo já roda sob um ${PTY_SUPERVISOR_EXECUTABLE} (${evidence}), ` +
          'que recusa o supervisor próprio da suíte com exit 76 (responsible_is_supervisor). ' +
          'Rode via launchd (job one-shot) ou fora do Nexus.'
        : undefined,
    };
  }
  return cached.reason;
}

let announced = false;

/**
 * Pula o teste corrente quando ele montaria o próprio supervisor sob outro.
 * O motivo aparece na nota do reporter, no `meta` do relatório JSON e, uma vez
 * por arquivo, no stderr (o reporter `dot` não mostra notas).
 */
export function skipUnderNexusPtySupervisor(context: { readonly skip: (note?: string) => never; readonly task: { readonly meta: object } }): void {
  const reason = nestedPtySupervisorSkipReason();
  if (!reason) return;
  (context.task.meta as Record<string, unknown>).nexusSkipReason = reason;
  if (!announced) {
    announced = true;
    console.warn(`[nexus-test] testes PULADOS — ${reason}`);
  }
  context.skip(reason);
}

/** Texto que o `nexus-pty-supervisor` imprime ao recusar o lançamento (exit 76). */
export const SUPERVISOR_LAUNCH_REJECTED = 'launch authorization rejected';

type SkipContext = { readonly skip: (note?: string) => never };

/** EPERM/EACCES: o Seatbelt do portão nega leitura/escrita fora do checkout. */
export function hostDenied(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

/**
 * Exit 76 com o texto do supervisor: o portão tira `NEXUS_PANE_*` e nega o
 * `ps`, então `skipUnderNexusPtySupervisor` não vê o ancestral. Não é a fila.
 */
export function supervisorLaunchRejected(code: number | null, output: string): boolean {
  return code === 76 && output.includes(SUPERVISOR_LAUNCH_REJECTED);
}

export function skipIfSupervisorLaunchRejected(context: SkipContext, code: number | null, output: string): void {
  if (!supervisorLaunchRejected(code, output)) return;
  context.skip(
    'AMBIENTE-PANE (F-1217): o supervisor recusou o lançamento (exit 76, launch authorization rejected). ' +
    'O portão tira NEXUS_PANE_* e nega o ps, então a suíte não vê o ancestral. Não é a fila heavy.',
  );
}

/**
 * Diretório de controle ao lado do checkout: fora do TMP (o Codex recusa
 * CODEX_HOME ali) e fora do HOME nativo. O portão nega essa escrita.
 */
export function controlDirOutsideCheckout(context: SkipContext, prefix: string): string {
  try {
    return fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(process.cwd()), prefix)));
  } catch (error) {
    if (!hostDenied(error)) throw error;
    context.skip(
      `AMBIENTE-SANDBOX (F-1217): mkdtemp ${prefix} fora do checkout recusado (${(error as { code?: string }).code}). ` +
      'O diretório fica fora do TMP e do HOME nativo; o portão nega essa escrita.',
    );
  }
}

/** realpath de um binário fora do checkout (o Grok mora em ~/.grok). */
export function realpathOrSkip(context: SkipContext, file: string, label: string): string {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    if (!hostDenied(error)) throw error;
    context.skip(`AMBIENTE-SANDBOX (F-1217): realpath de ${label} recusado (${(error as { code?: string }).code}).`);
  }
}
