import { describe, expect, it } from 'vitest';
import { VOICE_CHANNELS } from '../../shared/voice-channels';
import { JarvisLiveSession } from './jarvis-live';

describe('JarvisLiveSession', () => {
  it('starts, broadcasts state, transcripts and tool events', () => {
    let now = 1_000;
    const events: Array<{ channel: string; payload: unknown }> = [];
    const persisted: Array<{ sessionId: string; role: string; text: string }> = [];
    const live = new JarvisLiveSession(
      (channel, payload) => events.push({ channel, payload }),
      () => now,
      (sessionId, line) => persisted.push({ sessionId, role: line.role, text: line.text }),
    );

    live.setEnabled(true);
    const started = live.start({ reason: 'manual' });
    expect(started.enabled).toBe(true);
    expect(started.status).toBe('listening');
    expect(started.realtimeReady).toBe(false);
    expect(started.sessionId).toBeTruthy();

    now += 10;
    live.onJarvisReply('que horas são?', {
      say: 'São dez horas.',
      action: { type: 'run_command', command: 'date' },
    });

    expect(events.some((e) => e.channel === VOICE_CHANNELS.liveState)).toBe(true);
    expect(events.filter((e) => e.channel === VOICE_CHANNELS.liveTranscript)).toHaveLength(2);
    expect(events.filter((e) => e.channel === VOICE_CHANNELS.liveToolCall)).toHaveLength(1);
    expect(persisted.map((line) => [line.role, line.text])).toEqual([
      ['user', 'que horas são?'],
      ['assistant', 'São dez horas.'],
    ]);
    expect(live.getState().turns).toBe(1);

    live.toolResult({ tool: 'run_command', ok: false, summary: 'usuário recusou' });
    expect(events.filter((e) => e.channel === VOICE_CHANNELS.liveToolResult)).toHaveLength(1);
  });

  it('ends a turn without destroying the live session', () => {
    let now = 2_000;
    const live = new JarvisLiveSession(() => {}, () => now);
    live.setEnabled(true);
    const started = live.start({ reason: 'wake' });
    live.patchStatus({ status: 'listening', realtimeReady: true });

    now += 42;
    const ended = live.endTurn();
    expect(ended).toMatchObject({
      enabled: true,
      sessionId: started.sessionId,
      status: 'dormant',
      realtimeReady: true,
      pendingMic: false,
      lastActiveAt: 2_042,
    });
  });

  it('tracks realtime transport readiness separately from live status', () => {
    const live = new JarvisLiveSession(() => {}, () => 100);
    live.setEnabled(true);
    live.start({ reason: 'manual' });

    const ready = live.patchStatus({ status: 'listening', realtimeReady: true });
    expect(ready.realtimeReady).toBe(true);

    const thinking = live.patchStatus({ status: 'thinking' });
    expect(thinking.realtimeReady).toBe(true);

    const failed = live.patchStatus({
      status: 'error',
      realtimeReady: false,
      error: 'transporte realtime falhou — usando Classic',
    });
    expect(failed).toMatchObject({
      status: 'error',
      realtimeReady: false,
      error: 'transporte realtime falhou — usando Classic',
    });
  });

  it('moves to interrupted and then stops without losing enabled config', () => {
    const live = new JarvisLiveSession(() => {}, () => 123);
    live.setEnabled(true);
    live.start({ reason: 'wake' });

    const interrupted = live.interrupt('barge-in');
    expect(interrupted.reason).toBe('barge-in');
    expect(live.getState()).toMatchObject({
      enabled: true,
      status: 'interrupted',
      pendingMic: true,
    });

    const stopped = live.stop();
    expect(stopped).toMatchObject({
      enabled: true,
      sessionId: null,
      status: 'dormant',
    });
  });
});
