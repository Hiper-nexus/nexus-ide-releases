import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  MEDIA_NO_PROJECT_ERROR,
  type MediaArtifactInfo,
  type MediaErrorKind,
  type MediaGenerationResult,
  type MediaProviderInfo,
  type MediaStudioRequest,
} from '../../shared/media-types';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { CloseButton } from './CloseButton';
import { PixelIcon } from './PixelIcon';
import { platformCopy } from '../lib/platform-copy';
import { MediaReferencesPicker } from './MediaReferencesPicker';
import {
  IMAGE_ASPECTS,
  firstUsableModel,
  studioCostUsd,
  studioModelBlock,
  studioNeedsImage,
  studioReferencePlan,
  studioReferenceRequest,
  studioRetirementNotice,
  studioVideoChoices,
  studioVideoPerSecondUsd,
  type StudioKind,
} from './media-studio-options';

/**
 * Estúdio de Mídia — geração de imagem/vídeo para quem não fala com agente:
 * descreve o que quer, escolhe o modelo, clica em Gerar. As chaves ficam em
 * Ajustes → Serviços de mídia; aqui só geram os serviços conectados (hasKey).
 * Geração e galeria são da pasta do projeto aberto (F-1589).
 */

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

/** `8.042` → `8 s de vídeo`; `6.5` → `6,5 s de vídeo`. */
function formatSeconds(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  return `${String(rounded).replace('.', ',')} s de vídeo`;
}

function basename(p: string): string {
  // O caminho absoluto do resultado usa \ no Windows.
  return p.split(/[\\/]/u).filter(Boolean).pop() ?? p;
}

/** Junta provider+modelo num valor único para o <select> (optgroup por provider). */
function selValue(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}

interface StudioResult {
  res: MediaGenerationResult;
  /** storageKey do artifact deste resultado (para reveal/preview); F-1586. */
  storageKey: string | null;
  dataUrl: string | null;
}

interface StudioError {
  message: string;
  /** F-1584: chave recusada ou ausente ganha o atalho para Serviços de mídia. */
  kind?: MediaErrorKind;
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
  // F-1589: `null` = ainda lendo; false = sem projeto aberto.
  const [projectOpen, setProjectOpen] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  // F-1611: referências escolhidas, na ordem (a 1ª tem papel próprio).
  const [refsSelected, setRefsSelected] = useState<string[]>([]);
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

