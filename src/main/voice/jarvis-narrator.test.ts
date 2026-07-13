import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Handoff } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  initJarvisNarrator,
  shutdownJarvisNarrator,
  type NarratorHandoffSource,
} from './jarvis-narrator';

vi.mock('./voice-config-store', () => ({
  getVoiceConfig: () => ({ routing: 'jarvis' }),
}));

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: 'install-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest',
});

class FakeSource implements NarratorHandoffSource {
  handoffs: Handoff[] = [];
  listener: ((scope: ProjectExecutionScope) => void) | null = null;

  onChange(listener: (scope: ProjectExecutionScope) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  list(): readonly Handoff[] {
    return this.handoffs;
  }

  submit(input: Pick<Handoff, 'status' | 'summary' | 'fromAgent'>): void {
    this.handoffs.push({
      id: `handoff-${this.handoffs.length + 1}`,
      ...input,
      claimTrust: 'untrusted',
      artifacts: [],
      evidenceIds: [],
      evidenceTrust: 'unverified',
      delivered: false,
      deliveryState: 'queued',
      createdAt: Date.now(),
    });
    this.listener?.(scope);
  }
}

afterEach(() => {
  shutdownJarvisNarrator();
  vi.useRealTimers();
});

describe('jarvis-narrator scoped baseline', () => {
  it('does not narrate history that appears after initialization', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const source = new FakeSource();
    const spoken: string[] = [];
    initJarvisNarrator(
      (_scope, _channel, payload) =>
        spoken.push((payload as { text: string }).text),
      source,
    );

    vi.setSystemTime(1_000);
    source.submit({
      status: 'success',
      summary: 'Old worker result from history one',
      fromAgent: 'w1',
    });
    source.submit({
      status: 'success',
      summary: 'Old worker result from history two',
      fromAgent: 'w2',
    });
    vi.setSystemTime(5_000);
    vi.advanceTimersByTime(2_000);

    expect(spoken).toEqual([]);
  });

  it('narrates only fresh handoffs and preserves their project scope', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const source = new FakeSource();
    const spoken: Array<{ projectId: string; text: string }> = [];
    initJarvisNarrator(
      (eventScope, _channel, payload) =>
        spoken.push({
          projectId: eventScope.projectId,
          text: (payload as { text: string }).text,
        }),
      source,
    );

    vi.setSystemTime(12_000);
    source.submit({
      status: 'success',
      summary: 'Fresh delivery the user should hear about',
      fromAgent: 'builder',
    });
    vi.advanceTimersByTime(2_000);

    expect(spoken).toEqual([
      expect.objectContaining({ projectId: 'project-a', text: expect.stringContaining('builder') }),
    ]);
  });

  it('never speaks technical failure payloads, ids, paths, or code', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const source = new FakeSource();
    const spoken: string[] = [];
    initJarvisNarrator(
      (_scope, _channel, payload) =>
        spoken.push((payload as { text: string }).text),
      source,
    );

    vi.setSystemTime(12_000);
    source.submit({
      status: 'failed',
      fromAgent: 'QA',
      summary:
        'ERR_DLOPEN_FAILED at /Users/customer/project/main.ts:42 ' +
        'mission-b692cb98-f98b-4d5b-93c6-a1ce0b155f50 {"code":500}',
    });
    vi.advanceTimersByTime(2_000);

    expect(spoken).toEqual([
      'QA falhou na tarefa. Veja o diagnóstico no terminal.',
    ]);
  });

  it('silences the first synthetic recovery and never calls the supervisor stalled', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const source = new FakeSource();
    const spoken: string[] = [];
    initJarvisNarrator(
      (_scope, _channel, payload) =>
        spoken.push((payload as { text: string }).text),
      source,
    );

    vi.setSystemTime(12_000);
    source.submit({
      status: 'progress',
      fromAgent: 'nexus-delegation-supervisor',
      summary: 'primeira recuperação automática',
    });
    vi.advanceTimersByTime(2_000);
    expect(spoken).toEqual([]);

    source.submit({
      status: 'stalled',
      fromAgent: 'nexus-delegation-supervisor',
      summary: 'recuperação final',
    });
    vi.advanceTimersByTime(2_000);
    expect(spoken).toEqual([
      'A missão ainda não conseguiu colocar os especialistas para trabalhar. Veja o diagnóstico no terminal.',
    ]);
  });
});
