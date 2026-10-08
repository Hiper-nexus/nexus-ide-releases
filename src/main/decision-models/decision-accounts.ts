import fs from 'node:fs';
import path from 'node:path';
import { decisionSettingsSchema, type DecisionSettings } from '../../shared/decision-models';
import { writeJsonFileAtomic } from '../persistence/atomic-json-file';

/**
 * Preferência de julgamento por conta autenticada. Um pane ou uma missão não
 * grava isto: só a tela de Modelos de decisão, na conta que está logada.
 * Conta sem linha própria não recebe a escolha de outra.
 */
export interface DecisionAccountBook {
  formatVersion: 1;
  byAccount: Record<string, DecisionSettings>;
}

export const EMPTY_DECISION_ACCOUNT_BOOK: DecisionAccountBook = { formatVersion: 1, byAccount: {} };

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function decisionAccountBookFile(settingsFile: string): string {
  return path.join(path.dirname(settingsFile), 'decision-accounts.json');
}

export function acceptDecisionAccountId(value: string | null | undefined): string | null {
  const id = value?.trim() ?? '';
  return ACCOUNT_ID.test(id) ? id : null;
}

function parseSettings(raw: unknown): DecisionSettings | null {
  const parsed = decisionSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseDecisionAccountBook(raw: unknown): DecisionAccountBook {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_DECISION_ACCOUNT_BOOK;
  const byAccount: Record<string, DecisionSettings> = {};
  const source = (raw as { byAccount?: unknown }).byAccount;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [id, value] of Object.entries(source)) {
      const accountId = acceptDecisionAccountId(id);
      const settings = parseSettings(value);
      if (accountId && settings) byAccount[accountId] = settings;
    }
  }
  return { formatVersion: 1, byAccount };
}

/**
 * Conta com linha própria usa só essa linha. Livro vazio ainda não foi
 * reivindicado: a projeção legada (um operador nesta máquina) vale para quem
 * salvar primeiro. Livro com outras contas e sem esta: padrão Jev, nunca a
 * escolha do vizinho.
 */
export function resolveAccountSettings(
  book: DecisionAccountBook,
  accountId: string,
  projection: DecisionSettings,
): DecisionSettings {
  const own = book.byAccount[accountId];
  if (own) return own;
  if (Object.keys(book.byAccount).length === 0) return projection;
  return decisionSettingsSchema.parse({});
}

export function withAccountSettings(
  book: DecisionAccountBook,
  accountId: string,
  settings: DecisionSettings,
): DecisionAccountBook {
  return { formatVersion: 1, byAccount: { ...book.byAccount, [accountId]: settings } };
}

/**
 * Troca de conta. Logout volta ao padrão Jev sem apagar o livro. Login com
 * livro vazio reivindica a projeção legada uma vez. Conta sem linha, com
 * outras já gravadas, recebe o padrão — nunca a escolha do vizinho.
 */
export function accountSwitchProjection(
  book: DecisionAccountBook,
  accountId: string | null,
  projection: DecisionSettings,
): { settings: DecisionSettings; book: DecisionAccountBook } {
  const id = acceptDecisionAccountId(accountId);
  if (!id) return { settings: decisionSettingsSchema.parse({}), book };
  const own = book.byAccount[id];
  if (own) return { settings: own, book };
  if (Object.keys(book.byAccount).length === 0) {
    return { settings: projection, book: withAccountSettings(book, id, projection) };
  }
  return { settings: decisionSettingsSchema.parse({}), book };
}

/** Conta autenticada, ou null fora do login. Não lê o livro. */
export function currentDecisionAccountId(): string | null {
  try {
    const { getAuthenticatedAccountId } = require('../auth-client') as typeof import('../auth-client');
    return acceptDecisionAccountId(getAuthenticatedAccountId());
  } catch {
    return null;
  }
}

export function readDecisionAccountBook(file: string): DecisionAccountBook {
  try {
    return parseDecisionAccountBook(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return EMPTY_DECISION_ACCOUNT_BOOK;
  }
}

export function writeDecisionAccountBook(file: string, book: DecisionAccountBook): void {
  writeJsonFileAtomic(file, book);
}

let onAccount: ((accountId: string | null) => void) | null = null;

/** O store de settings registra isto no boot. Sem registro, o aviso é no-op. */
export function onDecisionAccountChanged(listener: (accountId: string | null) => void): void {
  onAccount = listener;
}

export function notifyDecisionAccount(accountId: string | null): void {
  const id = accountId === null ? null : acceptDecisionAccountId(accountId);
  try { onAccount?.(id); }
  catch { /* a troca de conta não pode derrubar o login */ }
}
