import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudio, MUTE_KEY, VOLUME_KEY, DEFAULT_VOLUME } from './audio.js';

function fakeContext() {
  const log = [];
  const peaks = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime(value) { peaks.push(value); }, exponentialRampToValueAtTime() {}, setTargetAtTime(v) { this.value = v; } });
  const gains = [];
  const node = kind => ({ kind, gain: param(), frequency: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), connect(target) { log.push(`connect:${kind}>${target.kind}`); }, start() { log.push(`start:${kind}`); }, stop() {} });
  return {
    log, peaks, gains, currentTime: 0, sampleRate: 8000, destination: node('destination'), state: 'suspended',
    createGain: () => { const gain = node('gain'); gains.push(gain); return gain; }, createOscillator: () => node('oscillator'), createBufferSource: () => node('source'),
    createBiquadFilter: () => node('filter'), createDynamicsCompressor: () => node('limiter'),
    createBuffer: (channels, length) => ({ getChannelData: () => new Float32Array(length) }),
    resume() { this.state = 'running'; log.push('resume'); }, suspend() { this.state = 'suspended'; }, close() { log.push('close'); },
  };
}

/** Relógio falso: guarda o callback do intervalo para o teste disparar a trilha à mão. */
function fakeTimers() {
  const timers = { callback: null, cleared: false, setInterval(callback) { timers.callback = callback; return 1; }, clearInterval() { timers.cleared = true; } };
  return timers;
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

test('os efeitos chegam audíveis: o jogo saía a uns -40 dBFS e ninguém ouvia', () => {
  const ctx = fakeContext();
  const audio = createAudio({ context: ctx, storage: memoryStorage(), timers: fakeTimers() });
  audio.unlock();
  const master = ctx.gains[0];
  assert.ok(master.gain.value >= 0.5, `volume mestre ${master.gain.value}`);
  assert.ok(ctx.log.includes('connect:gain>limiter') && ctx.log.includes('connect:limiter>destination'), 'o mestre passa por um limitador');
  for (const effect of ['footstep', 'pickup', 'coffee', 'alert', 'success', 'typing', 'sit', 'stand', 'levelUp', 'mission', 'denied', 'shiftEnd']) {
    ctx.peaks.length = 0;
    audio[effect]();
    const loudest = Math.max(...ctx.peaks) * master.gain.value;
    assert.ok(loudest >= 0.1, `${effect} chega a ${loudest.toFixed(3)} de pico; abaixo de 0.1 some em alto-falante de notebook`);
  }
  ctx.peaks.length = 0;
  audio.combo(4);
  assert.ok(Math.max(...ctx.peaks) * master.gain.value >= 0.1);
});

test('volume ajustável: limita entre 0 e 1, persiste e volta na próxima visita', () => {
  const storage = memoryStorage();
  const ctx = fakeContext();
  const audio = createAudio({ context: ctx, storage, timers: fakeTimers() });
  assert.equal(audio.getVolume(), DEFAULT_VOLUME);
  audio.unlock();
  assert.equal(audio.setVolume(0.3), 0.3);
  assert.equal(ctx.gains[0].gain.value, 0.3);
  assert.equal(audio.setVolume(7), 1);
  assert.equal(audio.setVolume(-1), 0);
  audio.setVolume(0.45);
  assert.equal(storage.data.get(VOLUME_KEY), '0.45');
  assert.equal(createAudio({ context: fakeContext(), storage, timers: fakeTimers() }).getVolume(), 0.45);
  storage.data.set(VOLUME_KEY, 'lixo');
  assert.equal(createAudio({ context: fakeContext(), storage, timers: fakeTimers() }).getVolume(), DEFAULT_VOLUME);
});

test('a trilha só agenda notas com o som ligado e o contexto rodando, e para no dispose', () => {
  const ctx = fakeContext();
  const timers = fakeTimers();
  const audio = createAudio({ context: ctx, storage: memoryStorage(), timers });
  timers.callback?.();
  assert.equal(ctx.log.filter(entry => entry === 'start:oscillator').length, 0, 'antes do gesto não há trilha');
  audio.unlock();
  timers.callback();
  const scheduled = ctx.log.filter(entry => entry === 'start:oscillator').length;
  assert.ok(scheduled >= 1, 'a trilha agenda à frente do relógio');
  timers.callback();
  assert.equal(ctx.log.filter(entry => entry === 'start:oscillator').length, scheduled, 'sem o relógio andar não agenda de novo');
  audio.setMuted(true);
  ctx.currentTime = 30;
  timers.callback();
  assert.equal(ctx.log.filter(entry => entry === 'start:oscillator').length, scheduled, 'mudo não agenda');
  audio.setMuted(false);
  audio.suspend();
  timers.callback();
  assert.equal(ctx.log.filter(entry => entry === 'start:oscillator').length, scheduled, 'pausado não agenda');
  audio.dispose();
  assert.equal(timers.cleared, true);
});

test('pausado, mexer no som não acorda o áudio: só o resume do jogo acorda', () => {
  const ctx = fakeContext();
  const timers = fakeTimers();
  const audio = createAudio({ context: ctx, storage: memoryStorage(), timers });
  audio.unlock();
  audio.suspend();
  assert.equal(ctx.state, 'suspended');
  const resumes = () => ctx.log.filter(entry => entry === 'resume').length;
  const before = resumes();
  audio.unlock(); audio.setVolume(0.2); audio.setMuted(true); audio.setMuted(false);
  assert.equal(resumes(), before, 'unlock, volume e mudo não chamam resume durante a pausa');
  assert.equal(ctx.state, 'suspended');
  ctx.state = 'running';
  const scheduled = ctx.log.filter(entry => entry === 'start:oscillator').length;
  ctx.currentTime = 50;
  timers.callback();
  assert.equal(ctx.log.filter(entry => entry === 'start:oscillator').length, scheduled, 'a trilha não agenda com o jogo pausado, mesmo se o contexto acordar');
  audio.resume();
  assert.equal(resumes(), before + 1);
  timers.callback();
  assert.ok(ctx.log.filter(entry => entry === 'start:oscillator').length > scheduled);
});

test('volume zero vale como mudo para a trilha', () => {
  const ctx = fakeContext();
  const timers = fakeTimers();
  const audio = createAudio({ context: ctx, storage: memoryStorage(), timers });
  audio.unlock();
  audio.setVolume(0);
  timers.callback();
  assert.equal(ctx.log.filter(entry => entry === 'start:oscillator').length, 0);
});
