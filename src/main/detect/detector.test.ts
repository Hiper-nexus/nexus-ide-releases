import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { compileManifest } from './compiler';
import {
  AgentScreenDetector,
  DETECTION_WINDOW_CHARS,
  EVAL_SLOW_BACKOFF_MS,
  PendingIdleConfirmation,
  PENDING_IDLE_CAP_MS,
  PENDING_IDLE_RECHECK_MS,
  type ScreenDetectionRecord,
} from './detector';
import { parseManifest } from './manifest';
import { SessionScreenBuffer, type ScreenSource } from './screen-buffer';

const TEST_MANIFEST = [
  'id = "testcli"',
  'version = "1.0.0"',
  // Bottom-anchored like the real manifests: the stripped tail is append-only,
  // so working evidence must live at the bottom of the buffer to be displaced
  // by the next frame.
  '[[rules]]',
  'id = "spinner_working"',
  'state = "working"',
  'priority = 100',
  'visible_working = true',
  'region = "bottom_non_empty_lines(1)"',
  'contains = ["working..."]',
  '',
  '[[rules]]',
  'id = "prompt_idle"',
  'state = "idle"',
  'priority = 50',
  'visible_idle = true',
  'region = "bottom_non_empty_lines(1)"',
  'contains = ["ready>"]',
].join('\n');

function makeDetector(agentAdapter = 'testcli', screen?: ScreenSource) {
  const published: ScreenDetectionRecord[] = [];
  const detector = new AgentScreenDetector({
    manifests: [compileManifest(parseManifest(TEST_MANIFEST))],
    ...(screen ? { screen } : {}),
    getAgentInfo: (sessionId) =>
      sessionId === 'shell' ? null : { adapterId: agentAdapter, paneId: 'p1' },
    publish: (record) => published.push(record),
    now: () => Date.now(),
  });
  return { detector, published };
}

describe('PendingIdleConfirmation (port of Herdr agent_detection.rs)', () => {
  const working = {
    state: 'working' as const,
    visibleIdle: false,
    visibleBlocker: false,
    visibleWorking: true,
  };
  const plainIdle = {
    state: 'idle' as const,
    visibleIdle: false,
    visibleBlocker: false,
    visibleWorking: false,
  };

  it('holds working→plain-idle for 3 confirmations', () => {
    const pending = new PendingIdleConfirmation();
    expect(pending.shouldHoldWorkingToIdle(working, plainIdle, false, false, 0)).toBe(true);
    expect(pending.active()).toBe(true);
    expect(pending.shouldHoldWorkingToIdle(working, plainIdle, false, false, 100)).toBe(true);
    expect(pending.shouldHoldWorkingToIdle(working, plainIdle, false, false, 200)).toBe(true);
    expect(pending.shouldHoldWorkingToIdle(working, plainIdle, false, false, 300)).toBe(false);
    expect(pending.active()).toBe(false);
  });

  it('releases immediately past the 700ms cap', () => {
    const pending = new PendingIdleConfirmation();
    expect(pending.shouldHoldWorkingToIdle(working, plainIdle, false, false, 0)).toBe(true);
    expect(
      pending.shouldHoldWorkingToIdle(working, plainIdle, false, false, PENDING_IDLE_CAP_MS),
    ).toBe(false);
  });

  it('does not hold visible idle, blockers, or non-working transitions', () => {
    const pending = new PendingIdleConfirmation();
    const visibleIdle = { ...plainIdle, visibleIdle: true };
    expect(pending.shouldHoldWorkingToIdle(working, visibleIdle, false, false, 0)).toBe(false);
    const blocked = { ...plainIdle, state: 'blocked' as const, visibleBlocker: true };
    expect(pending.shouldHoldWorkingToIdle(working, blocked, false, false, 0)).toBe(false);
    expect(pending.shouldHoldWorkingToIdle(plainIdle, plainIdle, false, false, 0)).toBe(false);
    expect(pending.active()).toBe(false);
  });

  it('agent change or process exit bypass the hold', () => {
    const pending = new PendingIdleConfirmation();
    expect(pending.shouldHoldWorkingToIdle(working, plainIdle, true, false, 0)).toBe(false);
    expect(pending.shouldHoldWorkingToIdle(working, plainIdle, false, true, 0)).toBe(false);
  });
});

