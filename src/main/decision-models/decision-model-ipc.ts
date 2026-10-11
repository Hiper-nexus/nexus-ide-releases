import { DECISION_MODEL_CHANNELS } from '../../shared/decision-model-channels';
import { decisionSettingsSchema, setDecisionKeyRequestSchema, testDecisionModelRequestSchema, type DecisionModelStatus, type DecisionSettings } from '../../shared/decision-models';
import { getOrchSettings } from '../persistence/settings-store';
import { handleTrusted } from '../security/trusted-ipc';
import { hasClefEnvToken, hasStoredClefApiToken, isClefSecretStorageAvailable, maskedClefApiToken, resolveCloudflareAccountId, resolveClefApiToken, setClefApiToken } from './clef-secrets';
import { testClefConnection } from './clef-client';
import { testLunaConnection } from './luna-client';
import { hasLunaCredential, resolveLunaApiKey } from './luna-credentials';
import { hasJevCredential } from '../jev/jev-secrets';
import { jevMissionUsage, type JevMissionStats } from '../jev/jev-decision-log';
import { getDecisionBudgetLedger } from './decision-budget';
import { readDecisionQualityTable, type DecisionQualityTable } from './decision-quality';
import { getMissionDecisionHints } from '../orch/mission-decision-hints';
import { missionReviewSchema } from '../../shared/mission-engine-contract';
import {
  calibrateDecisionModelsRequestSchema, calibrationPlanRequestSchema, decisionMissionPanelRequestSchema,
  type DecisionCalibrationCancelResult, type DecisionCalibrationPlan, type DecisionCalibrationResult, type DecisionMissionPanelResult,
} from '../../shared/decision-engine-ui';
import { DECISION_CALIBRATION_CASES } from './decision-calibration-cases';
import { calibrateDecisionQuality, calibrationModelsAvailable, estimateCalibration, summarizeCalibration } from './decision-calibration';
import { getDecisionAvailability, getDecisionSettings } from './decision-availability';
import type { DecisionAvailability } from './decision-routing';
import { buildDecisionMissionPanel } from './decision-mission-panel';
import type { IpcMainInvokeEvent } from 'electron';

interface DecisionModelIpcDeps {
  getSettings: () => DecisionSettings;
  hasStoredKey: () => boolean;
  hasEnv: () => boolean;
  keyMasked: () => string | null;
  secureStorageAvailable: () => boolean;
  hasJev: () => boolean;
  hasLuna: () => boolean;
  setKey: typeof setClefApiToken;
  resolveToken: typeof resolveClefApiToken;
  resolveLunaKey: typeof resolveLunaApiKey;
  testConnection: typeof testClefConnection;
  testLuna: typeof testLunaConnection;
  /** F-1167: configuração efetiva da conta e credenciais presentes (para pular quem não tem). */
  decisionSettings: () => DecisionSettings;
  availability: (settings: DecisionSettings) => DecisionAvailability;
  calibrate: typeof calibrateDecisionQuality;
  /** A missão pertence ao workspace do renderer que pergunta? Lança se o renderer não tem escopo. */
  missionInScope: (event: IpcMainInvokeEvent, missionId: string) => Promise<boolean>;
  /** Agregado assíncrono do diário por missão (cache por mtime+tamanho). */
  missionUsage: (missionId: string) => Promise<JevMissionStats | undefined>;
  /** Livro de orçamento em memória, aquecido sem bloquear. */
  budgetBook: (missionId: string, budgetUsd: number) => Promise<{ spentUsd: number; reservedUsd: number }>;
  missionHints: typeof getMissionDecisionHints;
  /** Tabela de qualidade atual (data das medições em vigor). */
  qualityTable: () => DecisionQualityTable | null;
}

async function defaultBudgetBook(missionId: string, budgetUsd: number): Promise<{ spentUsd: number; reservedUsd: number }> {
  const ledger = getDecisionBudgetLedger();
  await ledger.warm();
  const snapshot = ledger.snapshot(missionId, budgetUsd);
  return { spentUsd: snapshot.spentUsd, reservedUsd: snapshot.reservedUsd };
}

