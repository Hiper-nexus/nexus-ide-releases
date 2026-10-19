import { useCallback, useEffect, useRef, useState } from 'react';
import {
  VOICE_CONSENT_POINTS,
  VOICE_DECLARATION_MAX_SEC,
  VOICE_SAMPLE_MAX_SEC,
  VOICE_SAMPLE_MIN_SEC,
  voiceDeclarationText,
  type VoiceCloneReceiptView,
  type VoiceCloneSessionView,
} from '../../../shared/voice-clone-types';
import { micErrorMessage } from '../../voice/mic-error-message';
import { VoiceSampleRecorder, type VoiceSample } from '../../voice/voice-sample-recorder';

/**
 * Ajustes → Serviços de mídia → Minha voz (F-1593).
 *
 * The only place a voice is cloned. The person reads what happens to the
 * voice, consents, records a declaration with a code generated now (Main
 * checks it by speech recognition), records the reading, and the voice is
 * created in THEIR ElevenLabs account. Every step can be abandoned; nothing
 * leaves the computer before the declaration is checked.
 */

type Step = 'list' | 'consent' | 'declaration' | 'reading' | 'done';
type Recording = 'idle' | 'recording' | 'checking';

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function useElapsed(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const startedAt = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 250);
    return () => clearInterval(timer);
  }, [running]);
  return elapsed;
}

function LevelMeter({ level }: { level: number }) {
  return (
    <span className="my-voice__meter" aria-hidden="true">
      <span className="my-voice__meter-fill" style={{ transform: `scaleX(${Math.min(1, Math.max(0, level))})` }} />
    </span>
  );
}

