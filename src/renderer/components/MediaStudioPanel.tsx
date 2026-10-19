import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  MediaArtifactInfo,
  MediaGenerationResult,
  MediaProviderInfo,
  MediaStudioRequest,
} from '../../shared/media-types';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { CloseButton } from './CloseButton';
import { PixelIcon } from './PixelIcon';
import { platformCopy } from '../lib/platform-copy';

/**
 * Estúdio de Mídia — geração de imagem/vídeo para quem não fala com agente:
 * descreve o que quer, escolhe o modelo, clica em Gerar. As API keys ficam em
 * Ajustes → Mídia; aqui só aparecem providers já configurados (hasKey).
 */

type StudioKind = 'image' | 'video';

const ASPECTS: Record<StudioKind, string[]> = {
  image: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  video: ['16:9', '9:16'],
};

const EXAMPLES: Record<StudioKind, string[]> = {
  image: [
    'Um gato astronauta em aquarela',
    'Logo minimalista para cafeteria',
    'Pôr do sol synthwave sobre montanhas',
  ],
  video: [
    'Drone sobrevoando praia ao pôr do sol',
    'Timelapse de uma cidade à noite',
  ],
};

const PLACEHOLDER: Record<StudioKind, string> = {
  image: 'Descreva a imagem que você quer criar…',
  video: 'Descreva a cena do vídeo que você quer criar…',
};

const KIND_PT: Record<string, string> = {
  image: 'imagem',
  video: 'vídeo',
  audio: 'áudio',
};

function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

/** Junta provider+modelo num valor único para o <select> (optgroup por provider). */
function selValue(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}

interface StudioResult {
  res: MediaGenerationResult;
  /** storageKey do artifact mais recente do mesmo kind (para reveal/preview). */
  storageKey: string | null;
  dataUrl: string | null;
}

interface StudioError {
  message: string;
  recoverJobId?: string;
  /** Request original — "Retomar sem pagar de novo" repete com recoverJobId. */
  request: MediaStudioRequest;
}

