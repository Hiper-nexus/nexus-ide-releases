/**
 * F-1167: contratos da interface do motor de decisão (calibração e painel da
 * missão). Só dados agregados: nenhum segredo, nenhum texto de estado.
 */
import { z } from 'zod';
import type { MissionDecisionHints } from './orch-types';

/** Modelos medidos na calibração (espelha DECISION_EVAL_MODELS do Main). */
export type DecisionCalibrationModel = 'jev' | 'clef' | 'clef-flash' | 'clef-omni' | 'luna';

/**
 * Calibrar exige confirmação explícita; cancelar a calibração em curso usa o
 * mesmo canal com `{ cancel: true }`. Nada além disso é aceito.
 */
export const calibrateDecisionModelsRequestSchema = z.union([
  z.object({ confirm: z.literal(true) }).strict(),
  z.object({ cancel: z.literal(true) }).strict(),
]);
/** O plano não recebe nada (undefined ou objeto vazio). */
export const calibrationPlanRequestSchema = z.union([z.undefined(), z.object({}).strict()]);
export const decisionMissionPanelRequestSchema = z.object({ missionId: z.string().min(1).max(256) }).strict();

export type CalibrateDecisionModelsRequest = z.infer<typeof calibrateDecisionModelsRequestSchema>;
export type DecisionMissionPanelRequest = z.infer<typeof decisionMissionPanelRequestSchema>;

export interface DecisionCalibrationPlanModel {
  readonly model: DecisionCalibrationModel;
  /** false = sem credencial: a calibração pula este modelo. */
  readonly available: boolean;
  readonly estimatedTokens: number;
  readonly estimatedUsd: number;
  /** Quando a medição em vigor deste modelo foi feita; null = nunca medido (prior). */
  readonly measuredAt: number | null;
}

/** Medição com mais de 30 dias aparece como antiga na tela. */
export const DECISION_MEASUREMENT_STALE_MS = 30 * 24 * 60 * 60 * 1000;

export interface DecisionCalibrationPlan {
  readonly ok: boolean;
  readonly cases: number;
  readonly models: readonly DecisionCalibrationPlanModel[];
  /** Soma só dos modelos que vão rodar. */
  readonly estimatedUsd: number;
  /** A calibração só mede de fato no Automático (modos fixos anulam a rota explícita). */
  readonly runnable: boolean;
  readonly reason?: 'mode' | 'no-credential' | 'error';
}

export interface DecisionCalibrationModelResult {
  readonly model: DecisionCalibrationModel;
  readonly skipped: boolean;
  readonly answered: number;
  readonly failures: number;
  /** Acerto sobre os casos respondidos ou recusados (desenvolvimento + validação); null = sem medição. */
  readonly accuracy: number | null;
  readonly p95Ms: number | null;
  /** null = custo não medido em alguma resposta. */
  readonly usd: number | null;
  /** Data da medição em vigor depois da mescla (a de um pulado pode ser antiga); null = sem medição. */
  readonly measuredAt: number | null;
}

export type DecisionCalibrationResult =
  | { readonly ok: true; readonly written: boolean; readonly models: readonly DecisionCalibrationModelResult[] }
  | { readonly ok: false; readonly error: string; readonly cancelled?: true;
    /** Há uma calibração cancelada terminando a consulta em voo: a tela mostra "Cancelando…". */
    readonly cancelling?: true };

/** Resposta do pedido `{ cancel: true }`: havia calibração em curso para cancelar? */
export interface DecisionCalibrationCancelResult { readonly ok: true; readonly cancelRequested: boolean }

export interface DecisionMissionPanel {
  readonly ok: true;
  readonly missionId: string;
  readonly mode: 'auto' | 'jev' | 'clef' | 'luna' | 'together';
  readonly budgetUsd: number;
  /** O que o livro de orçamento cobrou desta missão (custo desconhecido pesa o estimado). */
  readonly chargedUsd: number;
  /** Reservado por consultas em voo (livro em memória). */
  readonly reservedUsd: number;
  readonly usd: number;
  readonly calls: number;
  readonly noAnswer: number;
  readonly budgetRefusals: number;
  /** (chargedUsd + reservedUsd) / budgetUsd, a mesma conta do livro; sem teto. */
  readonly ratio: number;
  readonly byProvider: Readonly<Record<string, { readonly calls: number; readonly noAnswer: number; readonly usd: number }>>;
  readonly hints: MissionDecisionHints | null;
}

export type DecisionMissionPanelResult = DecisionMissionPanel | { readonly ok: false; readonly reason: 'invalid' | 'not-found' | 'error' };
