import path from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import {
  MEDIA_BUDGET_CHANNELS,
  type MediaBudgetSetResult,
  type MediaBudgetStateView,
} from '../../shared/media-budget-types';
import { handleTrusted } from '../security/trusted-ipc';
import { configureMediaBudget, MEDIA_BUDGET_MAX_USD, MediaBudget } from './media-budget';

/**
 * Teto de gasto de mídia (F-1606): o livro-razão do app inteiro em
 * `<userData>/media/media-spend.json`, e os limites que só a janela principal
 * (handleTrusted) grava. Nenhuma ferramenta MCP mexe no teto.
 */

const limit = z.number().finite().min(0).max(MEDIA_BUDGET_MAX_USD).nullable();
const setSchema = z.object({ perMissionUsd: limit, perDayUsd: limit }).strict();

export function registerMediaBudgetIpc(): MediaBudget {
  const budget = new MediaBudget(path.join(app.getPath('userData'), 'media'));
  configureMediaBudget(budget);

  handleTrusted(MEDIA_BUDGET_CHANNELS.get, (): MediaBudgetStateView => budget.view());

  handleTrusted(MEDIA_BUDGET_CHANNELS.set, (_event, raw): MediaBudgetSetResult => {
    const parsed = setSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: `Use valores de US$ 0 a US$ ${MEDIA_BUDGET_MAX_USD.toLocaleString('pt-BR')}, ou deixe em branco para sem teto.` };
    }
    budget.setLimits(parsed.data);
    return { ok: true, ...budget.view() };
  });
  return budget;
}