async function defaultMissionInScope(event: IpcMainInvokeEvent, missionId: string): Promise<boolean> {
  // Mesmo padrão do missionSnapshot: o escopo vem do estado vivo do Main, nunca do renderer.
  const { requireLiveRendererWorkspaceScope } = await import('../persistence/renderer-workspace-scope');
  const { getProjectDomainStores } = await import('../orch/project-domain-store-registry');
  const scope = requireLiveRendererWorkspaceScope(event.sender);
  return Boolean(getProjectDomainStores(scope).missions.get(missionId));
}

const defaultDeps: DecisionModelIpcDeps = {
  getSettings: () => getOrchSettings().decisionModels ?? decisionSettingsSchema.parse({}),
  hasStoredKey: hasStoredClefApiToken,
  hasEnv: hasClefEnvToken,
  keyMasked: maskedClefApiToken,
  secureStorageAvailable: isClefSecretStorageAvailable,
  hasJev: hasJevCredential,
  hasLuna: hasLunaCredential,
  setKey: setClefApiToken,
  resolveToken: resolveClefApiToken,
  resolveLunaKey: resolveLunaApiKey,
  testConnection: testClefConnection,
  testLuna: testLunaConnection,
  decisionSettings: getDecisionSettings,
  availability: getDecisionAvailability,
  calibrate: calibrateDecisionQuality,
  missionInScope: defaultMissionInScope,
  missionUsage: missionId => jevMissionUsage(missionId),
  budgetBook: defaultBudgetBook,
  missionHints: getMissionDecisionHints,
  qualityTable: readDecisionQualityTable,
};

const canonicalMissionId = missionReviewSchema.shape.missionId;

function calibrationPlan(deps: DecisionModelIpcDeps): DecisionCalibrationPlan {
  try {
    const settings = deps.decisionSettings();
    const available = calibrationModelsAvailable(deps.availability(settings));
    let current: DecisionQualityTable | null = null;
    try { current = deps.qualityTable(); } catch { current = null; }
    const models = estimateCalibration(DECISION_CALIBRATION_CASES, available, current);
    const estimatedUsd = models.reduce((sum, row) => sum + (row.available ? row.estimatedUsd : 0), 0);
    const reason = settings.mode !== 'auto' ? 'mode' as const : available.length === 0 ? 'no-credential' as const : undefined;
    return { ok: true, cases: DECISION_CALIBRATION_CASES.length, models, estimatedUsd, runnable: !reason,
      ...(reason ? { reason } : {}) };
  } catch {
    return { ok: false, cases: DECISION_CALIBRATION_CASES.length, models: [], estimatedUsd: 0, runnable: false, reason: 'error' };
  }
}

/**
 * F-1167: calibração e painel da missão. Calibrar só com `{ confirm: true }`
 * (clique do operador), uma por vez, só no Automático, só nos modelos com
 * credencial; `{ cancel: true }` no mesmo canal aborta a que está rodando.
 * Nada aqui lança para o renderer: erro vira resultado.
 */