  // Carrega providers e galeria ao abrir (e recarrega a cada abertura). São
  // leituras independentes (F-1589): provedores são globais, a galeria é do
  // projeto; uma falhar não pode deixar a outra muda.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadError(null);
    window.nexus.media.listProviders().then(
      (list) => {
        if (!cancelled) setProviders(list);
      },
      () => {
        if (cancelled) return;
        setProviders([]);
        setLoadError('Não foi possível carregar os serviços de mídia. Feche e abra o Estúdio de novo.');
      },
    );
    window.nexus.media.listArtifacts().then(
      (arts) => {
        if (cancelled) return;
        setProjectOpen(arts !== null);
        setArtifacts(arts ?? []);
      },
      () => {
        if (!cancelled) setArtifacts([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Seleção default: primeiro provider COM key do kind ativo + seu defaultModel.
  // Re-reseta quando a aba/providers mudam e a seleção atual não é mais válida.
  // F-1585: modelo que não gera pelo Estúdio (desligado, precisa de imagem
  // inicial) nunca é o padrão.
  useEffect(() => {
    if (!providers) return;
    const [pid, model] = sel.split('::');
    const current = keyed.find((p) => p.id === pid);
    if (current && current.models.includes(model) && studioModelBlock(model) === null) return;
    const first = firstUsableModel(keyed);
    setSel(first ? selValue(first.providerId, first.model) : '');
  }, [providers, keyed, sel]);

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

  // F-1585: as opções de vídeo são as do modelo escolhido (o slider de 2 a
  // 12 s e o 720p/1080p fixos mandavam valores que o Veo, o Hailuo e o Sora
  // recusam); o custo de lista aparece antes de gerar.
  const [selProviderId, selModel = ''] = sel.split('::');
  const selectedProvider = keyed.find((p) => p.id === selProviderId);
  const video =
    tab === 'video' && selModel
      ? studioVideoChoices(selModel, { aspect, resolution, duration })
      : null;
  const aspectChoices = tab === 'image' ? IMAGE_ASPECTS : (video?.aspects ?? []);
  const effectiveAspect =
    tab === 'image' ? (IMAGE_ASPECTS.includes(aspect) ? aspect : '16:9') : video?.aspect;
  const costUsd = selModel
    ? studioCostUsd(tab, selectedProvider, selModel, video ?? undefined)
    : null;
  // F-1587: o Gemini Omni decide a duração; antes de gerar só há a taxa.
  const perSecondUsd =
    tab === 'video' && selModel ? studioVideoPerSecondUsd(selModel, video ?? undefined) : null;
  const retirementNotice = tab === 'video' && selModel ? studioRetirementNotice(selModel) : null;
  const refPlan = selectedProvider && selModel ? studioReferencePlan(tab, selectedProvider.id, selModel) : null;
  // Image-to-video (Kling 2.1, Wan 2.5 i2v): gera com 1 imagem nas Referências.
  const missingImage =
    tab === 'video' && Boolean(selModel) && studioNeedsImage(selModel) && refsSelected.length !== 1;

  async function run(request: MediaStudioRequest) {
    setJob({ clientJobId: request.clientJobId, startedAt: Date.now() });
    setElapsed(0);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const res = await window.nexus.media.generate(request);
      if (res.ok) {
        // Sucesso: recarrega a galeria e usa o artifact DESTE resultado para a
        // prévia e o "Mostrar no Explorador" (F-1586). "O mais novo do mesmo
        // tipo" podia ser o de um agente que gerou no mesmo projeto ao mesmo
        // tempo. Sem o id, não há prévia — nunca o arquivo de outro.
        const arts = (await window.nexus.media.listArtifacts()) ?? [];
        setArtifacts(arts);
        const newest = res.artifactId
          ? (arts.find((a) => a.id === res.artifactId) ?? null)
          : null;
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
        setError({
          message: res.error,
          kind: res.errorKind,
          recoverJobId: res.recoverJobId,
          request,
        });
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
    if (!provider || !prompt.trim() || job || projectOpen === false || missingImage) return;
    void run({
      kind: tab,
      prompt: prompt.trim(),
      providerId: provider.id,
      model,
      ...studioReferenceRequest(tab, refsSelected),
      ...(effectiveAspect ? { aspectRatio: effectiveAspect } : {}),
      ...(video
        ? {
            ...(video.duration !== undefined ? { durationSeconds: video.duration } : {}),
            ...(video.resolution ? { resolution: video.resolution } : {}),
          }
        : {}),
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
              Crie imagens e vídeos com IA. Descreva o que você quer, traga
              referências (imagem, logo, vídeo de exemplo) e clique em Gerar.
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

          {loadError && (
            <p className="ms-error__msg" role="alert">
              <PixelIcon name="warn" size={11} /> {loadError}
            </p>
          )}
          {projectOpen === false && (
            <p className="ms-dim" role="status">
              {MEDIA_NO_PROJECT_ERROR}
            </p>
          )}
          {providers !== null && keyed.length === 0 && !loadError ? (
            <section className="ms-empty">
              <p className="ms-empty__title">
                Nenhum serviço de {KIND_PT[tab]} conectado
              </p>
              <p className="ms-dim">
                Para gerar {KIND_PT[tab]}, conecte a chave de um serviço em Ajustes →
                Serviços de mídia. Leva menos de um minuto.
              </p>
              <button
                type="button"
                className="ms-button ms-button--primary ms-empty__cta"
                onClick={openMediaSettings}
              >
                Conectar serviço de mídia
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

              {projectOpen !== false && (
                <MediaReferencesPicker
                  maxSelectable={refPlan?.max ?? 0}
                  maxVideos={refPlan?.maxVideos ?? 0}
                  selected={refsSelected}
                  onSelectedChange={setRefsSelected}
                  blockedReason={refPlan?.blocked ?? null}
                  roleHint={refPlan?.hint ?? null}
                  disabled={Boolean(job)}
                />
              )}

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
                            : `${p.label} — sem chave (Serviços de mídia)`
                        }
                      >
                        {p.models.map((m) => {
                          const block = studioModelBlock(m);
                          const note =
                            block ?? (studioNeedsImage(m) ? 'precisa de imagem inicial (escolha em Referências)' : null);
                          return (
                            <option
                              key={m}
                              value={selValue(p.id, m)}
                              disabled={!p.hasKey || block !== null}
                            >
                              {note ? `${m} — ${note}` : m}
                            </option>
                          );
                        })}
                      </optgroup>
                    ))}
                  </select>
                </label>

                {aspectChoices.length > 0 && (
                  <div className="ms-field">
                    <span className="ms-field__label">Proporção</span>
                    <div className="ms-chips" role="group" aria-label="Proporção">
                      {aspectChoices.map((a) => (
                        <button
                          key={a}
                          type="button"
                          aria-pressed={a === effectiveAspect}
                          className={a === effectiveAspect ? 'ms-chip ms-chip--on' : 'ms-chip'}
                          onClick={() => setAspect(a)}
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {video && (
                  <>
                    {video.resolutions.length > 0 && (
                      <div className="ms-field">
                        <span className="ms-field__label">Resolução</span>
                        <div className="ms-chips" role="group" aria-label="Resolução">
                          {video.resolutions.map((r) => (
                            <button
                              key={r}
                              type="button"
                              aria-pressed={r === video.resolution}
                              className={r === video.resolution ? 'ms-chip ms-chip--on' : 'ms-chip'}
                              onClick={() => setResolution(r)}
                            >
                              {r}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {video.duration === undefined ? (
                      <div className="ms-field">
                        <span className="ms-field__label">Duração</span>
                        <span className="ms-dim">O modelo decide quanto o vídeo dura.</span>
                      </div>
                    ) : video.durations.length > 6 ? (
                      <label className="ms-field">
                        <span className="ms-field__label">Duração: {video.duration}s</span>
                        <input
                          type="range"
                          className="ms-range"
                          min={video.durations[0]}
                          max={video.durations.at(-1)}
                          step={1}
                          value={video.duration}
                          onChange={(e) => setDuration(Number(e.target.value))}
                        />
                      </label>
                    ) : (
                      <div className="ms-field">
                        <span className="ms-field__label">Duração</span>
                        <div className="ms-chips" role="group" aria-label="Duração">
                          {video.durations.map((d) => (
                            <button
                              key={d}
                              type="button"
                              aria-pressed={d === video.duration}
                              className={d === video.duration ? 'ms-chip ms-chip--on' : 'ms-chip'}
                              onClick={() => setDuration(d)}
                            >
                              {d}s
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {retirementNotice && (
                <p className="ms-dim" role="note">
                  <PixelIcon name="warn" size={11} /> {retirementNotice}
                </p>
              )}
              {selModel && (
                <p className="ms-dim" aria-live="polite">
                  Custo estimado:{' '}
                  {costUsd !== null
                    ? `${formatUsd(costUsd)} (preço de lista; quem cobra é o serviço)`
                    : perSecondUsd !== null
                      ? `${formatUsd(perSecondUsd)} por segundo de vídeo; o total sai da duração que o modelo escolher (preço de lista; quem cobra é o serviço)`
                      : 'sem preço de lista para esta escolha'}
                </p>
              )}

              {missingImage && (
                <p className="ms-dim" role="note">
                  <PixelIcon name="warn" size={11} /> Este modelo gera a partir de uma imagem:
                  escolha uma em Referências.
                </p>
              )}
              <button
                type="button"
                className="ms-button ms-button--primary ms-generate"
                disabled={!prompt.trim() || Boolean(job) || !sel || projectOpen === false || missingImage}
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
                  {result.res.videoDurationSeconds !== undefined
                    ? ` · ${formatSeconds(result.res.videoDurationSeconds)}`
                    : ''}
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
              {error.kind === 'key' && (
                <button
                  type="button"
                  className="ms-button ms-button--sm"
                  onClick={openMediaSettings}
                >
                  Abrir Serviços de mídia
                </button>
              )}
            </section>
          )}

          <section className="ms-gallery">
            <h4 className="ms-gallery__title">Suas criações</h4>
            {projectOpen === false ? (
              <p className="ms-dim">As criações ficam na pasta de cada projeto. Abra um projeto para vê-las.</p>
            ) : artifacts.length === 0 ? (
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
