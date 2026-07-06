import { describe, expect, it } from 'vitest';
import { VOICE_CHANNELS } from '../../shared/voice-channels';
import { JarvisLiveSession } from './jarvis-live';

describe('JarvisLiveSession', () => {
  it('starts, broadcasts state, transcripts and tool events', () => {
    let now = 1_000;
    const events: Array<{ channel: string; payload: unknown }> = [];
    const live = new JarvisLiveSession(
      (channel, payload) => events.push({ channel, payload }),
      () => now,
    );

    live.setEnabled(true);
    const started = live.start({ reason: 'manual' });
    expect(started.enabled).toBe(true);
    expect(started.status).toBe('listening');
    expect(started.sessionId).toBeTruthy();

    now += 10;
    live.onJarvisReply('que horas são?', {
      say: 'São dez horas.',
      action: { type: 'run_command', command: 'date' },
    });

    expect(events.some((e) => e.channel === VOICE_CHANNELS.liveState)).toBe(true);
    expect(events.filter((e) => e.channel === VOICE_CHANNELS.liveTranscript)).toHaveLength(2);
    expect(events.filter((e) => e.channel === VOICE_CHANNELS.liveToolCall)).toHaveLength(1);
    expect(live.getState().turns).toBe(1);

    live.toolResult({ tool: 'run_command', ok: false, summary: 'usuário recusou' });
    expect(events.filter((e) => e.channel === VOICE_CHANNELS.liveToolResult)).toHaveLength(1);
  });

  it('ends a turn without destroying the live session', () => {
    let now = 2_000;
    const live = new JarvisLiveSession(() => {}, () => now);
    live.setEnabled(true);
    const started = live.start({ reason: 'wake' });

    now += 42;
    const ended = live.endTurn();
    expect(ended).toMatchObject({
      enabled: true,
      sessionId: started.sessionId,
      status: 'dormant',
      pendingMic: false,
      lastActiveAt: 2_042,
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
