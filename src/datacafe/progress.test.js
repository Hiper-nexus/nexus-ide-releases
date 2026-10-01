import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProgress, saveProgress, clearProgress, initialProgress, normalizeProgress, STORAGE_KEY } from './progress.js';

function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key), data };
}

test('salva e carrega o progresso, recalculando o nível pelo XP', () => {
  const storage = memoryStorage();
  assert.equal(saveProgress({ ...initialProgress(), xp: 420, level: 1, racksOn: ['claude', 'claude', 'codex'], badges: ['primeira-gpu', 'inventado'] }, storage), true);
  const loaded = loadProgress(storage);
  assert.equal(loaded.level, 3);
  assert.deepEqual(loaded.racksOn, ['claude', 'codex']);
  assert.deepEqual(loaded.badges, ['primeira-gpu']);
});

test('nunca lança: sem storage, JSON inválido, cota cheia ou acesso bloqueado', () => {
  assert.deepEqual(loadProgress(null), initialProgress());
  const broken = memoryStorage();
  broken.data.set(STORAGE_KEY, '{nope');
  assert.deepEqual(loadProgress(broken), initialProgress());
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => { throw new Error('bloqueado'); } };
  assert.equal(saveProgress(initialProgress(), full), false);
  assert.equal(clearProgress(full), false);
  const hostile = { getItem: () => { throw new Error('SecurityError'); } };
  assert.deepEqual(loadProgress(hostile), initialProgress());
});

test('campos ausentes ou estranhos viram valores seguros', () => {
  const normalized = normalizeProgress({ xp: -3, completed: 2.5, incidents: '4', racksOn: 'claude' });
  assert.equal(normalized.xp, 0);
  assert.equal(normalized.completed, 0);
  assert.equal(normalized.incidents, 0);
  assert.deepEqual(normalized.racksOn, []);
});

test('progresso salvo na versão 1 migra sem perder nada e ganha os campos novos zerados', () => {
  const storage = memoryStorage();
  storage.data.set(STORAGE_KEY, JSON.stringify({ schema: 1, xp: 950, level: 4, badges: ['primeira-gpu'], racksOn: ['claude', 'codex'], completed: 14, incidents: 3 }));
  const loaded = loadProgress(storage);
  assert.deepEqual([loaded.xp, loaded.level, loaded.completed, loaded.incidents], [950, 4, 14, 3]);
  assert.deepEqual(loaded.racksOn, ['claude', 'codex']);
  assert.deepEqual(loaded.badges, ['primeira-gpu']);
  assert.deepEqual([loaded.bestCombo, loaded.bestShift, loaded.missions], [0, 0, 0]);
  assert.equal(loaded.schema, 2);
});

test('recorde do turno, melhor combo e missões fechadas vão e voltam do armazenamento', () => {
  const storage = memoryStorage();
  saveProgress({ ...initialProgress(), bestCombo: 4, bestShift: 620, missions: 7 }, storage);
  const loaded = loadProgress(storage);
  assert.deepEqual([loaded.bestCombo, loaded.bestShift, loaded.missions], [4, 620, 7]);
});