describe('AgentScreenDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes working when the spinner text appears', () => {
    const { detector, published } = makeDetector();
    detector.onData('s1', 'some output\nWorking...\n');
    vi.advanceTimersByTime(150);
    expect(published).toHaveLength(1);
    expect(published[0].state).toBe('working');
    expect(published[0].visibleWorking).toBe(true);
    expect(published[0].matchedRuleId).toBe('spinner_working');
    expect(published[0].manifestId).toBe('testcli');
    expect(published[0].paneId).toBe('p1');
  });

  it('ignores sessions without a known agent (shell panes)', () => {
    const { detector, published } = makeDetector();
    detector.onData('shell', 'Working...\n');
    vi.advanceTimersByTime(500);
    expect(published).toHaveLength(0);
  });

  it('ignores adapters without a manifest', () => {
    const { detector, published } = makeDetector('no-such-cli');
    detector.onData('s1', 'Working...\n');
    vi.advanceTimersByTime(500);
    expect(published).toHaveLength(0);
  });

  it('holds working→plain-idle until 3 rechecks confirm (anti-flicker)', () => {
    const { detector, published } = makeDetector();
    detector.onData('s1', 'Working...\n');
    vi.advanceTimersByTime(150);
    expect(published.map((r) => r.state)).toEqual(['working']);

    // Spinner disappears with no visible idle evidence → plain idle fallback.
    // The first window runs the data eval (hold starts) AND the first 100ms
    // recheck (confirmation 1), because the eval timer fires at delay 0.
    detector.onData('s1', '\nAll done output without markers\n');
    vi.advanceTimersByTime(PENDING_IDLE_RECHECK_MS);
    expect(published).toHaveLength(1); // hold + confirmation 1

    vi.advanceTimersByTime(PENDING_IDLE_RECHECK_MS);
    expect(published).toHaveLength(1); // confirmation 2
    vi.advanceTimersByTime(PENDING_IDLE_RECHECK_MS);
    expect(published).toHaveLength(2); // confirmation 3 → publish
    expect(published[1].state).toBe('idle');
    expect(published[1].fallbackReason).toBe('default_known_agent_idle_fallback');
  });

  it('publishes visible idle immediately (no anti-flicker hold)', () => {
    const { detector, published } = makeDetector();
    detector.onData('s1', 'Working...\n');
    vi.advanceTimersByTime(150);
    detector.onData('s1', '\nready> \n');
    vi.advanceTimersByTime(150);
    expect(published.map((r) => r.state)).toEqual(['working', 'idle']);
    expect(published[1].matchedRuleId).toBe('prompt_idle');
    expect(published[1].visibleIdle).toBe(true);
  });

  it('cancels the pending idle when work evidence returns', () => {
    const { detector, published } = makeDetector();
    detector.onData('s1', 'Working...\n');
    vi.advanceTimersByTime(150);
    detector.onData('s1', '\nquiet\n');
    vi.advanceTimersByTime(150); // hold starts
    detector.onData('s1', 'Working...\n');
    vi.advanceTimersByTime(150);
    // Still just the original working publish; the hold was cleared and the
    // re-asserted working state does not re-publish.
    expect(published).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(published).toHaveLength(1);
  });

  it('skips re-scanning an idle session whose content did not change', () => {
    const { detector, published } = makeDetector();
    detector.onData('s1', 'ready> \n');
    vi.advanceTimersByTime(150);
    expect(published).toHaveLength(1);
    expect(published[0].state).toBe('idle');

    // Pure escape-sequence traffic: OSC title changes no visible text.
    detector.onData('s1', '\x1b]0;new title\x07');
    vi.advanceTimersByTime(300);
    expect(published).toHaveLength(1); // content_seq skip
  });

  it('drop on exit clears timers and state', () => {
    const { detector, published } = makeDetector();
    detector.onData('s1', 'Working...\n');
    vi.advanceTimersByTime(150);
    detector.onExit('s1');
    expect(detector.currentState('s1')).toBeNull();
    vi.advanceTimersByTime(2000);
    expect(published).toHaveLength(1);
  });

  it('exposes detection taps for external consumers', () => {
    const { detector, published } = makeDetector();
    const tapped: ScreenDetectionRecord[] = [];
    const untap = detector.tapDetections((record) => tapped.push(record));
    detector.onData('s1', 'Working...\n');
    vi.advanceTimersByTime(150);
    expect(tapped).toEqual(published);
    untap();
    detector.onData('s1', 'more Working...\n');
    vi.advanceTimersByTime(150);
    expect(tapped).toHaveLength(1);
  });

  it('keeps the last explain for debugging', () => {
    const { detector } = makeDetector();
    detector.onData('s1', 'Working...\n');
    vi.advanceTimersByTime(150);
    const explain = detector.lastExplain('s1');
    expect(explain?.matchedRule?.id).toBe('spinner_working');
    expect(explain?.evaluatedRules.length).toBeGreaterThan(0);
  });
});

