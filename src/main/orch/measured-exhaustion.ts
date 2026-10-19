/**
 * Camada 3.2 — o caso do relato: a CLI emudece em vez de imprimir um erro.
 *
 * `limit-signal-patterns.ts` não tem nenhuma entrada AGY/Gemini, e os padrões
 * genéricos exigem moldura de erro HTTP. Um AGY que esgota e para em silêncio
 * nunca produzia `LimitHit`, então `performSwitch` nunca era chamado e o pane
 * ficava parado até alguém notar. Era o relato do cliente, em qualquer
 * plataforma.
 *
 * Aqui a prova é a API do provedor, não o terminal — por isso não fere o
 * F-249 ("limite não confirmado não troca o pane"): o texto citado continua
 * sem valor, e o que autoriza é uma leitura `provider-api` fresca.
 *
 * O hit sintetizado entra no `commitLimitHit` que já existe, que já religa
 * orquestrador (rebind + pacote de continuidade), já respawna worker e já
 * encadeia para a troca de CLI quando não sobra conta (F-775 item 2).
 *
 * Deps injetáveis para manter isto testável fora do harness do failover.
 */
import { accountDrainEvidence } from '../persistence/account-drain-evidence';
import { decideDrainSwap } from './drain-watchdog';
import type { HeadroomInput } from '../quota/account-headroom';
import type { LimitHit } from './limit-detector';

/** Mesmo teto que a troca por limite de texto usa para conta esgotada. */
const MEASURED_EXHAUSTION_COOLDOWN_MS = 60 * 60_000;

export interface MeasuredExhaustionInput {
  readonly paneId: string;
  readonly sessionId: string;
  readonly adapterId: string;
  readonly accountId: string | null;
  /** Há entrega esperando este pane? Sem isso a troca inventaria trabalho. */
  readonly hasPendingWork: boolean;
  readonly now: number;
}

export interface MeasuredExhaustionDeps {
  headroomFor(adapterId: string, accountId: string): HeadroomInput | undefined;
  lastSwapAt(paneId: string): number | null;
  noteSwap(paneId: string, at: number): void;
  commitHit(input: { readonly sessionId: string; readonly hit: LimitHit }): void;
}

export interface MeasuredExhaustionResult {
  readonly acted: boolean;
  readonly reason: string;
}

export function reportMeasuredExhaustion(
  input: MeasuredExhaustionInput,
  deps: MeasuredExhaustionDeps,
): MeasuredExhaustionResult {
  if (!input.accountId) return { acted: false, reason: 'pane sem conta' };
  const decision = decideDrainSwap({
    headroom: deps.headroomFor(input.adapterId, input.accountId),
    hasPendingWork: input.hasPendingWork,
    lastSwapAt: deps.lastSwapAt(input.paneId),
    evidence: accountDrainEvidence(input.now),
  });
  if (!decision.swap) return { acted: false, reason: decision.reason };
  const hit: LimitHit = {
    kind: 'quota',
    // Nunca uma frase de CLI: este motivo é lido por humanos E passa perto do
    // detector de texto. "cota medida" não casa nenhum padrão de limite.
    reason: 'cota medida esgotada pela API do provedor (pane em silêncio)',
    cooldownMs: MEASURED_EXHAUSTION_COOLDOWN_MS,
    adapterId: input.adapterId,
    // A medição É a confirmação: não há sonda a esperar.
    confirmedAt: input.now,
  };
  deps.commitHit({ sessionId: input.sessionId, hit });
  deps.noteSwap(input.paneId, input.now);
  return { acted: true, reason: decision.reason };
}
