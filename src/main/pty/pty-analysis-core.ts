import { TokenSpeedTextAnalyzer } from '../usage/token-speed-meter';
import { splitSubmittedInput, hasSubmittedPrompt } from '../usage/token-speed-input';
import { PtyStreamActionParser } from '../orch/pty-stream-action-parser';
import { PIPE_MARKER, sanitizeForInjection } from '../orch/pane-pipe-core';
import { CliPromptAutoResponder } from '../orch/cli-prompt-autoresponder-core';
import { FirstRunInterstitialResponder } from './first-run-interstitial';
import type { CompiledManifest } from '../detect/compiler';
import { AgentScreenDetector } from '../detect/detector-core';
import { SessionScreenBuffer } from '../detect/screen-buffer';
import { detectDevServerUrls } from '../orch/dev-server-detect';
import { FailoverTextReducer } from '../orch/failover-text-core';
import { LegacyHandoffParser } from '../orch/legacy-handoff';
import { MissionMarkerObserver } from '../orch/mission-completion-marker-core';
import { Osc133Scanner } from '../terminal/shell-integration-osc133';
import { redactCommandLine } from '../terminal/command-redaction';
import { ANALYSIS_EVENT_CAP, type AnalysisBinding, type AnalysisConsumer, type AnalysisEvent, type AnalysisInput, type AnalysisResult } from './pty-analysis-protocol';

