import { ipcMain } from 'electron';
import { JEV_CHANNELS } from '../../shared/jev-channels';
import {
  JEV_ENV_VAR,
  jevDecisionFeedbackRequestSchema,
  jevDecisionsListRequestSchema,
  setJevKeyRequestSchema,
  type JevDecisionStatsResult,
  type JevStatus,
  type JevTestResult,
} from '../../shared/jev-ipc';
import {
  hasStoredJevApiKey,
  isJevSecretStorageAvailable,
  maskedJevApiKey,
  setJevApiKey,
} from './jev-secrets';
import { getJevStats, testJevConnection } from './jev-client';
import { isJevAutopilotEnabled } from './jev-autopilot';
import { getDecisionSettings } from '../decision-models/decision-availability';
import { jevModel } from '../decision-models/decision-routing';
import {
  jevDecisionBootCounts,
  jevDecisionStats,
  listJevDecisions,
  setJevDecisionFeedback,
} from './jev-decision-log';

/**
 * IPC do TypeSafe/Jev para a tela de Chaves de API. O handler de status usa
 * hasSecret apenas (nunca descriptografa no boot); `keyMasked` pode ler o
 * valor porque esta chamada é iniciada pelo usuário na tela de settings.
 */
export function registerJevIpc(): void {
  ipcMain.handle(JEV_CHANNELS.status, (): JevStatus => {
    const stats = getJevStats();
    return {
      hasStoredKey: hasStoredJevApiKey(),
      hasEnv: Boolean(process.env[JEV_ENV_VAR]?.trim()),
      keyMasked: maskedJevApiKey(),
      secureStorageAvailable: isJevSecretStorageAvailable(),
      autopilot: isJevAutopilotEnabled(),
      model: jevModel(getDecisionSettings()),
      stats: {
        calls: stats.calls,
        failures: stats.failures,
        inputTokens: stats.inputTokens,
        estimatedUsd: stats.estimatedUsd,
      },
      boot: jevDecisionBootCounts(),
    };
  });

  ipcMain.handle(
    JEV_CHANNELS.setKey,
    (_event, raw): { ok: boolean; error?: string } => {
      const parsed = setJevKeyRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid key request' };
      return setJevApiKey(parsed.data.key);
    },
  );

  ipcMain.handle(JEV_CHANNELS.test, async (): Promise<JevTestResult> => {
    return testJevConnection();
  });

  ipcMain.handle(JEV_CHANNELS.decisionsList, (_event, raw) => {
    const parsed = jevDecisionsListRequestSchema.safeParse(raw ?? {});
    if (!parsed.success) return [];
    return listJevDecisions(parsed.data);
  });

  ipcMain.handle(
    JEV_CHANNELS.decisionsFeedback,
    (_event, raw): { ok: boolean; error?: string } => {
      const parsed = jevDecisionFeedbackRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid feedback request' };
      return { ok: setJevDecisionFeedback(parsed.data.id, parsed.data.verdict) };
    },
  );

  ipcMain.handle(JEV_CHANNELS.decisionsStats, (): JevDecisionStatsResult => {
    return jevDecisionStats({ now: Date.now() });
  });
}