function registerMissionEngineIpc(deps: DecisionModelIpcDeps): void {
  let running: AbortController | null = null;
  handleTrusted(DECISION_MODEL_CHANNELS.calibrationPlan, (_event, raw): DecisionCalibrationPlan => {
    if (!calibrationPlanRequestSchema.safeParse(raw).success) {
      return { ok: false, cases: 0, models: [], estimatedUsd: 0, runnable: false, reason: 'error' };
    }
    return calibrationPlan(deps);
  });
  handleTrusted(DECISION_MODEL_CHANNELS.calibrate, async (_event, raw): Promise<DecisionCalibrationResult | DecisionCalibrationCancelResult> => {
    const request = calibrateDecisionModelsRequestSchema.safeParse(raw);
    if (!request.success) return { ok: false, error: 'Pedido de calibração inválido.' };
    if ('cancel' in request.data) {
      const current = running;
      current?.abort();
      return { ok: true, cancelRequested: current !== null };
    }
    // Cancelada mas ainda terminando a consulta em voo: não é erro, é "Cancelando…".
    if (running?.signal.aborted) return { ok: false, cancelling: true, error: 'Cancelando a calibração anterior…' };
    if (running) return { ok: false, error: 'A calibração já está rodando.' };
    const controller = new AbortController();
    running = controller;
    try {
      const plan = calibrationPlan(deps);
      if (plan.reason === 'mode') return { ok: false, error: 'A calibração só roda no modo Automático.' };
      if (plan.reason === 'no-credential') return { ok: false, error: 'Nenhum modelo com credencial para calibrar.' };
      if (!plan.ok) return { ok: false, error: 'Não consegui preparar a calibração.' };
      const consulted = plan.models.filter(row => row.available).map(row => row.model);
      const result = await deps.calibrate(DECISION_CALIBRATION_CASES, { models: consulted, signal: controller.signal });
      if (result.aborted || controller.signal.aborted) {
        return { ok: false, cancelled: true, error: 'Calibração cancelada. As medições anteriores continuam valendo.' };
      }
      if (!result.ok || !result.report) return { ok: false, error: 'Os casos de calibração são inválidos.' };
      return { ok: true, written: result.written, models: summarizeCalibration(result.report, consulted, result.table ?? null) };
    } catch {
      return { ok: false, error: 'A calibração falhou. Nada foi alterado.' };
    } finally {
      if (running === controller) running = null;
    }
  });
  handleTrusted(DECISION_MODEL_CHANNELS.missionPanel, async (event, raw): Promise<DecisionMissionPanelResult> => {
    const request = decisionMissionPanelRequestSchema.safeParse(raw);
    const missionId = request.success ? canonicalMissionId.safeParse(request.data.missionId) : null;
    if (!missionId?.success) return { ok: false, reason: 'invalid' };
    try {
      // Missão de outro workspace (ou inexistente) responde igual: não vaza existência.
      if (!(await deps.missionInScope(event, missionId.data))) return { ok: false, reason: 'not-found' };
    } catch {
      return { ok: false, reason: 'not-found' };
    }
    return buildDecisionMissionPanel(missionId.data, {
      settings: deps.decisionSettings, missionUsage: deps.missionUsage, budgetBook: deps.budgetBook, hints: deps.missionHints,
    });
  });
}

function registerConnectionTest(deps: DecisionModelIpcDeps): void {
  handleTrusted(DECISION_MODEL_CHANNELS.test, async (_event, raw) => {
    const parsed = testDecisionModelRequestSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, detail: 'Modelo de decisão inválido.' };
    if (parsed.data.provider === 'luna') {
      const token = deps.resolveLunaKey();
      if (!token) return { ok: false, detail: 'Configure a chave OpenAI em Chaves de API. A Luna (beta) usa essa chave na Decisions API.' };
      return deps.testLuna(token);
    }
    const settings = deps.getSettings();
    const accountId = resolveCloudflareAccountId(settings.cloudflareAccountId);
    const token = deps.resolveToken();
    if (!accountId || !token) return { ok: false, detail: 'Configure o Account ID e o API Token da Cloudflare.' };
    return deps.testConnection({ accountId, token, model: parsed.data.model ?? settings.clefModel });
  });
}

export function registerDecisionModelIpc(overrides: Partial<DecisionModelIpcDeps> = {}): void {
  const deps = { ...defaultDeps, ...overrides };
  handleTrusted(DECISION_MODEL_CHANNELS.status, (): DecisionModelStatus => {
    const settings = deps.getSettings();
    const accountId = resolveCloudflareAccountId(settings.cloudflareAccountId) ?? '';
    const hasStoredKey = deps.hasStoredKey();
    const hasEnv = deps.hasEnv();
    return { settings, accountId, hasStoredKey, hasEnv, keyMasked: deps.keyMasked(),
      secureStorageAvailable: deps.secureStorageAvailable(),
      accountIdSource: !accountId ? 'missing' : settings.cloudflareAccountId ? 'settings' : 'env',
      isReady: Boolean(accountId && (hasStoredKey || hasEnv)),
      jevReady: deps.hasJev(),
      lunaReady: deps.hasLuna(),
    };
  });
  handleTrusted(DECISION_MODEL_CHANNELS.setKey, (_event, raw) => {
    const parsed = setDecisionKeyRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'Token Cloudflare inválido.' };
    return deps.setKey(parsed.data.token);
  });
  registerConnectionTest(deps);
  registerMissionEngineIpc(deps);
}
