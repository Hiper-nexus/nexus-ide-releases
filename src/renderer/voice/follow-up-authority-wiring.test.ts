import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const controller = fs.readFileSync(path.join(__dirname, 'voice-controller.ts'), 'utf8');
const followup = fs.readFileSync(path.join(__dirname, 'live-followup.ts'), 'utf8');
const finish = fs.readFileSync(path.join(__dirname, 'voice-finish-and-process.ts'), 'utf8');

describe('follow-up authority wiring', () => {
  it('requires explicit authority for no-wake hot injection', () => {
    expect(controller).toContain('if (!followUpAuthority.isAuthorized())');
    expect(controller).toContain('wake.passiveHotUnauthorized');
    expect(controller).toContain('followUpAuthority.clear();');
  });

  it('blocks quiet echo but permits strong human barge-in while Jarvis speaks', () => {
    const guard = controller.indexOf("if (voiceStatus === 'speaking' && !strongHumanBarge)");
    const transcribe = controller.indexOf('window.nexus.voice.transcribe', guard);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(controller.slice(guard, transcribe)).toContain('return;');
    expect(controller).toContain('utterance.rawMaxRms >= 0.3');
    expect(controller).toContain('wake.passiveBargeChecking');
    expect(controller).toContain("liveInterrupt('voice-barge')");
  });

  it('gives an authorized hot follow-up exclusively to Gemini Live', () => {
    expect(controller).toContain("'wake.passiveOwnedByLive'");
    expect(controller).toContain("voiceStatus === 'listening'");
    expect(controller).toContain('followUpAuthority.isAuthorized()');
  });

  it('keeps passive STT out of an active reply even after its short bridge expires', () => {
    expect(controller).toContain("activeCaptureReason === 'reply'");
    expect(controller).toContain("voiceStatus === 'transcribing'");
    expect(controller).toContain('wake.passiveOwnedByLive');
  });

  it('permits local recovery for the reply capture itself, not for passive audio', () => {
    expect(finish).toContain("followUpAuthorized: activeCaptureReason === 'reply'");
    expect(finish).toContain('The capture is already the authorization boundary');
  });

  it('does not stream automatic reply audio before local validation', () => {
    expect(controller).toContain("!followUpAuthority.isAuthorized()");
  });

  it('arms once for a real follow-up and never reopens a silent one', () => {
    expect(followup).toContain('followUpAuthority.arm()');
    expect(followup).toContain('followUpAuthority.clear()');

    const classic = fs.readFileSync(path.join(__dirname, 'voice-run-jarvis-turn.ts'), 'utf-8');
    expect(classic).toContain('followUpAuthority.arm()');
    expect(classic).toContain("source: 'classic-reply'");
    expect(finish).toContain('const MAX_REPLY_MUTE_REOPENS = 0');
  });

  it('authorizes the provider-answer drain gap before reopening capture', () => {
    const bridge = followup.indexOf('jarvis.followUpAuthorityBridgeArmed');
    const reopen = followup.indexOf('void reopenLiveFollowUpListening(opts)');
    expect(bridge).toBeGreaterThan(-1);
    expect(reopen).toBeGreaterThan(bridge);
  });

  it('authorizes the tool-result drain gap before reopening capture', () => {
    const ready = followup.indexOf('jarvis.liveToolFollowUpReady');
    const bridge = followup.indexOf('jarvis.toolFollowUpAuthorityBridgeArmed');
    const reopen = followup.indexOf('void reopenLiveFollowUpListening(request)');
    expect(ready).toBeGreaterThan(-1);
    expect(bridge).toBeGreaterThan(ready);
    expect(reopen).toBeGreaterThan(bridge);
  });
});

describe('passive STT admission wiring', () => {
  it('gates locally before transcription and backs off rejected ambient audio', () => {
    expect(controller).toContain('passiveWakeAdmission.shouldTranscribe');
    expect(controller).toContain("'wake.passiveLocalRejected'");
    expect(controller).toContain('passiveWakeAdmission.reject');
    expect(controller).toContain('passiveWakeAdmission.accept');
  });
});