export function MediaStudioPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const copy = platformCopy();
  const [tab, setTab] = useState<StudioKind>('image');
  const [providers, setProviders] = useState<MediaProviderInfo[] | null>(null);
  const [prompt, setPrompt] = useState('');
  const [sel, setSel] = useState('');
  const [aspect, setAspect] = useState('16:9');
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState('720p');
  const [job, setJob] = useState<{ clientJobId: string; startedAt: number } | null>(
    null,
  );
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<StudioResult | null>(null);
  const [error, setError] = useState<StudioError | null>(null);
  const [artifacts, setArtifacts] = useState<MediaArtifactInfo[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  // storageKeys com fetch de thumb já tentado — não re-dispara em falha.
  const thumbTried = useRef(new Set<string>());
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const ofKind = useMemo(
    () => (providers ?? []).filter((p) => p.kind === tab),
    [providers, tab],
  );
  const keyed = useMemo(() => ofKind.filter((p) => p.hasKey), [ofKind]);

  useEffect(() => {
    if (!open) {
      const restoreTarget = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restoreTarget?.isConnected) restoreTarget.focus();
      return;
    }

    if (
      restoreFocusRef.current === null &&
      document.activeElement instanceof HTMLElement &&
      !dialogRef.current?.contains(document.activeElement)
    ) {
      restoreFocusRef.current = document.activeElement;
    }

    const initialFocus = dialogRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    initialFocus?.focus();
  }, [open]);

  useEffect(
    () => () => {
      const restoreTarget = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restoreTarget?.isConnected) restoreTarget.focus();
    },
    [],
  );

  // Carrega providers + galeria ao abrir (e recarrega a cada abertura).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all([
      window.nexus.media.listProviders(),
      window.nexus.media.listArtifacts(),
    ]).then(([list, arts]) => {
      if (cancelled) return;
      setProviders(list);
      setArtifacts(arts);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Seleção default: primeiro provider COM key do kind ativo + seu defaultModel.
  // Re-reseta quando a aba/providers mudam e a seleção atual não é mais válida.
  useEffect(() => {
    if (!providers) return;
    const [pid, model] = sel.split('::');
    const current = keyed.find((p) => p.id === pid);
    if (current && current.models.includes(model)) return;
    const first = keyed[0];
    setSel(first ? selValue(first.id, first.defaultModel) : '');
  }, [providers, keyed, sel]);

  // Proporção default por aba (vídeo não tem 1:1 etc.).
  useEffect(() => {
    if (!ASPECTS[tab].includes(aspect)) setAspect('16:9');
  }, [tab, aspect]);

  // Cronômetro de espera — anda 1x/s enquanto a geração não resolve.
  useEffect(() => {
    if (!job) return;
    const t = setInterval(
      () => setElapsed(Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000))),
      1000,
    );
    return () => clearInterval(t);
  }, [job]);

  // Thumbs lazy: só imagens, uma tentativa por storageKey.
  useEffect(() => {
    const pending = artifacts.filter(
      (a) =>
        a.kind === 'image' && !thumbs[a.storageKey] && !thumbTried.current.has(a.storageKey),
    );
    if (pending.length === 0) return;
    let cancelled = false;
    for (const a of pending) thumbTried.current.add(a.storageKey);
    void Promise.all(
      pending.map(async (a) => {
        const r = await window.nexus.media.readArtifactDataUrl(a.storageKey);
        const dataUrl = r.ok ? r.dataUrl : undefined;
        if (!cancelled && dataUrl) {
          setThumbs((t) => ({ ...t, [a.storageKey]: dataUrl }));
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [artifacts, thumbs]);

  if (!open) return null;

  async function run(request: MediaStudioRequest) {
    setJob({ clientJobId: request.clientJobId, startedAt: Date.now() });
    setElapsed(0);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const res = await window.nexus.media.generate(request);
      if (res.ok) {        // Sucesso: recarrega a galeria e usa o artifact mais novo do kind
        // (a lista vem newest-first) para preview + "Mostrar no Finder".
        const arts = await window.nexus.media.listArtifacts();
        setArtifacts(arts);
        const newest = arts.find((a) => a.kind === res.kind) ?? null;
        let dataUrl: string | null = null;
        if (newest) {
          const d = await window.nexus.media.readArtifactDataUrl(newest.storageKey);
          if (d.ok && d.dataUrl) {
            dataUrl = d.dataUrl;
            thumbTried.current.add(newest.storageKey);
            setThumbs((t) => ({ ...t, [newest.storageKey]: d.dataUrl! }));
          }
        }
        setResult({ res, storageKey: newest?.storageKey ?? null, dataUrl });
      } else if (!res.canceled) {
        // Cancelamento é ação do usuário — não vira card de erro.
        setError({ message: res.error, recoverJobId: res.recoverJobId, request });
      }
    } catch (e) {
      setError({
        message: e instanceof Error ? e.message : String(e),
        request,
      });
    } finally {
      setJob(null);
    }
  }

  function generate() {
    const [pid, model] = sel.split('::');
    const provider = keyed.find((p) => p.id === pid);
    if (!provider || !prompt.trim() || job) return;
    void run({
      kind: tab,
      prompt: prompt.trim(),
      providerId: provider.id,
      model,
      aspectRatio: aspect,
      ...(tab === 'video' ? { durationSeconds: duration, resolution } : {}),
      clientJobId: crypto.randomUUID(),
    });
  }

  function resume() {
    if (!error?.recoverJobId || job) return;
    void run({
      ...error.request,
      recoverJobId: error.recoverJobId,
      clientJobId: crypto.randomUUID(),
    });
  }

  function cancel() {
    if (!job) return;
    void window.nexus.media.cancelGenerate(job.clientJobId);
  }

  function copyPath() {
    if (!result) return;
    void navigator.clipboard.writeText(result.res.path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  function openMediaSettings() {
    restoreFocusRef.current = null;
    onClose();
    useProductNavigationStore.getState().openSettings('media');
  }

  const selProvider = providers?.find((p) => p.id === result?.res.provider);

  return (
    <div
      className="ms-scrim overlay-scrim-glass overlay-scrim-enter"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="ms-panel overlay-enter"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== 'Tab') return;

          event.preventDefault();
          event.stopPropagation();
          const focusables = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
            ),
          ).filter(
            (element) => element.getAttribute('aria-hidden') !== 'true',
          );
          if (focusables.length === 0) {
            event.currentTarget.focus();
            return;
          }
          const currentIndex = focusables.indexOf(
            document.activeElement as HTMLElement,
          );
          const nextIndex = event.shiftKey
            ? currentIndex <= 0
              ? focusables.length - 1
              : currentIndex - 1
            : (currentIndex + 1) % focusables.length;
          focusables[nextIndex]?.focus();
        }}
      >
        <header className="ms-panel__head">
          <div className="ms-head">
            <strong id={titleId}>Estúdio de Mídia</strong>
            <span id={descriptionId} className="ms-subtitle">
              Crie imagens e vídeos com IA. Descreva o que você quer e clique em
              Gerar.
            </span>
          </div>
          <CloseButton onClick={onClose} label="Fechar Estúdio de Mídia" />
        </header>

        <div className="ms-panel__body">
          <div className="ms-tabs" role="tablist" aria-label="Tipo de mídia">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'image'}
              className={tab === 'image' ? 'ms-tab ms-tab--active' : 'ms-tab'}
              onClick={() => setTab('image')}
            >
              Imagem
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'video'}
              className={tab === 'video' ? 'ms-tab ms-tab--active' : 'ms-tab'}
              onClick={() => setTab('video')}
            >
              Vídeo
            </button>
          </div>

          {providers !== null && keyed.length === 0 ? (
            <section className="ms-empty">
              <p className="ms-empty__title">
                Nenhum provider de {KIND_PT[tab]} configurado
              </p>
              <p className="ms-dim">
                Para gerar {KIND_PT[tab]}, conecte uma API key em Ajustes → Mídia.
                Leva menos de um minuto.
              </p>
              <button
                type="button"
                className="ms-button ms-button--primary ms-empty__cta"
                onClick={openMediaSettings}
              >
                Configurar API key
              </button>
            </section>
          ) : (
            <section className="ms-form">
              <textarea
                className="ms-prompt"
                rows={3}
                placeholder={PLACEHOLDER[tab]}
                value={prompt}
                disabled={Boolean(job)}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <div className="ms-chips">
                {EXAMPLES[tab].map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    className="ms-chip ms-chip--example"
                    onClick={() => setPrompt(ex)}
                  >
                    {ex}
                  </button>
                ))}
              </div>

              <div className="ms-fields">
                <label className="ms-field">
                  <span className="ms-field__label">Modelo</span>
                  <select
                    className="ms-select"
                    value={sel}
                    onChange={(e) => setSel(e.target.value)}
                  >
                    {ofKind.map((p) => (
                      <optgroup
                        key={p.id}
                        label={
                          p.hasKey
                            ? p.label
                            : `${p.label} — sem key (Ajustes → Mídia)`
                        }
                      >
                        {p.models.map((m) => (
                          <option
                            key={m}
                            value={selValue(p.id, m)}
                            disabled={!p.hasKey}
                          >
                            {m}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>

                <div className="ms-field">
                  <span className="ms-field__label">Proporção</span>
                  <div className="ms-chips" role="group" aria-label="Proporção">
                    {ASPECTS[tab].map((a) => (
                      <button
                        key={a}
                        type="button"
                        aria-pressed={a === aspect}
                        className={a === aspect ? 'ms-chip ms-chip--on' : 'ms-chip'}
                        onClick={() => setAspect(a)}
                      >
                        {a}
                      </button>
                    ))}
                  </div>
                </div>

                {tab === 'video' && (
                  <>
                    <label className="ms-field">
                      <span className="ms-field__label">Duração: {duration}s</span>
                      <input
                        type="range"
                        className="ms-range"
                        min={2}
                        max={12}
                        step={1}
                        value={duration}
                        onChange={(e) => setDuration(Number(e.target.value))}
                      />
                    </label>
                    <label className="ms-field">
                      <span className="ms-field__label">Resolução</span>
                      <select
                        className="ms-select"
                        value={resolution}
                        onChange={(e) => setResolution(e.target.value)}
                      >
                        <option value="720p">720p</option>
                        <option value="1080p">1080p</option>
                      </select>
                    </label>
                  </>
                )}
              </div>

              <button
                type="button"
                className="ms-button ms-button--primary ms-generate"
                disabled={!prompt.trim() || Boolean(job) || !sel}
                onClick={generate}
              >
                {tab === 'image' ? 'Gerar imagem' : 'Gerar vídeo'}
              </button>
            </section>
          )}

          {job && (
            <section className="ms-progress" role="status">
              <span className="ms-spinner" aria-hidden="true" />
              <div className="ms-progress__copy">
                <strong>
                  {tab === 'image'
                    ? 'Gerando sua imagem… leva alguns segundos'
                    : 'Gerando vídeo… pode levar alguns minutos. Você pode cancelar.'}
                </strong>
                <span className="ms-dim">{elapsed}s decorridos</span>
              </div>
              <button
                type="button"
                className="ms-button ms-button--sm"
                onClick={cancel}
              >
                Cancelar
              </button>
            </section>
          )}

          {result && (
            <section className="ms-result">
              <div className="ms-result__preview">
                {result.dataUrl && result.res.kind === 'image' && (
                  <img
                    src={result.dataUrl}
                    alt={basename(result.storageKey ?? result.res.path)}
                  />
                )}
                {result.dataUrl && result.res.kind === 'video' && (
                  <video src={result.dataUrl} controls />
                )}
                {!result.dataUrl && (
                  <div className="ms-tile">
                    <PixelIcon name="vision" size={22} />
                    <span>{basename(result.storageKey ?? result.res.path)}</span>
                  </div>
                )}
              </div>
              <div className="ms-result__meta">
                <strong className="ms-result__name">
                  {basename(result.storageKey ?? result.res.path)}
                </strong>
                <span className="ms-dim">
                  {selProvider?.label ?? result.res.provider} · {result.res.model}
                </span>
                <span className="ms-dim">
                  Custo estimado:{' '}
                  {result.res.estimatedCostUsd !== null
                    ? formatUsd(result.res.estimatedCostUsd)
                    : '—'}
                </span>
                <div className="ms-result__actions">
                  <button
                    type="button"
                    className="ms-button ms-button--sm"
                    disabled={!result.storageKey}
                    onClick={() => {
                      if (result.storageKey) {
                        void window.nexus.media.revealArtifact(result.storageKey);
                      }
                    }}
                  >
                    {copy.revealInFileManager}
                  </button>
                  <button
                    type="button"
                    className="ms-button ms-button--sm"
                    onClick={copyPath}
                  >
                    {copied ? 'Copiado!' : 'Copiar caminho'}
                  </button>
                </div>
              </div>
            </section>
          )}

          {error && (
            <section className="ms-error" role="alert">
              <p className="ms-error__msg"><PixelIcon name="warn" size={11} /> {error.message}</p>
              {error.recoverJobId && (
                <button
                  type="button"
                  className="ms-button ms-button--sm ms-button--primary"
                  onClick={resume}
                >
                  Retomar sem pagar de novo
                </button>
              )}
            </section>
          )}

          <section className="ms-gallery">
            <h4 className="ms-gallery__title">Suas criações</h4>
            {artifacts.length === 0 ? (
              <p className="ms-dim">Suas criações aparecerão aqui.</p>
            ) : (
              <div className="ms-grid">
                {artifacts.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="ms-card"
                    title={copy.revealInFileManager}
                    onClick={() => void window.nexus.media.revealArtifact(a.storageKey)}
                  >
                    <span className="ms-card__thumb">
                      {a.kind === 'image' && thumbs[a.storageKey] ? (
                        <img src={thumbs[a.storageKey]} alt="" loading="lazy" />
                      ) : (
                        <PixelIcon
                          name={
                            a.kind === 'video'
                              ? 'mission'
                              : a.kind === 'audio'
                                ? 'mic'
                                : 'vision'
                          }
                          size={20}
                        />
                      )}
                    </span>
                    <span className="ms-card__name">{basename(a.storageKey)}</span>
                    <span className="ms-card__meta">
                      <span className="ms-badge">{KIND_PT[a.kind] ?? a.kind}</span>
                      {a.costUsd !== null && <span>{formatUsd(a.costUsd)}</span>}
                      <span>{new Date(a.createdAt).toLocaleDateString('pt-BR')}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
