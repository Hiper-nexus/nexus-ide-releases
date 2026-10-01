/** Progresso salvo só no navegador. Nunca lança: armazenamento ausente, cheio
 * ou corrompido vira progresso novo. XP não tem relação com o sorteio.
 * A chave continua a da versão 1: quem já jogou mantém XP, racks e selos, e os
 * campos da versão 2 (combo, recorde do turno, missões) nascem zerados. */
import { levelFor, BADGES } from './tickets.js';

export const STORAGE_KEY = 'nexus-data-cafe:v1';
export const SCHEMA = 2;

export function initialProgress() {
  return { schema: SCHEMA, xp: 0, level: 1, badges: [], racksOn: [], completed: 0, incidents: 0, bestCombo: 0, bestShift: 0, missions: 0 };
}

const count = value => (Number.isInteger(value) && value > 0 ? value : 0);

export function normalizeProgress(raw) {
  const base = initialProgress();
  if (!raw || typeof raw !== 'object') return base;
  const xp = count(raw.xp);
  return {
    ...base,
    xp,
    level: levelFor(xp),
    badges: Array.isArray(raw.badges) ? [...new Set(raw.badges.filter(badge => badge in BADGES))] : [],
    racksOn: Array.isArray(raw.racksOn) ? [...new Set(raw.racksOn.filter(id => typeof id === 'string'))] : [],
    completed: count(raw.completed),
    incidents: count(raw.incidents),
    bestCombo: count(raw.bestCombo),
    bestShift: count(raw.bestShift),
    missions: count(raw.missions),
  };
}

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadProgress(storage = defaultStorage()) {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    return text ? normalizeProgress(JSON.parse(text)) : initialProgress();
  } catch {
    return initialProgress();
  }
}

/** Devolve true quando gravou. */
export function saveProgress(progress, storage = defaultStorage()) {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify(normalizeProgress(progress)));
    return true;
  } catch {
    return false;
  }
}

export function clearProgress(storage = defaultStorage()) {
  try { storage?.removeItem(STORAGE_KEY); return true; } catch { return false; }
}
