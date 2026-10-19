import { PCM_WORKLET_NODE_NAME, pcmWorkletBlobUrl } from './pcm-worklet';
import { preferredInputConstraints } from './audio-device-preferences';
import { encodeWav, frameRms, mergeChunks } from './voice-capture';
import { rmsToLevel } from './voice-level';

/**
 * Live recording for "Minha voz" (F-1593). Unlike the push-to-talk capture
 * (16 kHz, echo cancellation and noise suppression on, tuned for STT), a voice
 * clone needs the voice as it is: native sample rate, no AEC, no noise
 * suppression, no automatic gain. Output is a mono PCM16 WAV. There is no
 * file upload path: the sample is always recorded now (study §2.5).
 */

export interface VoiceSample {
  readonly wav: Uint8Array;
  readonly durationSec: number;
  readonly sampleRate: number;
  /** Loudest frame RMS; near zero means the microphone recorded silence. */
  readonly peakRms: number;
}

export class VoiceSampleRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private peak = 0;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private recording = false;

  /** Live level [0,1] per frame for the meter. */
  onLevel: ((level: number) => void) | null = null;

  isRecording(): boolean {
    return this.recording;
  }

  /** Starts the microphone; `maxSec` stops it on its own (`onLimit` fires). */
  async start(maxSec: number, onLimit: () => void): Promise<void> {
    if (this.recording) return;
    this.chunks = [];
    this.peak = 0;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: await preferredInputConstraints({
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    });
    this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    const onFrame = (frame: Float32Array) => {
      if (!this.recording) return;
      this.chunks.push(frame);
      const rms = frameRms(frame);
      if (rms > this.peak) this.peak = rms;
      this.onLevel?.(rmsToLevel(rms));
    };
    try {
      await this.ctx.audioWorklet.addModule(pcmWorkletBlobUrl());
      const node = new AudioWorkletNode(this.ctx, PCM_WORKLET_NODE_NAME);
      node.port.onmessage = (event: MessageEvent<Float32Array>) => onFrame(event.data);
      this.source.connect(node);
      node.connect(this.ctx.destination);
      this.node = node;
    } catch {
      const node = this.ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (event) => onFrame(event.inputBuffer.getChannelData(0).slice(0));
      this.source.connect(node);
      node.connect(this.ctx.destination);
      this.node = node;
    }
    this.recording = true;
    this.limitTimer = setTimeout(() => {
      if (this.recording) onLimit();
    }, maxSec * 1000);
  }

  async stop(): Promise<VoiceSample> {
    const sampleRate = this.ctx?.sampleRate ?? 48_000;
    this.recording = false;
    this.teardown();
    const pcm = mergeChunks(this.chunks);
    this.chunks = [];
    return {
      wav: encodeWav(pcm, sampleRate),
      durationSec: pcm.length / sampleRate,
      sampleRate,
      peakRms: this.peak,
    };
  }

  /** Drops everything recorded; nothing leaves the renderer. */
  cancel(): void {
    this.recording = false;
    this.teardown();
    this.chunks = [];
  }

  private teardown(): void {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    this.onLevel?.(0);
    try {
      this.node?.disconnect();
      this.source?.disconnect();
      this.stream?.getTracks().forEach((track) => track.stop());
      void this.ctx?.close();
    } catch {
      // best-effort: a node already gone has nothing to release
    }
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }
}