interface Consumer { registration: number; config?: unknown }
interface Session {
  binding: AnalysisBinding; fence: AnalysisInput; consumers: Map<AnalysisConsumer, Consumer>;
  failover: FailoverTextReducer; marker: MissionMarkerObserver; osc: Osc133Scanner;
  token: TokenSpeedTextAnalyzer; tokenParts: string[]; draft: string;
  action?: PtyStreamActionParser;
  prompt: CliPromptAutoResponder; firstRun: FirstRunInterstitialResponder;
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
  constructor(manifests: CompiledManifest[], private readonly publish: (result: AnalysisResult) => void, risky?: { start: (sessionId: string, manifestId: string) => void; end: () => void }) {
    this.#detector = new AgentScreenDetector({ manifests, diagnostic: (id, adapterId, explain, state) => {
      const session = this.#sessions.get(id); if (!session) return;
      const value = { adapterId, explain, state };
      if (this.#current === session) this.#emit(session, 'screen', value);
      else { const event = this.#event(session, 'screen', value); if (event) this.#publish(session, [event], 0, false); }
    }, beforeEvaluate: risky?.start, afterEvaluate: risky?.end, getAgentInfo: (id) => {
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
        token: new TokenSpeedTextAnalyzer(), tokenParts: [], draft: '',
        prompt: new CliPromptAutoResponder(() => true, () => {}), firstRun: new FirstRunInterstitialResponder(),
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
        if (record.consumer === 'mission-control' && (record.value as { channelId?: string }).channelId) s.action = new PtyStreamActionParser((record.value as { channelId: string }).channelId);
        if (record.consumer === 'prompt') {
          const v = record.value as { bind?: { adapterId: string; now: number; governed: boolean }; drop?: boolean; accepted?: Parameters<CliPromptAutoResponder['acceptAnalysis']>[1] };
          if (v.accepted) s.prompt.acceptAnalysis(record.sessionId, v.accepted, record.observedAt);
          if (v.bind) s.prompt.bind(record.sessionId, v.bind.adapterId, v.bind.now, { governed: v.bind.governed });
          if (v.drop) s.prompt.drop(record.sessionId);
        }
        if (record.consumer === 'first-run') {
          const v = record.value as { bind?: Parameters<FirstRunInterstitialResponder['bind']>[1]; agentWorkObserved?: boolean; drop?: boolean };
          if (v.bind) s.firstRun.bind(record.sessionId, v.bind, record.observedAt);
          if (v.drop || v.agentWorkObserved) s.firstRun.drop(record.sessionId);
        }
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
      case 'data': {
        let offset = 0;
        for (const piece of record.pieces ?? [{ chars: record.data.length, at: record.observedAt }]) {
          const raw = record.data.slice(offset, offset + piece.chars); offset += piece.chars;
          s.fence = { ...record, observedAt: piece.at };
          for (let index = 0; index < raw.length; index += 16_384) this.#data(s, raw.slice(index, index + 16_384));
          if (s.consumers.has('token') && record.endOfChunk !== false) {
            const tokens = s.token.output(s.tokenParts.join('')); s.tokenParts = [];
            this.#emit(s, 'token', { tokens, at: piece.at });
          }
        }
        s.fence = record;
        break;
      }
      case 'input': {
        if (s.consumers.has('token')) {
          const result = splitSubmittedInput(s.draft, record.data); s.draft = result.draft;
          if (result.submitted !== null && hasSubmittedPrompt(result.submitted)) { s.token.submit(result.submitted); this.#emit(s, 'token', { submit: true, at: record.observedAt }); }
        }
        break;
      }
      case 'state': case 'flush': case 'exit':
        if (s.consumers.has('screen')) this.#detector.evaluateSession(record.sessionId);
        for (const proposal of s.failover.feed('', record.observedAt, true)) this.#emit(s, 'failover', proposal);
        this.#dev(s, '', true);
        if (s.consumers.has('pipe')) this.#emit(s, 'pipe', { idleText: sanitizeForInjection(this.#screen.text(record.sessionId).split('\n').slice(-60).filter((line) => !line.includes(PIPE_MARKER)).join('\n')).slice(0, 4_000) });
        if (record.kind === 'exit') {
          const priorMarker = s.marker.markerOf(record.sessionId);
          const marker = s.marker.seal(record.sessionId, record.observedAt);
          if (marker && !priorMarker) this.#emit(s, 'completion', marker, true);
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
    if (s.consumers.has('token')) s.tokenParts.push(plain);
    if (!plain) return;
    if (s.consumers.has('prompt')) {
      const before = s.prompt.isVerifying(id);
      const response = s.prompt.observe(id, plain, s.fence.observedAt);
      const snapshot = s.prompt.analysisSnapshot(id, s.fence.observedAt);
      if (response || (before && !snapshot.verifying)) this.#emit(s, 'prompt', { ...snapshot, response: response ?? undefined, verified: before && !snapshot.verifying });
      else if (s.prompt.isPending(id, s.fence.observedAt)) this.#emit(s, 'prompt', snapshot);
    }
    if (s.consumers.has('first-run')) {
      const response = s.firstRun.observe(id, plain, { now: s.fence.observedAt });
      if (response) this.#emit(s, 'first-run', response);
    }
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
        }, Math.max(250, s.failover.slowUntil - Date.now())); s.timer.unref?.();
      }
    }
    if (s.consumers.has('mission-control') && s.action) for (const request of s.action.feed(plain)) this.#emit(s, 'mission-control', request);
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
      if (end >= 0) for (const line of input.slice(0, end).split('\n')) { const clean = sanitizeForInjection(line.trim()); if (clean && !clean.includes(PIPE_MARKER)) this.#emit(s, 'pipe', [clean]); }
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
    const { workerEpoch, sessionId, generation, eventSeq, observedAt } = s.fence;
    this.publish({ workerEpoch, sessionId, generation, eventSeq, observedAt, kind: 'result', events: [...events], ackBytes, done,
      ...(snapshot ? { screenText: this.#screen.text(s.fence.sessionId) } : {}) });
  }
  #drop(id: string) {
    const s = this.#sessions.get(id); if (s?.timer) clearTimeout(s.timer);
    this.#sessions.delete(id); this.#screen.drop(id); this.#detector.onExit(id); this.#handoff.dropSession(id);
  }
  close() { for (const id of this.#sessions.keys()) this.#drop(id); }
}
