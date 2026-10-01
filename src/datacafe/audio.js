/** Som do Data Café, 100% sintetizado com WebAudio: sem nenhum arquivo.
 * Só liga depois de um gesto do jogador (regra de autoplay dos navegadores).
 * Sem AudioContext (Node, navegador antigo, bloqueio) tudo vira silêncio. */
export const MUTE_KEY = 'nexus-data-cafe:muted';
export const VOLUME_KEY = 'nexus-data-cafe:volume';
/** Com o mestre em 0.18 e efeitos de pico 0.05 a 0.12 o jogo saía a uns -40 dBFS
 * (medido no navegador) e ninguém ouvia. O mestre agora é o volume do jogador e
 * um limitador segura a soma dos efeitos. */
export const DEFAULT_VOLUME = 0.8;
const MUSIC = {
  /** Segundos por nota de um arpejo lento: lá menor, sol, fá, mi menor. */
  step: 0.42,
  notes: [220, 261.63, 329.63, 261.63, 196, 246.94, 293.66, 246.94, 174.61, 220, 261.63, 220, 164.81, 196, 246.94, 196],
  /** Baixa de propósito: a trilha fica uns 12 dB abaixo dos efeitos. */
  peak: 0.04,
  bass: 0.05,
  /** Quanto à frente do relógio a trilha agenda a cada passada do intervalo. */
  horizon: 0.6,
  interval: 200,
};

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function defaultContext() {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Context ? new Context() : null;
}

const clamp01 = value => Math.max(0, Math.min(1, value));

