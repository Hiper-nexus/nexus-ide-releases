/**
 * F-764 (A.1) — probe do watchdog no app EMPACOTADO.
 *
 * O teste com Worker real (main-thread-hang-watchdog.test.ts) prova o
 * mecanismo no Node, e o Electron 43.7.4 com os fuses de produção foi provado
 * à parte (HANDOFF do F-764). O que só o binário de release prova — Developer
 * ID, hardened runtime, asar com integridade — fica com este probe, que roda
 * DENTRO dele: ligado só no modo smoke (`nexus-smoke-test`) com
 * `NEXUS_SMOKE_HANG_PROBE=1`. O watchdog arma com limiar curto e a main trava
 * ~40 s de propósito no carregamento do módulo, antes de qualquer serviço ou
 * timer do boot existir (nada para disparar fora de hora). O harness
 * `node scripts/smoke-packaged-app.mjs --verify-hang-probe` confere o
 * `.cpuprofile` e o smoke funcional segue normal depois.
 */

import type { HangWatchdogRecord, HangWatchdogTuning } from './hang-watchdog-logic';

export const SMOKE_HANG_PROBE_ENV = 'NEXUS_SMOKE_HANG_PROBE';
/** O nome que o profile do app empacotado tem de mostrar no topo. */
export const SMOKE_HANG_PROBE_FUNCTION = 'nexusSmokeInducedMainHang';
export const SMOKE_HANG_PROBE_BLOCK_MS = 40_000;
export const SMOKE_HANG_PROBE_HEARTBEAT_MS = 250;
/** Limiar curto: detecta em ~1,5 s e perfila 1,5 s durante o bloqueio de 40 s. */
export const SMOKE_HANG_PROBE_TUNING: HangWatchdogTuning = {
  thresholdMs: 1_500,
  checkIntervalMs: 250,
  profileDurationMs: 1_500,
  inspectorTimeoutMs: 10_000,
};

/** Só o modo smoke liga o probe; a env sozinha nunca trava um launch normal. */
export function isSmokeHangProbeRequested(input: {
  readonly smokeTest: boolean;
  readonly env: NodeJS.ProcessEnv;
}): boolean {
  return input.smokeTest && input.env[SMOKE_HANG_PROBE_ENV] === '1';
}

/**
 * A regex do limit-detector ANTES da correção do F-764 — cúbica numa tela de
 * TUI em branco. Usada SÓ aqui, de propósito: o probe trava a main do mesmo
 * jeito que o incidente travou.
 */
const F764_CUBIC_LIMIT_RE = /^[\s⎿│]*(?:claude|error:?)?\s*usage limit reached/im;

/**
 * O laço da prova. Método de objeto de propósito: a minificação do bundle do
 * main renomeia funções, mas não chaves de objeto — é este nome que aparece
 * no profile do app empacotado.
 *
 * O trabalho é a regex, não um laço apertado: cada `exec` leva ~100 ms+, o
 * laço dá poucas voltas e o V8 não o recompila no meio (OSR). Um laço só de
 * `Date.now()` entra em OSR antes de o profiler ligar, e o profiler do V8 não
 * enxerga código OSR já existente — as amostras caem no CHAMADOR (visto no
 * Electron 43.7.4 com o bundle minificado: topo `A`, não este nome).
 */
const SMOKE_HANG_INDUCER = {
  nexusSmokeInducedMainHang(durationMs: number): number {
    const blankTuiScreen = `${' \n'.repeat(600)}x`;
    const until = Date.now() + durationMs;
    let spins = 0;
    while (Date.now() < until) {
      F764_CUBIC_LIMIT_RE.exec(blankTuiScreen);
      spins += 1;
    }
    return spins;
  },
};

/** Trava a main thread pelo tempo pedido, sem ceder o event loop. */
export function induceSmokeMainHang(durationMs: number = SMOKE_HANG_PROBE_BLOCK_MS): number {
  return SMOKE_HANG_INDUCER.nexusSmokeInducedMainHang(durationMs);
}

/** Linha curta para o stdout do smoke (o harness confere os arquivos). */
export function describeHangRecordForSmoke(record: HangWatchdogRecord): string {
  if (record.kind === 'main-thread-hang') {
    return `[smoke] hang-probe: travamento detectado (${record.hangDurationMs} ms sem heartbeat)`;
  }
  if (record.kind === 'main-thread-hang-recovered') {
    return `[smoke] hang-probe: main de volta (${record.hangDurationMs} ms)`;
  }
  if (record.profilerUnavailable) {
    return `[smoke] hang-probe: profile indisponível: ${record.profilerUnavailable}`;
  }
  const top = record.topFrames?.[0];
  return (
    `[smoke] hang-probe: profile ${record.profileFile ?? '(não gravado)'}` +
    (top ? ` topo=${top.functionName} (${top.selfPercent}%)` : '')
  );
}
