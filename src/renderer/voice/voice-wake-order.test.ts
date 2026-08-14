import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'voice-controller.ts'), 'utf-8');
// Constants and gates moved to sub-modules — check them too.
const sessionStateSource = fs.readFileSync(
  path.join(__dirname, 'voice-session-state.ts'),
  'utf-8',
);
const gatesSource = fs.readFileSync(path.join(__dirname, 'voice-realtime-gates.ts'), 'utf-8');

function voiceWakeBlock(): string {
  const marker = 'const listenPromise = beginListening';
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('} catch (err) {', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('voice wake order', () => {
  it('does not start project-scoped voice before an authorized workspace is active', () => {
    const gate = source.indexOf('if (!active)');
    const capture = source.indexOf('capture.current = new VoiceCapture()');
    const wakeStart = source.indexOf('void armConfiguredWakeMic()', gate);

    expect(source).toContain('export function useVoiceController(active = true)');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(capture).toBeGreaterThan(gate);
    expect(wakeStart).toBeGreaterThan(gate);
    expect(source).toContain('}, [active])');
  });

  it('opens the mic in parallel with (or before) the audible ack', () => {
    const block = voiceWakeBlock();
    // listenPromise is created before the optional ack (Live path skips ack).
    expect(block.indexOf('const listenPromise = beginListening')).toBeGreaterThanOrEqual(0);
    // When Classic ack plays, it comes AFTER listenPromise (parallel pattern).
    expect(block.indexOf('await playWakePrompt')).toBeGreaterThan(
      block.indexOf('const listenPromise = beginListening'),
    );
    expect(block).toContain('await listenPromise');
  });

  it('seeds voice capture with wake pre-roll audio', () => {
    const block = voiceWakeBlock();
    expect(block).toContain('wakePreRoll');
    expect(block).toContain("'wake'");
  });

  it('reserves a cold configured Live wake before the socket reports ready', () => {
    // Cold Gemini connects after wake. It must still own the greeting, otherwise
    // OpenAI TTS speaks first and leaks into the microphone capture.
    const block = voiceWakeBlock();
    expect(gatesSource).toContain('export function shouldReserveWakeForRealtime');
    expect(source).toContain('const skipClassicAck = shouldReserveWakeForRealtime()');
    expect(source).toContain('if (!shouldReserveWakeForRealtime())');
    expect(block).toContain('if (!skipClassicAck)');
  });

  it('uses lowered wake capture thresholds', () => {
    expect(source).toContain('const WAKE_MIN_LISTEN_MS = 1_500');
    expect(source).toContain('const WAKE_SILENCE_MS = 700');
  });

  it('keeps provider STT unavailable before local wake or operator authority', () => {
    expect(source).toContain('const shouldUsePassiveWake = false');
    expect(source).toContain('wakeMic.onPassiveUtterance');
    expect(source).toContain('matchPassiveWakeWord');
    expect(source).toContain("purpose: 'passive-wake'");
    expect(source).toContain('budgetMs: PASSIVE_WAKE_STT_BUDGET_MS');
    expect(source).toContain("statusNow === 'speaking' ? 'voice-barge' : 'voice'");
    expect(source).toContain('wake.passiveSuppressedWhileSpeaking');
    const passiveStart = source.indexOf('const handlePassiveWake');
    const passiveEnd = source.indexOf('wakeMic.onDied', passiveStart);
    expect(passiveStart).toBeGreaterThanOrEqual(0);
    expect(passiveEnd).toBeGreaterThan(passiveStart);
    const passiveBlock = source.slice(passiveStart, passiveEnd);
    expect(passiveBlock).toContain('passiveWakeDeadline.isChecking() || wakeOpenInProgress');
    expect(passiveBlock).toContain('passiveWakeDeadline.run');
    expect(passiveBlock).toContain("request.kind === 'timeout'");
    expect(passiveBlock).toContain("statusNow === 'speaking' || statusNow === 'transcribing'");
    expect(passiveBlock).toContain('isHotSessionCommandCandidate');
    expect(passiveBlock).toContain('isRecentDuplicateTranscript');
    expect(passiveBlock).toContain('wake.passiveDuplicateDiscarded');
    expect(passiveBlock).toContain('passiveWakeWord: info.persona.assistantName');
    expect(passiveBlock).toContain("'voice-barge'");
    expect(source).toContain('wakeMic.cancelPassiveWake()');
    const wakeStart = source.indexOf('const handleWake = async');
    const wakeEnd = source.indexOf('const onWake =', wakeStart);
    expect(source.slice(wakeStart, wakeEnd)).toContain('passiveWakeDeadline.invalidate()');
    expect(source).toContain("if (stillHot && !match.command.trim())");
    expect(source).toContain("onWake('voice', utterance.preRoll)");
  });

  it('executes a trusted cold embedded command without opening a second mic capture', () => {
    expect(source).toContain("via: 'wake-rest-cold'");
    expect(source).toContain('await runClassicTextCommand(match.command.trim()');
    expect(source).toContain('jarvis.validatedTextCommand');
  });

  it('opens a fresh turn boundary before injecting text into a hot provider', () => {
    const start = source.indexOf('const beginInjectedTextTurn');
    const end = source.indexOf('const handlePassiveWake', start);
    const injectedBlock = source.slice(start, end);
    expect(injectedBlock).toContain('turnExecution.beginTurn()');
    expect(injectedBlock).toContain('realtimeTranscriptWaiter.beginTurn(turnId)');
    expect(injectedBlock).toContain('window.nexus.voice.liveTurnBegin(turnId)');
    expect(injectedBlock.indexOf('turnExecution.beginTurn()')).toBeLessThan(
      injectedBlock.indexOf('window.nexus.voice.liveRescueIn'),
    );
  });
});

describe('realtime bridge activation', () => {
  it('enables the realtime audio + action bridge (paridade completa)', () => {
    // Constants live in voice-session-state.ts (extracted for size budget).
    expect(sessionStateSource).toContain('const REALTIME_ACTION_BRIDGE_ENABLED = true');
    expect(sessionStateSource).toContain('const REALTIME_PROVIDER_AUDIO_ENABLED = true');
  });

  it('keeps the runtime degradation-to-Classic guards in shouldStreamToRealtime', () => {
    // Gates are in voice-realtime-gates.ts.
    expect(gatesSource).toContain('canAttemptRealtime(info)');
    expect(gatesSource).toContain('realtimeFallbackHasCredential');
    expect(gatesSource).not.toContain(
      "hasCredential(info, 'OPENAI_API_KEY') || hasCredential(info, 'GEMINI_API_KEY')",
    );
    expect(gatesSource).toMatch(/liveState\?\.status !== 'error'/);
  });
});

describe('wake barge-in guards', () => {
  it('allows interrupting speaking, transcribing, and routing', () => {
    expect(source).toMatch(
      /\['idle', 'listening', 'speaking', 'transcribing', 'routing'\]/,
    );
    expect(source).not.toMatch(
      /if \(voiceStatus === 'transcribing' \|\| voiceStatus === 'routing'\)/,
    );
  });

  it('allows full-duplex barge-in while speaking (voice → voice-barge)', () => {
    expect(source).toContain('shouldIgnoreLiveReWake');
    expect(source).toContain("source === 'voice' || source === 'voice-barge'");
    expect(source).toContain("type WakeSource = 'voice' | 'voice-barge' | 'click'");
    expect(source).toContain("voiceStatus === 'speaking' && source === 'voice' ? 'voice-barge'");
    expect(gatesSource).toContain('export function shouldIgnoreLiveReWake');
    expect(gatesSource).toContain("if (status === 'speaking') return false");
  });

  it('starts Live without injecting a competing spoken greeting', () => {
    expect(source).toContain('.liveStart({ reason })');
    expect(source).not.toContain('jarvis.liveWakeGreeting');
    expect(source).not.toContain('liveWakeInjectPrompt');
    expect(source).not.toContain('forceFresh:');
  });

  it('keeps a natural follow-up window before returning wake ownership', () => {
    expect(source).toContain('const REPLY_MAX_LISTEN_MS = FOLLOW_UP_AUTHORITY_MS');
    expect(source).toContain("reason === 'reply' && autoStop");
    expect(source).toContain('Math.min(autoStop.maxMs, REPLY_MAX_LISTEN_MS)');
  });

  it('resets the turn without tearing down the healthy Live session', () => {
    const wakeStart = source.indexOf('const handleWake = async');
    const wakeEnd = source.indexOf('const onWake =', wakeStart);
    const wakeBlock = source.slice(wakeStart, wakeEnd);
    expect(wakeBlock).toContain('cancelLiveFollowUp()');
    expect(wakeBlock).toContain("liveInterrupt('wake-barge-in')");
    expect(wakeBlock).toContain('jarvis.wakeTurnReset');
    expect(wakeBlock).not.toContain('liveHardTeardown');
    expect(wakeBlock).not.toContain('jarvis.wakeSyncReset');
  });

  it('does not access cloud credentials or synthesize audio while the controller mounts', () => {
    // Both paths resolve encrypted voice credentials in Electron main. Doing
    // that from a passive React effect can synchronously enter macOS Keychain
    // and starve the renderer/CDP before the first usable frame. The explicit
    // wake path still calls liveStart/playWakePrompt on demand.
    expect(source).not.toContain('warmAckCache(');
    expect(source).not.toContain('livePrewarm(true)');
    expect(source).toContain('.liveStart({ reason })');
    expect(source).toContain('await playWakePrompt');
  });
});

describe('Jarvis power-off authority', () => {
  it('cuts capture/wake and rejects acoustic resurrection until explicit input', () => {
    expect(source).toContain('registerJarvisPowerControl');
    expect(source).toContain('capture.current.stop()');
    expect(source).toContain('wakeMic.stop()');
    expect(source).toContain('if (isJarvisPoweredOff()) return');
    expect(source).toContain(
      'const unsubWake = window.nexus.voice.onWakeDetected(() => onWake(\'voice\'))',
    );
    expect(source).toContain('const reactivated = reactivateJarvisInput()');
    expect(source).toContain('reactivateJarvisInput();');
  });
});

describe('queued narrations', () => {
  it('queues report-backs and retries them when the voice returns to idle', () => {
    expect(source).toContain('new NarrationQueue');
    expect(source).toContain('workNarrationSupervisor.accept(event');
    expect(source).toContain('narrationQueue.enqueue(event.text)');
    expect(source).toContain("if (state.status === 'idle' && !isJarvisNarrationHalted())");
    expect(source).toContain('narrationQueue.kick()');
    expect(source).not.toContain('narração pulada (ocupado)');
  });
});
