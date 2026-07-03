import { useEffect, useState } from 'react';
import { useVoiceStore } from '../voice/voice-store';
import {
  accelFromCode,
  normalizeKeyCode,
} from '../../shared/voice-config';
import type {
  ResolvedProvider,
  VoiceApiKeyStatus,
} from '../../shared/voice-ipc';

/**
 * Minimal voice settings: pick STT/TTS provider, speak mode, routing, and the
 * push-to-talk shortcut. Includes a "Test voice" that speaks a line through the
 * active TTS chain (macOS `say` needs no key) so users can confirm audio works.
 */

function providerOption(p: ResolvedProvider): string {
  const tag = p.available ? '' : ' (unavailable)';
  return `${p.provider}${tag} — ${p.reason}`;
}

function keyStatusText(key: VoiceApiKeyStatus): string {
  if (key.hasStoredKey) return `saved ${key.keyMasked ?? '••••'}`;
  if (key.hasEnv) return 'available from environment';
  if (!key.secureStorageAvailable) return 'Keychain unavailable';
  return 'not set';
}

function keyPlaceholder(key: VoiceApiKeyStatus): string {
  if (key.hasStoredKey) return `Stored ${key.keyMasked ?? 'key'}; paste to replace`;
  if (key.hasEnv) return 'Already set in environment; paste to override';
  return `Paste ${key.envVar}`;
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
  const [triggerKey, setTriggerKey] = useState('Space');
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !info) return;
    setSttProvider(info.stt.active?.provider ?? info.stt.chain[0]?.provider ?? '');
    setTtsProvider(info.tts.active?.provider ?? info.tts.chain[0]?.provider ?? '');
    setSpeakMode(info.speakMode);
    setRouting(info.routing);
    setTriggerKey(info.pushToTalkKeyCode);
    setKeyInputs(
      Object.fromEntries(info.keys.map((key) => [key.envVar, ''])),
    );
    setError(null);
  }, [open, info]);

  if (!open) return null;

  const save = async () => {
    if (!info) return;
    setSaving(true);
    setError(null);
    try {
      for (const key of info.keys) {
        const value = keyInputs[key.envVar]?.trim() ?? '';
        if (!value) continue;
        const result = await window.nexus.voice.setKey({
          envVar: key.envVar,
          key: value,
        });
        if (!result.ok) {
          setError(result.error ?? `Could not save ${key.envVar}`);
          return;
        }
      }
      const normalizedKey = normalizeKeyCode(triggerKey);
      const next = await window.nexus.voice.setConfig({
        sttProvider,
        ttsProvider,
        speakMode: speakMode as 'summary' | 'full' | 'off',
        routing: routing as 'focused-pane' | 'orchestrator' | 'ask',
        shortcut: accelFromCode(normalizedKey),
        pushToTalkKeyCode: normalizedKey,
      });
      setInfo(next);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
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

  const clearKey = async (envVar: string) => {
    setError(null);
    const result = await window.nexus.voice.setKey({ envVar, key: '' });
    if (!result.ok) {
      setError(result.error ?? `Could not clear ${envVar}`);
      return;
    }
    setKeyInputs((prev) => ({ ...prev, [envVar]: '' }));
    setInfo(await window.nexus.voice.getInfo());
  };

  const patchKeyInput = (envVar: string, value: string) => {
    setKeyInputs((prev) => ({ ...prev, [envVar]: value }));
  };

  return (
    <div className="agent-picker" role="dialog" aria-label="Voice settings">
      <div className="agent-picker__overlay" onClick={close} />
      <div className="agent-picker__panel agent-picker__panel--voice">
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

            {info.keys.length > 0 && (
              <section className="voice-settings__section" aria-label="Voice API keys">
                <h4 className="voice-settings__section-title">API keys</h4>
                {info.keys.map((key) => (
                  <div className="voice-settings__key-row" key={key.envVar}>
                    <label className="agent-picker__label voice-settings__key-label">
                      {key.envVar}
                      <input
                        className="agent-picker__select"
                        type="password"
                        value={keyInputs[key.envVar] ?? ''}
                        placeholder={keyPlaceholder(key)}
                        onChange={(e) => patchKeyInput(key.envVar, e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <span className="voice-settings__key-meta">
                        {key.providers.join(' / ')} · {keyStatusText(key)}
                      </span>
                    </label>
                    <button
                      className="agent-picker__btn voice-settings__clear"
                      onClick={() => void clearKey(key.envVar)}
                      disabled={!key.hasStoredKey}
                    >
                      Clear
                    </button>
                  </div>
                ))}
              </section>
            )}

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

            <div className="voice-settings__shortcut-row">
              <label className="agent-picker__label">
                Jarvis trigger key
                <input
                  className="agent-picker__select"
                  value={triggerKey}
                  onChange={(e) => setTriggerKey(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <span className="voice-settings__shortcut-preview">
                {accelFromCode(normalizeKeyCode(triggerKey))}
              </span>
            </div>

            <p className="agent-picker__hint">
              Hold {info.shortcut} ({info.hotkeyMode}) to talk. Jarvis sends the
              transcript to the focused pane and speaks the agent response.
            </p>

            {error && <p className="agent-picker__error">{error}</p>}

            <div className="agent-picker__actions">
              <button className="agent-picker__btn" onClick={testVoice} disabled={testing}>
                {testing ? 'Speaking…' : 'Test voice'}
              </button>
              <button className="agent-picker__btn" onClick={close} disabled={saving}>
                Cancel
              </button>
              <button
                className="agent-picker__btn agent-picker__btn--primary"
                onClick={save}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
