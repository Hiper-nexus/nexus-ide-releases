import { useEffect, useState } from 'react';
import { useVoiceStore } from '../voice/voice-store';
import type { ResolvedProvider } from '../../shared/voice-ipc';

/**
 * Minimal voice settings: pick STT/TTS provider, speak mode, routing, and the
 * push-to-talk shortcut. Includes a "Test voice" that speaks a line through the
 * active TTS chain (macOS `say` needs no key) so users can confirm audio works.
 */

function providerOption(p: ResolvedProvider): string {
  const tag = p.available ? '' : ' (unavailable)';
  return `${p.provider}${tag} — ${p.reason}`;
}

export function VoiceSettings() {
  const open = useVoiceStore((s) => s.settingsOpen);
  const info = useVoiceStore((s) => s.info);
  const close = useVoiceStore((s) => s.closeSettings);
  const setInfo = useVoiceStore((s) => s.setInfo);

  const [sttProvider, setSttProvider] = useState('');
  const [ttsProvider, setTtsProvider] = useState('');
  const [speakMode, setSpeakMode] = useState('summary');
  const [routing, setRouting] = useState('focused-pane');
  const [shortcut, setShortcut] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!open || !info) return;
    setSttProvider(info.stt.active?.provider ?? info.stt.chain[0]?.provider ?? '');
    setTtsProvider(info.tts.active?.provider ?? info.tts.chain[0]?.provider ?? '');
    setSpeakMode(info.speakMode);
    setRouting(info.routing);
    setShortcut(info.shortcut);
  }, [open, info]);

  if (!open) return null;

  const save = async () => {
    const next = await window.nexus.voice.setConfig({
      sttProvider,
      ttsProvider,
      speakMode: speakMode as 'summary' | 'full' | 'off',
      routing: routing as 'focused-pane' | 'orchestrator' | 'ask',
      shortcut,
    });
    setInfo(next);
    close();
  };

  const testVoice = async () => {
    setTesting(true);
    try {
      await window.nexus.voice.speak({
        text: 'NexusIDE voice online. Jarvis mode ready.',
        speakMode: 'full',
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="agent-picker" role="dialog" aria-label="Voice settings">
      <div className="agent-picker__overlay" onClick={close} />
      <div className="agent-picker__panel">
        <h3 className="agent-picker__title">Voice · Jarvis Mode</h3>

        {!info ? (
          <p className="agent-picker__empty">Loading voice pipeline…</p>
        ) : (
          <>
            <label className="agent-picker__label">
              Speech-to-Text (translate PT→EN)
              <select
                className="agent-picker__select"
                value={sttProvider}
                onChange={(e) => setSttProvider(e.target.value)}
              >
                {info.stt.chain.map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {providerOption(p)}
                  </option>
                ))}
              </select>
            </label>

            <label className="agent-picker__label">
              Text-to-Speech
              <select
                className="agent-picker__select"
                value={ttsProvider}
                onChange={(e) => setTtsProvider(e.target.value)}
              >
                {info.tts.chain.map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {providerOption(p)}
                  </option>
                ))}
              </select>
            </label>

            <label className="agent-picker__label">
              Speak mode
              <select
                className="agent-picker__select"
                value={speakMode}
                onChange={(e) => setSpeakMode(e.target.value)}
              >
                <option value="summary">summary (1–3 sentences)</option>
                <option value="full">full</option>
                <option value="off">off (dictation only)</option>
              </select>
            </label>

            <label className="agent-picker__label">
              Routing
              <select
                className="agent-picker__select"
                value={routing}
                onChange={(e) => setRouting(e.target.value)}
              >
                <option value="focused-pane">focused pane</option>
                <option value="orchestrator">orchestrator</option>
                <option value="ask">ask</option>
              </select>
            </label>

            <label className="agent-picker__label">
              Push-to-talk shortcut
              <input
                className="agent-picker__select"
                value={shortcut}
                onChange={(e) => setShortcut(e.target.value)}
                spellCheck={false}
              />
            </label>

            <p className="agent-picker__hint">
              Hold {info.shortcut} ({info.hotkeyMode}) to talk. Without an API key,
              speech-to-text needs local whisper.cpp; text-to-speech falls back to
              macOS <code>say</code>.
            </p>

            <div className="agent-picker__actions">
              <button className="agent-picker__btn" onClick={testVoice} disabled={testing}>
                {testing ? 'Speaking…' : 'Test voice'}
              </button>
              <button className="agent-picker__btn" onClick={close}>
                Cancel
              </button>
              <button className="agent-picker__btn agent-picker__btn--primary" onClick={save}>
                Save
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