describe('getScreenText — cauda do buffer limpo (motor de texto, fallback)', () => {
  it('null sem buffer, texto com buffer, respeita maxChars pela cauda', () => {
    const { detector } = makeDetector('testcli', new SessionScreenBuffer());
    expect(detector.getScreenText('s-none')).toBeNull();
    detector.onData('s1', 'primeira linha\nsegunda linha\n');
    expect(detector.getScreenText('s1')).toBe('primeira linha\nsegunda linha\n');
    expect(detector.getScreenText('s1', 15)).toBe('\nsegunda linha\n');
    detector.onData('s1', 'terceira\n');
    expect(detector.getScreenText('s1')).toContain('terceira\n');
    detector.onExit('s1');
    expect(detector.getScreenText('s1')).toBeNull();
  });
});

describe('avaliação com janela e orçamento (F-764 C.3)', () => {
  const WHOLE_RECENT_MANIFEST = [
    'id = "testcli"',
    'version = "1.0.0"',
    '[[rules]]',
    'id = "old_banner_working"',
    'state = "working"',
    'priority = 100',
    'visible_working = true',
    'region = "whole_recent"',
    'contains = ["banner-antigo"]',
  ].join('\n');

  function detectorWith(
    manifest: string,
    trace?: (event: Record<string, unknown>) => void,
    screen?: ScreenSource,
  ) {
    const published: ScreenDetectionRecord[] = [];
    const detector = new AgentScreenDetector({
      manifests: [compileManifest(parseManifest(manifest))],
      ...(screen ? { screen } : {}),
      getAgentInfo: () => ({ adapterId: 'testcli', paneId: 'p1' }),
      publish: (record) => published.push(record),
      now: () => Date.now(),
      ...(trace ? { trace } : {}),
    });
    return { detector, published };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('avalia só a janela final do buffer, em linhas inteiras (motor de texto)', () => {
    const { detector } = detectorWith(WHOLE_RECENT_MANIFEST, undefined, new SessionScreenBuffer());
    detector.onData('s', 'banner-antigo\n');
    expect(detector.evaluateSession('s')?.state).toBe('working');
    // Mais que a janela depois do banner: ele saiu da TELA avaliada.
    const filler = `${'x'.repeat(99)}\n`.repeat(Math.ceil((DETECTION_WINDOW_CHARS + 1_000) / 100));
    detector.onData('s', filler);
    expect(detector.evaluateSession('s')?.state).not.toBe('working');
    // O texto inteiro segue disponível para quem lê a tela.
    expect(detector.getScreenText('s', 1_000_000)).toContain('banner-antigo');
  });

  it('avaliação acima do orçamento adia a próxima e registra o trace uma vez', () => {
    vi.useFakeTimers();
    try {
      const events: Array<Record<string, unknown>> = [];
      const { detector } = detectorWith(TEST_MANIFEST, (event) => events.push(event));
      let clock = 0;
      // Cada avaliação "custa" 30 ms no relógio de alta resolução.
      vi.spyOn(performance, 'now').mockImplementation(() => {
        clock += 30;
        return clock;
      });
      detector.onData('s', 'working...\n');
      vi.advanceTimersByTime(0);
      expect(events).toEqual([
        expect.objectContaining({
          kind: 'detector-eval-slow',
          sessionId: 's',
          manifestId: 'testcli',
          backoffMs: EVAL_SLOW_BACKOFF_MS,
        }),
      ]);
      const evaluate = vi.spyOn(detector, 'evaluateSession');
      detector.onData('s', 'ready>\n');
      vi.advanceTimersByTime(EVAL_SLOW_BACKOFF_MS - 50);
      expect(evaluate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(evaluate).toHaveBeenCalledTimes(1);
      // Segunda avaliação lenta dentro do minuto: sem trace novo.
      expect(events).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
