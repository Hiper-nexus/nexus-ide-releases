// AudioWorklet processor: forwards mono Float32 PCM frames to the main thread.
// Plain JS (not TS) so it can be loaded verbatim as a worklet module via Vite's
// `?url` import — it runs in the AudioWorkletGlobalScope, not the DOM.
class PcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // Copy: the underlying buffer is reused across render quanta.
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}

registerProcessor('nexus-pcm-processor', PcmProcessor);
