import { useEffect, useId, useRef, useState } from 'react';
import type { NarrationAlignView } from '../../shared/video-studio-types';
import { VoiceSampleRecorder, type VoiceSample } from '../voice/voice-sample-recorder';

/**
 * "Gravar narração" (F-1602): a pessoa lê o roteiro com a própria voz, sem
 * voz sintética nem clone. O Nexus guarda a gravação em <projeto>/assets e
 * alinha o roteiro ao áudio (ElevenLabs ou no computador), gerando a mesma
 * linha do tempo e as legendas da narração gerada.
 */

export const NARRATION_MAX_SEC = 10 * 60;

type Phase = 'idle' | 'recording' | 'recorded' | 'aligning';

function seconds(value: number): string {
  const total = Math.round(value);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function NarrationRecorder({ projectPath, onDone }: { projectPath: string; onDone: () => void }) {
  const scriptId = useId();
  const recorder = useRef<VoiceSampleRecorder | null>(null);
  const [script, setScript] = useState('');
  const [engine, setEngine] = useState<'elevenlabs' | 'local'>('elevenlabs');
  const [phase, setPhase] = useState<Phase>('idle');
  const [level, setLevel] = useState(0);
  const [sample, setSample] = useState<VoiceSample | null>(null);
  const [savedAudio, setSavedAudio] = useState<string | null>(null);
  const [askDownload, setAskDownload] = useState(false);
  const [result, setResult] = useState<NarrationAlignView | null>(null);

  useEffect(() => () => recorder.current?.cancel(), []);

  async function start() {
    setResult(null);
    setSample(null);
    setSavedAudio(null);
    const next = new VoiceSampleRecorder();
    next.onLevel = setLevel;
    recorder.current = next;
    try {
      await next.start(NARRATION_MAX_SEC, () => void stop());
      setPhase('recording');
    } catch {
      setResult({ ok: false, error: 'Não consegui abrir o microfone. Confira a permissão e o dispositivo de entrada.' });
    }
  }

  async function stop() {
    const current = recorder.current;
    if (!current) return;
    const recorded = await current.stop();
    setLevel(0);
    if (recorded.peakRms < 0.003) {
      setPhase('idle');
      setResult({ ok: false, error: 'A gravação ficou em silêncio. Confira o microfone e grave de novo.' });
      return;
    }
    setSample(recorded);
    setPhase('recorded');
  }

  async function align(allowModelDownload = false) {
    if (!sample && !savedAudio) return;
    setPhase('aligning');
    setAskDownload(false);
    try {
      const view = await window.nexus.videoStudio.alignRecording({
        projectPath,
        script,
        engine,
        ...(savedAudio ? { audioPath: savedAudio } : { wav: sample!.wav }),
        ...(allowModelDownload ? { allowModelDownload: true } : {}),
      });
      if (view.audioPath) setSavedAudio(view.audioPath);
      setResult(view);
      if (!view.ok && view.needsModelDownload) setAskDownload(true);
      if (view.ok) onDone();
    } catch {
      setResult({ ok: false, error: 'O alinhamento não respondeu. Tente de novo.' });
    } finally {
      setPhase((current) => (current === 'aligning' ? 'recorded' : current));
    }
  }

  const canAlign = script.trim().length > 0 && (sample !== null || savedAudio !== null) && phase !== 'aligning';

  return (
    <div className="vp-brief" role="group" aria-label="Gravar narração">
      <label className="ms-field" htmlFor={scriptId}>
        <span className="ms-field__label">Roteiro que você vai ler</span>
        <textarea
          id={scriptId}
          className="ms-prompt"
          rows={4}
          value={script}
          placeholder="Um parágrafo por cena. A legenda usa exatamente estas palavras."
          onChange={(event) => setScript(event.target.value)}
        />
      </label>
      <div className="vp-actions">
        {phase === 'recording' ? (
          <>
            <div className="vp-progress__bar" role="meter" aria-label="Nível do microfone" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
              <span className="vp-progress__fill" style={{ transform: `scaleX(${Math.max(0.02, level)})` }} />
            </div>
            <button type="button" className="ms-button ms-button--primary" onClick={() => void stop()}>
              Parar
            </button>
          </>
        ) : (
          <button type="button" className="ms-button" disabled={phase === 'aligning'} onClick={() => void start()}>
            {sample ? 'Gravar de novo' : 'Gravar'}
          </button>
        )}
        {sample && phase !== 'recording' && <span className="vp-card__meta">Gravado: {seconds(sample.durationSec)}</span>}
        <select
          className="ms-select"
          aria-label="Alinhar com"
          value={engine}
          onChange={(event) => setEngine(event.target.value as 'elevenlabs' | 'local')}
        >
          <option value="elevenlabs">ElevenLabs (US$ 0,22 por hora de áudio)</option>
          <option value="local">No computador (grátis)</option>
        </select>
        <button type="button" className="ms-button ms-button--primary" disabled={!canAlign} onClick={() => void align()}>
          {phase === 'aligning' ? 'Alinhando…' : 'Salvar e alinhar'}
        </button>
      </div>
      {askDownload && (
        <div className="vp-notice" role="alert">
          <p>O alinhamento no computador baixa o modelo de reconhecimento (639 MB, uma vez só).</p>
          <div className="vp-actions">
            <button type="button" className="ms-button ms-button--primary" onClick={() => void align(true)}>
              Baixar e alinhar
            </button>
            <button type="button" className="ms-button" onClick={() => setAskDownload(false)}>
              Agora não
            </button>
          </div>
        </div>
      )}
      {result && !askDownload && (
        <div className={result.ok ? 'vp-notice' : 'vp-notice vp-notice--danger'} role={result.ok ? 'status' : 'alert'}>
          {result.ok ? (
            <>
              <p>
                Narração alinhada: {result.words} palavras, {Math.round(result.matchedRatio * 100)}% reconhecidas
                {result.costUsd > 0 ? `, custo estimado US$ ${result.costUsd.toFixed(4).replace('.', ',')}` : ''}.
              </p>
              <ul>
                {[...result.warnings, ...result.files].map((line) => (
                  <li key={line}>
                    <code>{line}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>{result.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
