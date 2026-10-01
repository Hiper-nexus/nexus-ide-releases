/** Som do Data Café, 100% sintetizado com WebAudio: sem nenhum arquivo.
 * Só liga depois de um gesto do jogador (regra de autoplay dos navegadores).
 * Sem AudioContext (Node, navegador antigo, bloqueio) tudo vira silêncio. */
export const MUTE_KEY = 'nexus-data-cafe:muted';
const VOLUME = 0.18;

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function defaultContext() {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Context ? new Context() : null;
}

export function createAudio({ context = null, storage = defaultStorage(), createContext = defaultContext } = {}) {
  let ctx = context;
  const ownsContext = !context;
  let master = null, noise = null, fanGain = null, fanSource = null;
  let muted = false;
  let disposed = false;
  try { muted = storage?.getItem(MUTE_KEY) === '1'; } catch { muted = false; }

  function ready() {
    return Boolean(ctx && master) && !muted;
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
    filter.frequency.value = 420;
    fanGain = ctx.createGain();
    fanGain.gain.value = 0;
    fanSource.connect(filter); filter.connect(fanGain); fanGain.connect(master);
    fanSource.start();
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
          master.gain.value = muted ? 0 : VOLUME;
          master.connect(ctx.destination);
          noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
          const channel = noise.getChannelData(0);
          for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;
        }
        ctx.resume?.();
        return true;
      } catch {
        return false;
      }
    },
    footstep() { if (ready()) noiseBurst({ frequency: 650 + Math.random() * 350, q: 1.4, peak: 0.12, release: 0.06 }); },
    pickup() { if (ready()) tone({ frequency: 380, to: 720, peak: 0.08, release: 0.1 }); },
    coffee() {
      if (!ready()) return;
      noiseBurst({ type: 'highpass', frequency: 2600, q: 0.7, peak: 0.05, attack: 0.08, release: 1.1 });
      for (let i = 0; i < 6; i++) tone({ frequency: 260 + Math.random() * 280, peak: 0.05, release: 0.05, delay: 0.1 + i * 0.13 + Math.random() * 0.05 });
    },
    alert() {
      if (!ready()) return;
      tone({ type: 'square', frequency: 880, peak: 0.05, release: 0.1 });
      tone({ type: 'square', frequency: 660, peak: 0.05, release: 0.12, delay: 0.16 });
    },
    success() {
      if (!ready()) return;
      [523.25, 659.25, 783.99, 1046.5].forEach((frequency, i) => tone({ type: 'triangle', frequency, peak: 0.08, release: 0.2, delay: i * 0.08 }));
    },
    /** Zumbido contínuo das ventoinhas, mais alto quanto mais racks no ar. */
    fan(level) {
      if (!ctx || !master) return;
      ensureFan();
      const target = muted ? 0 : Math.max(0, Math.min(1, level)) * 0.35;
      fanGain.gain.setTargetAtTime(target, ctx.currentTime, 0.6);
    },
    setMuted(value) {
      muted = Boolean(value);
      try { storage?.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* sem armazenamento, vale só nesta sessão */ }
      if (ctx && master) master.gain.setTargetAtTime(muted ? 0 : VOLUME, ctx.currentTime, 0.05);
      return muted;
    },
    isMuted() { return muted; },
    suspend() { try { ctx?.suspend?.(); } catch { /* nada a fazer */ } },
    resume() { try { if (master) ctx?.resume?.(); } catch { /* nada a fazer */ } },
    dispose() {
      disposed = true;
      try { fanSource?.stop(); } catch { /* já parou */ }
      fanSource = null;
      if (ownsContext) { try { ctx?.close?.(); } catch { /* já fechado */ } }
      ctx = null; master = null;
    },
  };
}