function VoiceRow({ receipt, onRemoved }: { receipt: VoiceCloneReceiptView; onRemoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; canRemoveLocally: boolean } | null>(null);

  async function remove(localOnly: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await window.nexus.voiceClone.remove({ id: receipt.id, localOnly });
      if (result.ok) {
        onRemoved();
        return;
      }
      setError({ text: result.error, canRemoveLocally: result.canRemoveLocally });
    } catch {
      setError({ text: 'Não consegui apagar agora. Tente de novo.', canRemoveLocally: false });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <li className="my-voice__item">
      <div className="my-voice__item-head">
        <span className="my-voice__item-name">{receipt.voiceName}</span>
        <span className="my-voice__item-meta">
          ElevenLabs · criada em {formatDate(receipt.createdAt)} · recibo neste computador
        </span>
      </div>
      {receipt.requiresVerification && (
        <p className="settings-detail__hint">
          A ElevenLabs pediu uma verificação extra desta voz no site dela antes do primeiro uso.
        </p>
      )}
      <div className="settings-row my-voice__actions">
        {!confirming ? (
          <button type="button" className="settings-btn" disabled={busy} onClick={() => setConfirming(true)}>
            Apagar minha voz
          </button>
        ) : (
          <>
            <button
              type="button"
              className="settings-btn settings-btn--danger"
              disabled={busy}
              onClick={() => void remove(false)}
            >
              {busy ? 'Apagando…' : 'Apagar na ElevenLabs e aqui'}
            </button>
            <button type="button" className="settings-btn" disabled={busy} onClick={() => setConfirming(false)}>
              Manter
            </button>
          </>
        )}
      </div>
      {error && (
        <div role="alert" className="my-voice__error">
          <p className="settings-error">{error.text}</p>
          {error.canRemoveLocally && (
            <button type="button" className="settings-btn" disabled={busy} onClick={() => void remove(true)}>
              Apagar só deste computador
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * `canCreate` follows the video studio internal key: with it off the card only
 * appears when voices already exist, so they can always be deleted.
 */
export function MyVoiceCard({
  elevenLabsConnected,
  canCreate = true,
}: {
  elevenLabsConnected: boolean;
  canCreate?: boolean;
}) {
  const bridge = typeof window !== 'undefined' ? window.nexus?.voiceClone : undefined;
  const [receipts, setReceipts] = useState<VoiceCloneReceiptView[]>([]);
  const [step, setStep] = useState<Step>('list');
  const [session, setSession] = useState<VoiceCloneSessionView | null>(null);
  const [speakerName, setSpeakerName] = useState('');
  const [consented, setConsented] = useState(false);
  const [ownVoiceAdult, setOwnVoiceAdult] = useState(false);
  const [recording, setRecording] = useState<Recording>('idle');
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [reading, setReading] = useState<VoiceSample | null>(null);
  const [voiceName, setVoiceName] = useState('');
  const [creating, setCreating] = useState(false);
  const recorder = useRef<VoiceSampleRecorder | null>(null);
  const elapsed = useElapsed(recording === 'recording');

  const reload = useCallback(async () => {
    if (!bridge) return;
    try {
      setReceipts(await bridge.list());
    } catch {
      setReceipts([]);
    }
  }, [bridge]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(
    () => () => {
      recorder.current?.cancel();
    },
    [],
  );

  if (!bridge) return null;

  function resetFlow() {
    recorder.current?.cancel();
    recorder.current = null;
    if (session) void bridge!.cancel(session.sessionId);
    setSession(null);
    setStep('list');
    setConsented(false);
    setOwnVoiceAdult(false);
    setRecording('idle');
    setReading(null);
    setMessage(null);
  }

  async function beginConsent() {
    setMessage(null);
    const started = await bridge!.begin();
    if ('ok' in started) {
      setMessage({ tone: 'danger', text: started.error });
      return;
    }
    setSession(started);
    setStep('declaration');
    const first = speakerName.trim().split(/\s+/u)[0] ?? '';
    setVoiceName((current) => current || (first ? `Voz de ${first}` : 'Minha voz'));
  }

  async function startRecording(maxSec: number, onStop: () => void) {
    setMessage(null);
    const next = new VoiceSampleRecorder();
    next.onLevel = setLevel;
    recorder.current = next;
    try {
      await next.start(maxSec, onStop);
      setRecording('recording');
    } catch (error) {
      recorder.current = null;
      setMessage({ tone: 'danger', text: micErrorMessage(error, window.nexus?.platform ?? '') });
    }
  }

  async function stopDeclaration() {
    const active = recorder.current;
    if (!active || !session) return;
    recorder.current = null;
    setRecording('checking');
    const sample = await active.stop();
    if (sample.peakRms < 0.003) {
      setRecording('idle');
      setMessage({ tone: 'danger', text: 'O microfone gravou silêncio. Confira o microfone e grave de novo.' });
      return;
    }
    try {
      const result = await bridge!.verifyDeclaration({
        sessionId: session.sessionId,
        speakerName,
        wav: sample.wav,
      });
      if (result.ok) {
        setMessage({ tone: 'ok', text: 'Declaração conferida.' });
        setStep('reading');
      } else {
        setMessage({ tone: 'danger', text: result.error });
      }
    } catch {
      setMessage({ tone: 'danger', text: 'Não consegui conferir a declaração agora. Tente de novo.' });
    } finally {
      setRecording('idle');
    }
  }

  async function stopReading() {
    const active = recorder.current;
    if (!active) return;
    recorder.current = null;
    const sample = await active.stop();
    setRecording('idle');
    if (sample.peakRms < 0.003) {
      setReading(null);
      setMessage({ tone: 'danger', text: 'O microfone gravou silêncio. Confira o microfone e grave de novo.' });
      return;
    }
    setReading(sample);
    setMessage(
      sample.durationSec < VOICE_SAMPLE_MIN_SEC
        ? {
            tone: 'danger',
            text: `A leitura teve ${formatSeconds(sample.durationSec)}; precisa de pelo menos ${formatSeconds(VOICE_SAMPLE_MIN_SEC)}. Grave de novo, sem pressa.`,
          }
        : null,
    );
  }

  async function createVoice() {
    if (!session || !reading) return;
    setCreating(true);
    setMessage(null);
    try {
      const result = await bridge!.create({
        sessionId: session.sessionId,
        voiceName,
        samples: [reading.wav],
      });
      if (!result.ok) {
        setMessage({ tone: 'danger', text: result.error });
        return;
      }
      setSession(null);
      setReading(null);
      setStep('done');
      setMessage({
        tone: 'ok',
        text: `Voz "${result.receipt.voiceName}" criada na sua conta da ElevenLabs. Os agentes a veem em nexus_voice_list; peça o vídeo dizendo que é para usar a sua voz.`,
      });
      await reload();
    } catch {
      setMessage({ tone: 'danger', text: 'Não consegui criar a voz agora. Tente de novo.' });
    } finally {
      setCreating(false);
    }
  }

  const declaration = session ? voiceDeclarationText(speakerName, session.code) : '';
  const readingOk = reading !== null && reading.durationSec >= VOICE_SAMPLE_MIN_SEC;

  if (!canCreate && receipts.length === 0) return null;

  return (
    <section className="media-card my-voice" aria-labelledby="my-voice-title">
      <header className="my-voice__head">
        <h3 id="my-voice-title" className="arsenal-media-card__name">
          Minha voz
        </h3>
        <p className="settings-detail__hint">
          Crie uma voz sintética sua para narrar vídeos de apresentação. Só você cria, gravando agora; os
          agentes só usam a voz que você indicar.
        </p>
      </header>

      {receipts.length > 0 && (
        <ul className="my-voice__list" aria-label="Vozes criadas">
          {receipts.map((receipt) => (
            <VoiceRow key={receipt.id} receipt={receipt} onRemoved={() => void reload()} />
          ))}
        </ul>
      )}

      {!canCreate && (
        <p className="settings-detail__hint">
          O estúdio de vídeo está desligado em Ajustes → Experimental. Você ainda pode apagar as suas vozes.
        </p>
      )}

      {canCreate && step === 'list' && (
        <div className="settings-row">
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            disabled={!elevenLabsConnected}
            onClick={() => {
              setMessage(null);
              setStep('consent');
            }}
          >
            Criar minha voz
          </button>
          {!elevenLabsConnected && (
            <span className="settings-detail__hint">Conecte a ElevenLabs acima para criar a sua voz.</span>
          )}
        </div>
      )}

      {step === 'consent' && (
        <div className="my-voice__step" role="group" aria-label="Consentimento">
          <p className="my-voice__step-title">Antes de gravar</p>
          <ul className="my-voice__points">
            {VOICE_CONSENT_POINTS.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <label className="my-voice__field">
            <span>Seu nome completo, como vai falar na declaração</span>
            <input
              className="settings-input"
              value={speakerName}
              maxLength={80}
              autoComplete="name"
              onChange={(event) => setSpeakerName(event.target.value)}
            />
          </label>
          <label className="my-voice__check">
            <input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} />
            <span>
              Autorizo o tratamento da minha voz, dado biométrico, para criar uma voz sintética minha na minha
              conta da ElevenLabs, só para narrar os meus vídeos.
            </span>
          </label>
          <label className="my-voice__check">
            <input type="checkbox" checked={ownVoiceAdult} onChange={(event) => setOwnVoiceAdult(event.target.checked)} />
            <span>Sou maior de 18 anos e a voz que vou gravar é a minha.</span>
          </label>
          <div className="settings-row">
            <button
              type="button"
              className="settings-btn settings-btn--primary"
              disabled={!consented || !ownVoiceAdult || speakerName.trim().length < 2}
              onClick={() => void beginConsent()}
            >
              Continuar
            </button>
            <button type="button" className="settings-btn" onClick={resetFlow}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {step === 'declaration' && session && (
        <div className="my-voice__step" role="group" aria-label="Declaração gravada">
          <p className="my-voice__step-title">1 de 2 · Leia em voz alta, devagar, número por número</p>
          <blockquote className="my-voice__script">{declaration}</blockquote>
          <div className="settings-row">
            {recording === 'recording' ? (
              <button type="button" className="settings-btn settings-btn--primary" onClick={() => void stopDeclaration()}>
                Parar e conferir ({formatSeconds(elapsed)})
              </button>
            ) : (
              <button
                type="button"
                className="settings-btn settings-btn--primary"
                disabled={recording === 'checking'}
                onClick={() => void startRecording(VOICE_DECLARATION_MAX_SEC, () => void stopDeclaration())}
              >
                {recording === 'checking' ? 'Conferindo…' : 'Gravar declaração'}
              </button>
            )}
            {recording === 'recording' && <LevelMeter level={level} />}
            <button type="button" className="settings-btn" onClick={resetFlow}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {step === 'reading' && session && (
        <div className="my-voice__step" role="group" aria-label="Leitura para a voz">
          <p className="my-voice__step-title">
            2 de 2 · Leia o texto no seu ritmo natural ({formatSeconds(VOICE_SAMPLE_MIN_SEC)} a{' '}
            {formatSeconds(VOICE_SAMPLE_MAX_SEC)}, em lugar silencioso)
          </p>
          <blockquote className="my-voice__script my-voice__script--long">{session.readingText}</blockquote>
          <div className="settings-row">
            {recording === 'recording' ? (
              <button type="button" className="settings-btn settings-btn--primary" onClick={() => void stopReading()}>
                Parar ({formatSeconds(elapsed)})
              </button>
            ) : (
              <button
                type="button"
                className="settings-btn"
                onClick={() => void startRecording(VOICE_SAMPLE_MAX_SEC, () => void stopReading())}
              >
                {reading ? 'Gravar de novo' : 'Gravar leitura'}
              </button>
            )}
            {recording === 'recording' && <LevelMeter level={level} />}
            {reading && recording === 'idle' && (
              <span className="settings-detail__hint">Gravado: {formatSeconds(reading.durationSec)}</span>
            )}
          </div>
          <label className="my-voice__field">
            <span>Nome da voz na ElevenLabs</span>
            <input
              className="settings-input"
              value={voiceName}
              maxLength={60}
              onChange={(event) => setVoiceName(event.target.value)}
            />
          </label>
          <div className="settings-row">
            <button
              type="button"
              className="settings-btn settings-btn--primary"
              disabled={!readingOk || creating || recording !== 'idle' || voiceName.trim().length < 2}
              onClick={() => void createVoice()}
            >
              {creating ? 'Criando…' : 'Criar a voz na ElevenLabs'}
            </button>
            <button type="button" className="settings-btn" disabled={creating} onClick={resetFlow}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="settings-row">
          <button type="button" className="settings-btn" onClick={() => setStep('list')}>
            Fechar
          </button>
        </div>
      )}

      {message && (
        <p
          className={`prov__status media-key__status media-key__status--${message.tone}`}
          role={message.tone === 'danger' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
