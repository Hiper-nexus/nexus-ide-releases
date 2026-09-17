/**
 * Diário de decisões do Jev (learning loop): cada superfície que consulta o
 * modelo grava UMA linha JSONL com ids de perguntas, probabilidades e a
 * decisão tomada — NUNCA o state (texto sai para terceiro; aqui ficam só
 * números). O usuário marca certo/errado na tela e `jevDecisionStats`
 * transforma isso em sugestões de limiar/toggle (texto, nunca auto-aplicado).
 *
 * Fail-open: erro de fs vira console.warn e nada quebra.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { JevSurface } from './jev-autopilot';
import type { JevAnswer } from './jev-client';

export type JevDecisionSurface =
  | JevSurface
  | 'judgeTool'
  | 'rankTool'
  | 'browserTool'
  | 'computerTool';

export interface JevDecisionEntry {
  id: string;
  at: number;
  surface: JevDecisionSurface;
  sessionId?: string;
  missionId?: string;
  model: string;
  questions: string[];
  probabilities: Record<string, number>;
  confidence?: Record<string, number>;
  decision: string;
  inputTokens: number;
  usd: number;
  feedback?: 'right' | 'wrong';
  feedbackAt?: number;
}

export type JevDecisionInput = Omit<JevDecisionEntry, 'id' | 'at'>;

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LIST_LIMIT = 500;

let injectedDir: string | undefined;

/** Para testes: fixa o diretório do log; `undefined` volta ao userData. */
export function configureJevDecisionLog(dir?: string): void {
  injectedDir = dir;
}

function decisionsDir(): string {
  if (injectedDir) return injectedDir;
  // Require tardio: fora do Electron (vitest/tsx) `electron` não expõe `app`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as {
    app?: { getPath(name: 'userData'): string };
  };
  if (typeof electron?.app?.getPath !== 'function') {
    throw new Error('jev decision log requires configureJevDecisionLog(dir) outside Electron');
  }
  return path.join(electron.app.getPath('userData'), 'jev');
}

function logFile(dir?: string): string {
  return path.join(dir ?? decisionsDir(), 'decisions.jsonl');
}

function readEntries(file: string): JevDecisionEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries: JevDecisionEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as JevDecisionEntry;
      if (parsed && typeof parsed.id === 'string') entries.push(parsed);
    } catch {
      // linha truncada por rotação no meio da escrita — ignora
    }
  }
  return entries;
}

/** Append síncrono; engole erro de fs com warn (o diário nunca bloqueia). */
export function recordJevDecision(
  entry: JevDecisionInput,
  deps?: { dir?: string },
): string {
  const id = crypto.randomUUID();
  try {
    const file = logFile(deps?.dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) {
        fs.renameSync(file, file.replace('decisions.jsonl', 'decisions.1.jsonl'));
      }
    } catch {
      // arquivo ainda não existe — nada a rotacionar
    }
    const line: JevDecisionEntry = { ...entry, id, at: Date.now() };
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
  } catch (error) {
    console.warn('[jev] decision log write failed (ignored):', error);
  }
  return id;
}

export function listJevDecisions(opts?: {
  limit?: number;
  surface?: string;
  dir?: string;
}): JevDecisionEntry[] {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), MAX_LIST_LIMIT);
  let entries: JevDecisionEntry[];
  try {
    entries = readEntries(logFile(opts?.dir));
  } catch {
    return [];
  }
  const filtered = opts?.surface
    ? entries.filter((e) => e.surface === opts.surface)
    : entries;
  return filtered.slice(-limit).reverse();
}

export function setJevDecisionFeedback(
  id: string,
  verdict: 'right' | 'wrong',
  deps?: { dir?: string },
): boolean {
  try {
    const file = logFile(deps?.dir);
    const entries = readEntries(file);
    const index = entries.findIndex((e) => e.id === id);
    if (index < 0) return false;
    entries[index] = { ...entries[index], feedback: verdict, feedbackAt: Date.now() };
    const tmp = file + '.tmp';
    fs.writeFileSync(
      tmp,
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    console.warn('[jev] decision feedback failed (ignored):', error);
    return false;
  }
}

export interface JevDecisionStats {
  totals: { calls: number; usd: number; inputTokens: number };
  bySurface: Record<
    string,
    {
      calls: number;
      usd: number;
      decisions: Record<string, number>;
      feedback: { right: number; wrong: number };
      suggestion?: string;
    }
  >;
}

export function jevDecisionStats(deps?: { dir?: string }): JevDecisionStats {
  const stats: JevDecisionStats = {
    totals: { calls: 0, usd: 0, inputTokens: 0 },
    bySurface: {},
  };
  let entries: JevDecisionEntry[];
  try {
    entries = readEntries(logFile(deps?.dir));
  } catch {
    return stats;
  }
  for (const entry of entries) {
    stats.totals.calls += 1;
    stats.totals.usd += entry.usd;
    stats.totals.inputTokens += entry.inputTokens;
    const bucket = (stats.bySurface[entry.surface] ??= {
      calls: 0,
      usd: 0,
      decisions: {},
      feedback: { right: 0, wrong: 0 },
    });
    bucket.calls += 1;
    bucket.usd += entry.usd;
    bucket.decisions[entry.decision] = (bucket.decisions[entry.decision] ?? 0) + 1;
    if (entry.feedback === 'right') bucket.feedback.right += 1;
    if (entry.feedback === 'wrong') bucket.feedback.wrong += 1;
  }
  for (const bucket of Object.values(stats.bySurface)) {
    const total = bucket.feedback.right + bucket.feedback.wrong;
    if (total >= 10 && bucket.feedback.wrong / total >= 0.3) {
      bucket.suggestion =
        'Muitos erros nesta superfície: considere desligar ou revisar os limiares';
    } else if (total >= 10 && bucket.feedback.wrong / total <= 0.05) {
      bucket.suggestion = 'Estável: limiares podem ser relaxados';
    }
  }
  return stats;
}

/** Probabilidades normalizadas por tipo de resposta, para o diário. */
export function jevAnswerProbabilities(
  answers: Record<string, JevAnswer>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, a] of Object.entries(answers)) {
    if (a.type === 'noul') {
      out[id] = a.noul;
    } else if (a.type === 'choice') {
      out[id] = a.probabilities[a.choice] ?? 0;
    } else if (a.type === 'score') {
      const levels = Object.keys(a.legend).length;
      out[id] = levels > 1 ? a.score / (levels - 1) : a.score;
    }
  }
  return out;
}

/** Confiança por pergunta (choice/score trazem `confidence`). */
export function jevAnswerConfidences(
  answers: Record<string, JevAnswer>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, a] of Object.entries(answers)) {
    if ('confidence' in a && typeof a.confidence === 'number') {
      out[id] = a.confidence;
    }
  }
  return out;
}