export function createAudio({ context = null, storage = defaultStorage(), createContext = defaultContext, timers = globalThis } = {}) {
  let ctx = context;
  const ownsContext = !context;
  let master = null, noise = null, fanGain = null, fanSource = null;
  let muted = false;
  let volume = DEFAULT_VOLUME;
  let disposed = false;
  /** O jogo pausou ou saiu da tela: só `resume()` acorda o áudio de novo. */
  let held = false;
  let musicTimer = null, nextNote = 0, noteIndex = 0;
  try {
    muted = storage?.getItem(MUTE_KEY) === '1';
    const saved = Number.parseFloat(storage?.getItem(VOLUME_KEY));
    if (Number.isFinite(saved)) volume = clamp01(saved);
  } catch { muted = false; }

  function ready() {
    return Boolean(ctx && master) && !muted && volume > 0;
  }

  function envelope(gain, peak, attack, release) {
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
    return t + attack + release;
  }

  function noiseBurst({ type = 'bandpass', frequency = 800, q = 1, peak = 0.2, attack = 0.005, release = 0.07, delay = 0 }) {
    const source = ctx.createBufferSource();
    source.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const gain = ctx.createGain();
    const end = envelope(gain, peak, attack, release);
    source.connect(filter); filter.connect(gain); gain.connect(master);
    source.start(ctx.currentTime + delay, Math.random() * 0.5);
    source.stop(end + delay + 0.02);
  }

  function tone({ type = 'sine', frequency, to = null, peak = 0.1, attack = 0.005, release = 0.12, delay = 0 }) {
    const oscillator = ctx.createOscillator();
    oscillator.type = type;
    const t = ctx.currentTime + delay;
    oscillator.frequency.setValueAtTime(frequency, t);
    if (to) oscillator.frequency.exponentialRampToValueAtTime(to, t + attack + release);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
    oscillator.connect(gain); gain.connect(master);
    oscillator.start(t);
    oscillator.stop(t + attack + release + 0.02);
  }

  function ensureFan() {
    if (fanSource) return;
    fanSource = ctx.createBufferSource();
    fanSource.buffer = noise;
    fanSource.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    fanGain = ctx.createGain();
    fanGain.gain.value = 0;
    fanSource.connect(filter); filter.connect(fanGain); fanGain.connect(master);
    fanSource.start();
  }

  /** Agenda as próximas notas da trilha. Mudo, pausado ou sem gesto não agenda nada. */
  function scheduleMusic() {
    if (!ready() || held || ctx.state === 'suspended') return;
    const now = ctx.currentTime;
    if (nextNote < now) nextNote = now + 0.05;
    while (nextNote < now + MUSIC.horizon) {
      const frequency = MUSIC.notes[noteIndex % MUSIC.notes.length];
      tone({ type: 'triangle', frequency, peak: MUSIC.peak, attack: 0.03, release: 0.55, delay: nextNote - now });
      if (noteIndex % 4 === 0) tone({ frequency: frequency / 2, peak: MUSIC.bass, attack: 0.05, release: 1.4, delay: nextNote - now });
      noteIndex += 1;
      nextNote += MUSIC.step;
    }
  }

  return {
    /** Chame dentro de um clique ou tecla. Devolve true quando o som ficou disponível. */
    unlock() {
      if (disposed) return false;
      try {
        ctx ??= createContext();
        if (!ctx) return false;
        if (!master) {
          master = ctx.createGain();
          master.gain.value = muted ? 0 : volume;
          const limiter = ctx.createDynamicsCompressor?.();
          if (limiter) {
            limiter.threshold.value = -12; limiter.knee.value = 6; limiter.ratio.value = 8;
            limiter.attack.value = 0.003; limiter.release.value = 0.2;
            master.connect(limiter); limiter.connect(ctx.destination);
          } else master.connect(ctx.destination);
          noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
          const channel = noise.getChannelData(0);
          for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;
          musicTimer = timers.setInterval?.(scheduleMusic, MUSIC.interval) ?? null;
          musicTimer?.unref?.();
        }
        // Mexer no som com o jogo pausado prepara o contexto, mas não o acorda.
        if (!held) ctx.resume?.();
        return true;
      } catch {
        return false;
      }
    },
    footstep() { if (ready()) noiseBurst({ frequency: 520 + Math.random() * 300, q: 1.2, peak: 0.5, release: 0.07 }); },
    pickup() { if (ready()) tone({ frequency: 380, to: 720, peak: 0.28, release: 0.12 }); },
    coffee() {
      if (!ready()) return;
      noiseBurst({ type: 'highpass', frequency: 2600, q: 0.7, peak: 0.14, attack: 0.08, release: 1.1 });
      for (let i = 0; i < 6; i++) tone({ frequency: 260 + Math.random() * 280, peak: 0.16, release: 0.06, delay: 0.1 + i * 0.13 + Math.random() * 0.05 });
    },
    /** Lata do Nexus+: estalo da lingueta, pop, chiado do gás e um arpejo curto subindo. */
    can() {
      if (!ready()) return;
      noiseBurst({ type: 'highpass', frequency: 3200, q: 0.8, peak: 0.3, attack: 0.001, release: 0.04 });
      tone({ type: 'square', frequency: 1800, to: 700, peak: 0.14, attack: 0.001, release: 0.05 });
      tone({ frequency: 240, to: 120, peak: 0.24, release: 0.09, delay: 0.03 });
      noiseBurst({ type: 'highpass', frequency: 4200, q: 0.6, peak: 0.18, attack: 0.03, release: 0.7, delay: 0.08 });
      [523.25, 659.25, 880].forEach((frequency, i) => tone({ type: 'triangle', frequency, peak: 0.2, release: 0.16, delay: 0.5 + i * 0.07 }));
    },
    /** Tique suave nos últimos segundos do turbo. */
    turboTick() { if (ready()) tone({ type: 'triangle', frequency: 988, peak: 0.16, release: 0.06 }); },
    alert() {
      if (!ready()) return;
      for (const delay of [0, 0.36]) {
        tone({ type: 'square', frequency: 880, peak: 0.16, release: 0.1, delay });
        tone({ type: 'square', frequency: 660, peak: 0.16, release: 0.12, delay: delay + 0.16 });
      }
    },
    success() {
      if (!ready()) return;
      [523.25, 659.25, 783.99, 1046.5].forEach((frequency, i) => tone({ type: 'triangle', frequency, peak: 0.26, release: 0.22, delay: i * 0.08 }));
    },
    /** Uma tecla do teclado do PC. */
    typing() {
      if (!ready()) return;
      noiseBurst({ type: 'highpass', frequency: 1800 + Math.random() * 900, q: 0.8, peak: 0.2, attack: 0.001, release: 0.03 });
    },
    /** A cadeira ao sentar e ao levantar. */
    sit() {
      if (!ready()) return;
      noiseBurst({ type: 'lowpass', frequency: 260, q: 0.9, peak: 0.5, attack: 0.01, release: 0.16 });
      tone({ frequency: 190, to: 120, peak: 0.18, release: 0.14 });
    },
    stand() {
      if (!ready()) return;
      noiseBurst({ type: 'lowpass', frequency: 320, q: 0.9, peak: 0.4, attack: 0.01, release: 0.12 });
      tone({ frequency: 130, to: 200, peak: 0.16, release: 0.12 });
    },
    levelUp() {
      if (!ready()) return;
      [392, 523.25, 659.25, 783.99, 1046.5].forEach((frequency, i) => tone({ type: 'triangle', frequency, peak: 0.28, release: i === 4 ? 0.6 : 0.16, delay: i * 0.09 }));
      tone({ frequency: 523.25, peak: 0.16, attack: 0.02, release: 0.7, delay: 0.36 });
    },
    mission() {
      if (!ready()) return;
      tone({ frequency: 880, peak: 0.25, release: 0.3 });
      tone({ frequency: 1318.5, peak: 0.25, release: 0.45, delay: 0.12 });
    },
    /** A cada entrega emendada o bip sobe um degrau. */
    combo(streak) {
      if (ready()) tone({ type: 'triangle', frequency: 520 * 1.12 ** Math.max(0, Math.min(8, streak - 1)), peak: 0.22, release: 0.14, delay: 0.3 });
    },
    denied() { if (ready()) tone({ type: 'square', frequency: 150, to: 110, peak: 0.16, release: 0.14 }); },
    shiftEnd() {
      if (!ready()) return;
      [659.25, 523.25, 392].forEach((frequency, i) => tone({ type: 'triangle', frequency, peak: 0.24, release: 0.3, delay: i * 0.16 }));
    },
    /** Zumbido contínuo das ventoinhas: a sala nunca fica muda e cresce com os racks no ar. */
    fan(level) {
      if (!ctx || !master) return;
      ensureFan();
      const target = muted ? 0 : (0.25 + 0.75 * clamp01(level)) * 0.4;
      fanGain.gain.setTargetAtTime(target, ctx.currentTime, 0.6);
    },
    setMuted(value) {
      muted = Boolean(value);
      try { storage?.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* sem armazenamento, vale só nesta sessão */ }
      if (ctx && master) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.05);
      return muted;
    },
    isMuted() { return muted; },
    /** Volume de 0 a 1, lembrado na próxima visita. */
    setVolume(value) {
      volume = clamp01(Number(value) || 0);
      try { storage?.setItem(VOLUME_KEY, String(volume)); } catch { /* sem armazenamento, vale só nesta sessão */ }
      if (ctx && master && !muted) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.05);
      return volume;
    },
    getVolume() { return volume; },
    suspend() { held = true; try { ctx?.suspend?.(); } catch { /* nada a fazer */ } },
    resume() { held = false; try { if (master) ctx?.resume?.(); } catch { /* nada a fazer */ } },
    dispose() {
      disposed = true;
      if (musicTimer != null) timers.clearInterval?.(musicTimer);
      musicTimer = null;
      try { fanSource?.stop(); } catch { /* já parou */ }
      fanSource = null;
      if (ownsContext) { try { ctx?.close?.(); } catch { /* já fechado */ } }
      ctx = null; master = null;
    },
  };
}
