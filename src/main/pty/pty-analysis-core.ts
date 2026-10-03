import type { CompiledManifest } from '../detect/compiler';
import { AgentScreenDetector } from '../detect/detector-core';
import { SessionScreenBuffer } from '../detect/screen-buffer';
import { detectDevServerUrls } from '../orch/dev-server-detect';
import { FailoverTextReducer } from '../orch/failover-text-core';
import { LegacyHandoffParser } from '../orch/legacy-handoff';
import { MissionMarkerObserver } from '../orch/mission-completion-marker';
import { Osc133Scanner } from '../terminal/shell-integration-osc133';
import { redactCommandLine } from '../terminal/command-redaction';
import { ANALYSIS_EVENT_CAP, type AnalysisBinding, type AnalysisConsumer, type AnalysisEvent, type AnalysisInput, type AnalysisResult } from './pty-analysis-protocol';

interface Consumer { registration: number; config?: unknown }
interface Session {
  binding: AnalysisBinding; fence: AnalysisInput; consumers: Map<AnalysisConsumer, Consumer>;
  failover: FailoverTextReducer; marker: MissionMarkerObserver; osc: Osc133Scanner;
  devTail: string; devUrls: Set<string>; pasteTail: string; lines: string;
  publishAt: number; timer: ReturnType<typeof setTimeout> | null;
}
const PASTE_CODEX = /Pasted\s*Content\s*\d+\s*chars/i;
const PASTE_DEVIN = /Pasted\s*text\s*#\s*\d+\s*(?:\+\s*\d+\s*lines|\(\s*\d+\s*chars\s*\))/i;
/** Pure stream reducer. This module's entire import graph is Worker-safe. */
export class PtyAnalysisCore {
  readonly #sessions = new Map<string, Session>();
  readonly #screen = new SessionScreenBuffer();
  readonly #detector: AgentScreenDetector;
  readonly #handoff: LegacyHandoffParser;
  #events: AnalysisEvent[] = [];
  #current: Session | null = null;
  constructor(manifests: CompiledManifest[], private readonly publish: (result: AnalysisResult) => void) {
    this.#detector = new AgentScreenDetector({ manifests, getAgentInfo: (id) => {
      const binding = this.#sessions.get(id)?.binding;
      return binding?.adapterId ? { adapterId: binding.adapterId, paneId: binding.paneId } : null;
    }, now: Date.now, publish: (record) => {
      const s = this.#sessions.get(record.sessionId); if (!s) return;
      const value = { record, explain: this.#detector.lastExplain(record.sessionId), state: this.#detector.currentState(record.sessionId) };
      if (this.#current === s) this.#emit(s, 'screen', value);
      else this.#publish(s, [this.#event(s, 'screen', value)].filter((e): e is AnalysisEvent => e !== null), 0, false);
    }});
    this.#handoff = new LegacyHandoffParser((id, payload) => {
      const s = this.#sessions.get(id); if (s) this.#emit(s, 'handoff', payload, true);
    });
  }
  process(record: AnalysisInput): void {
    if (record.kind === 'bind') {
      this.#drop(record.sessionId);
      this.#sessions.set(record.sessionId, { binding: record.binding, fence: record, consumers: new Map(),
        failover: new FailoverTextReducer(), marker: new MissionMarkerObserver(), osc: new Osc133Scanner(),
        devTail: '', devUrls: new Set(), pasteTail: '', lines: '', publishAt: 0, timer: null });
    }
    const s = this.#sessions.get(record.sessionId);
    if (!s || s.fence.generation !== record.generation || s.fence.workerEpoch !== record.workerEpoch || record.eventSeq < s.fence.eventSeq) return;
    s.fence = record; this.#current = s; this.#events = [];
    switch (record.kind) {
      case 'arm':
        s.consumers.set(record.consumer, { registration: record.registration, config: record.config });
        if (record.consumer === 'completion') {
          const prompt = (record.config as { prompt?: string } | undefined)?.prompt;
          if (prompt) s.marker.registerPrompt(record.sessionId, prompt);
        }
        if (record.consumer === 'paste') s.pasteTail = '';
        break;
      case 'disarm':
        if (s.consumers.get(record.consumer)?.registration === record.registration) s.consumers.delete(record.consumer);
        break;
      case 'control':
        if (record.consumer === 'paste' && (record.value as { cancel?: number }).cancel === (s.consumers.get('paste')?.config as { watchId?: number } | undefined)?.watchId) s.consumers.delete('paste');
        if (record.consumer === 'screen' && (record.value as { binding?: AnalysisBinding }).binding) s.binding = (record.value as { binding: AnalysisBinding }).binding;
        if (record.consumer === 'failover') {
          const v = record.value as { observer?: { hit: Parameters<FailoverTextReducer['observer']>[0]; at: number } };
          if (v.observer) for (const proposal of s.failover.observer(v.observer.hit, v.observer.at)) this.#emit(s, 'failover', proposal);
          else s.failover.control(record.value as Parameters<FailoverTextReducer['control']>[0]);
        }
        if (record.consumer === 'completion') {
          const v = record.value as { prompt?: string; drop?: boolean };
          if (v.drop) s.marker.drop(record.sessionId);
          if (v.prompt) s.marker.registerPrompt(record.sessionId, v.prompt);
        }
        break;
      case 'data':
        // Each scanner sees bounded slices, including the initial flood burst.
        for (let offset = 0; offset < record.data.length; offset += 16_384) this.#data(s, record.data.slice(offset, offset + 16_384));
        break;
      case 'state': case 'flush': case 'exit':
        for (const proposal of s.failover.feed('', record.observedAt, true)) this.#emit(s, 'failover', proposal);
        this.#dev(s, '', true);
        if (record.kind === 'exit') {
          const marker = s.marker.seal(record.sessionId, record.observedAt);
          if (marker) this.#emit(s, 'completion', marker, true);
          if (s.lines) this.#emit(s, 'pipe', [s.lines], true);
        }
        break;
      case 'terminate': break;
    }
    const snapshot = record.kind === 'flush' || record.kind === 'exit' || record.observedAt - s.publishAt >= 100;
    if (snapshot) s.publishAt = record.observedAt;
    this.#publish(s, this.#events, record.kind === 'data' ? Buffer.byteLength(record.data) : 0, true, snapshot);
    this.#current = null;
    if (record.kind === 'exit' || record.kind === 'terminate') this.#drop(record.sessionId);
  }
  #data(s: Session, raw: string) {
    const id = s.fence.sessionId;
    let plain = '';
    this.#screen.append(id, raw, (value) => { plain = value; });
    if (s.consumers.has('screen')) this.#detector.onData(id, raw);
    if (s.consumers.has('command')) for (const event of s.osc.push(raw)) {
      // Secrets never return to Main command-block persistence or diagnostics.
      this.#emit(s, 'command', event.kind === 'command_line' ? { ...event, ...redactCommandLine(event.command) } : event, true);
    }
    if (!plain) return;
    if (s.consumers.has('dev-server')) this.#dev(s, plain);
    if (s.consumers.has('failover')) {
      for (const proposal of s.failover.feed(plain, s.fence.observedAt)) this.#emit(s, 'failover', proposal);
      if (!s.timer) {
        s.timer = setTimeout(() => {
          s.timer = null;
          if (this.#sessions.get(id) !== s) return;
          const sub = s.consumers.get('failover'); if (!sub) return;
          const events = s.failover.feed('', Date.now(), true).map((value) => ({ consumer: 'failover' as const, registration: sub.registration, value }));
          this.#publish(s, events, 0, false);
        }, 250); s.timer.unref?.();
      }
    }
    if (s.consumers.has('handoff')) this.#handoff.feed(id, plain);
    if (s.consumers.has('completion')) {
      const marker = s.marker.observe(id, plain, s.fence.observedAt);
      if (marker) this.#emit(s, 'completion', marker, true);
    }
    if (s.consumers.has('paste')) {
      s.pasteTail = (s.pasteTail + plain).slice(-8_192);
      const adapter = (s.consumers.get('paste')?.config as { adapterId?: string } | undefined)?.adapterId ?? s.binding.adapterId;
      if ((adapter === 'devin' ? PASTE_DEVIN : PASTE_CODEX).test(s.pasteTail)) {
        this.#emit(s, 'paste', { marker: true, watchId: (s.consumers.get('paste')?.config as { watchId?: number } | undefined)?.watchId }); s.consumers.delete('paste'); s.pasteTail = '';
      }
    }
    if (s.consumers.has('pipe')) {
      const input = s.lines + plain;
      const end = input.lastIndexOf('\n');
      if (end >= 0) for (const line of input.slice(0, end).split('\n')) this.#emit(s, 'pipe', [line]);
      s.lines = input.slice(end + 1).slice(-16_384);
    }
  }
  #dev(s: Session, plain: string, flush = false) {
    const input = s.devTail + plain;
    const end = flush ? input.length : input.lastIndexOf('\n') + 1;
    if (end > 0) for (const url of detectDevServerUrls(input.slice(0, end))) {
      if (s.devUrls.has(url) || s.devUrls.size >= 4) continue;
      s.devUrls.add(url); this.#emit(s, 'dev-server', [...s.devUrls]);
    }
    s.devTail = input.slice(end).slice(-300);
  }
  #event(s: Session, consumer: AnalysisConsumer, value: unknown, archival = false): AnalysisEvent | null {
    const sub = s.consumers.get(consumer);
    return sub ? { consumer, registration: sub.registration, value, ...(archival ? { archival: true } : {}) } : null;
  }
  #emit(s: Session, consumer: AnalysisConsumer, value: unknown, archival = false) {
    const event = this.#event(s, consumer, value, archival); if (event) {
      this.#events.push(event);
      if (this.#events.length >= ANALYSIS_EVENT_CAP) { this.#publish(s, this.#events, 0, false); this.#events = []; }
    }
  }
  #publish(s: Session, events: readonly AnalysisEvent[], ackBytes: number, done: boolean, snapshot = false) {
    this.publish({ ...s.fence, kind: 'result', events: [...events], ackBytes, done,
      ...(snapshot ? { screenText: this.#screen.text(s.fence.sessionId) } : {}) });
  }
  #drop(id: string) {
    const s = this.#sessions.get(id); if (s?.timer) clearTimeout(s.timer);
    this.#sessions.delete(id); this.#screen.drop(id); this.#detector.onExit(id); this.#handoff.dropSession(id);
  }
  close() { for (const id of this.#sessions.keys()) this.#drop(id); }
}
