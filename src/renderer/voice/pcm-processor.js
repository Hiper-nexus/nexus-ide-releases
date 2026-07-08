// AudioWorklet processor: downmix multi-channel PCM → mono and forward to main thread.
// Plain JS (not TS) so it can be loaded verbatim as a worklet module via Vite's
// `?url` import — it runs in the AudioWorkletGlobalScope, not the DOM.
class PcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const len = input[0].length;
    const out = new Float32Array(len);
    let used = 0;
    for (let ch = 0; ch < input.length; ch += 1) {
      const channel = input[ch];
      if (!channel || channel.length !== len) continue;
      for (let i = 0; i < len; i += 1) out[i] += channel[i];
      used += 1;
    }
    if (used > 1) {
      for (let i = 0; i < len; i += 1) out[i] /= used;
    }
    this.port.postMessage(out);
    return true;
  }
}

registerProcessor('nexus-pcm-processor', PcmProcessor);
