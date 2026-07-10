// AudioWorklet processor: downmix multi-channel PCM → mono and forward 40ms
// batches to the main thread. Chromium renders 128-sample quanta (8ms at
// 16kHz); posting each quantum caused 125 structured-clone/store updates per
// second while the always-on wake mic was idle. 640 samples keeps endpointing
// responsive and matches Gemini Live's recommended 20–40ms input chunks.
// Plain JS (not TS) so it can be loaded verbatim as a worklet module via Vite's
// `?url` import — it runs in the AudioWorkletGlobalScope, not the DOM.
const FRAME_SAMPLES = 640;

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(FRAME_SAMPLES);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const len = input[0].length;
    const channels = input.filter((channel) => channel && channel.length === len);
    if (channels.length === 0) return true;

    let sourceOffset = 0;
    while (sourceOffset < len) {
      const count = Math.min(len - sourceOffset, FRAME_SAMPLES - this.offset);
      for (let i = 0; i < count; i += 1) {
        let mixed = 0;
        for (let ch = 0; ch < channels.length; ch += 1) {
          mixed += channels[ch][sourceOffset + i];
        }
        this.frame[this.offset + i] = mixed / channels.length;
      }
      this.offset += count;
      sourceOffset += count;

      if (this.offset === FRAME_SAMPLES) {
        const completed = this.frame;
        this.frame = new Float32Array(FRAME_SAMPLES);
        this.offset = 0;
        this.port.postMessage(completed, [completed.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('nexus-pcm-processor', PcmProcessor);
