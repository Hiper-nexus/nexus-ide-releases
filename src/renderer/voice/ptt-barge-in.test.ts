import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pttStartAction } from './ptt-barge-in';

describe('pttStartAction', () => {
  it('lets an explicit hold interrupt Jarvis while she is speaking', () => {
    expect(
      pttStartAction({ isListening: false, isBusy: true, status: 'speaking' }),
    ).toBe('barge-in');
  });

  it('does not open another microphone capture while one is already active', () => {
    expect(
      pttStartAction({ isListening: true, isBusy: false, status: 'listening' }),
    ).toBe('ignore');
  });

  it('keeps a non-speaking busy pipeline protected from a second PTT turn', () => {
    expect(
      pttStartAction({ isListening: false, isBusy: true, status: 'transcribing' }),
    ).toBe('ignore');
  });

  it('starts a normal hold capture while idle', () => {
    expect(
      pttStartAction({ isListening: false, isBusy: false, status: 'idle' }),
    ).toBe('start');
  });

  it('wires a PTT barge-in to cut output without enabling passive wake', () => {
    const controller = fs.readFileSync(path.join(__dirname, 'voice-controller.ts'), 'utf8');
    const playback = fs.readFileSync(path.join(__dirname, 'voice-playback.ts'), 'utf8');

    expect(controller).toContain('pttStartAction({');
    expect(controller).toContain("stopAllPlayback('ptt-barge-in')");
    expect(controller).toContain('wakeMic.cancelPassiveWake()');
    expect(controller).toContain('livePlayer?.stop()');
    expect(playback).toContain("interruptReason = 'barge-in'");
  });
});
