import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudio, MUTE_KEY } from './audio.js';

function fakeContext() {
  const log = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime(v) { this.value = v; } });
  const node = kind => ({ kind, gain: param(), frequency: param(), Q: param(), connect() {}, start() { log.push(`start:${kind}`); }, stop() {} });
  return {
    log, currentTime: 0, sampleRate: 8000, destination: node('destination'), state: 'suspended',
    createGain: () => node('gain'), createOscillator: () => node('oscillator'), createBufferSource: () => node('source'),
    createBiquadFilter: () => node('filter'),
    createBuffer: (channels, length) => ({ getChannelData: () => new Float32Array(length) }),
    resume() { this.state = 'running'; log.push('resume'); }, suspend() {}, close() { log.push('close'); },
  };
}

function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data };
}

test('sem gesto nada toca, e sem AudioContext tudo é silêncio sem erro', () => {
  const ctx = fakeContext();
  const audio = createAudio({ context: ctx, storage: memoryStorage() });
  audio.success(); audio.footstep();
  assert.equal(ctx.log.length, 0);
  const silent = createAudio({ storage: null, createContext: () => null });
  assert.equal(silent.unlock(), false);
  silent.success(); silent.coffee(); silent.fan(1); silent.dispose();
});

test('depois do gesto os efeitos agendam osciladores e ruído', () => {
  const ctx = fakeContext();
  const audio = createAudio({ context: ctx, storage: memoryStorage() });
  assert.equal(audio.unlock(), true);
  assert.equal(ctx.state, 'running');
  audio.success();
  assert.equal(ctx.log.filter(entry => entry === 'start:oscillator').length, 4, 'arpejo de quatro notas');
  audio.footstep();
  assert.ok(ctx.log.includes('start:source'));
  audio.fan(0.5);
  audio.fan(1);
  assert.equal(ctx.log.filter(entry => entry === 'start:source').length, 2, 'uma única fonte contínua de ventoinha');
});

test('mudo silencia, persiste e é lido na próxima visita', () => {
  const storage = memoryStorage();
  const ctx = fakeContext();
  const audio = createAudio({ context: ctx, storage });
  audio.unlock();
  audio.setMuted(true);
  assert.equal(storage.data.get(MUTE_KEY), '1');
  const before = ctx.log.length;
  audio.alert(); audio.coffee();
  assert.equal(ctx.log.length, before, 'nenhum efeito tocou');
  assert.equal(createAudio({ context: fakeContext(), storage }).isMuted(), true);
});

test('dispose só fecha o contexto que o próprio módulo criou', () => {
  const injected = fakeContext();
  const audio = createAudio({ context: injected, storage: null });
  audio.unlock(); audio.dispose();
  assert.equal(injected.log.includes('close'), false);
  const owned = fakeContext();
  const mine = createAudio({ storage: null, createContext: () => owned });
  mine.unlock(); mine.dispose();
  assert.equal(owned.log.includes('close'), true);
});

test('depois do dispose o unlock não recria o contexto', () => {
  let created = 0;
  const audio = createAudio({ storage: null, createContext: () => { created++; return fakeContext(); } });
  audio.unlock(); audio.dispose();
  assert.equal(audio.unlock(), false);
  assert.equal(created, 1);
});
