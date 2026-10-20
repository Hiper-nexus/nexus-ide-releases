import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { MediaReferenceInfo } from '../../shared/media-reference-types';
import { PixelIcon } from './PixelIcon';

/**
 * Referências do Estúdio (F-1611): imagens, logos e vídeos de exemplo que a
 * pessoa traz — por Adicionar, arrastando para cá ou colando (⌘V/Ctrl+V).
 * Viram cópias em `media/referencias/` do projeto; a seleção (em ordem) é o
 * que vai para o gerador. A 1ª tem papel próprio (imagem a editar, primeiro
 * quadro), por isso o número no canto.
 */

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml,video/mp4,video/quicktime,video/webm';

export interface MediaReferencesPickerProps {
  /** Quantas referências o modelo escolhido aceita agora (0 = nenhuma). */
  maxSelectable: number;
  selected: readonly string[];
  onSelectedChange: (next: string[]) => void;
  /** Por que não dá para selecionar (modelo sem entrada de imagem, etc.). */
  blockedReason?: string | null;
  /** Uma frase sobre o papel da 1ª e das demais neste modelo. */
  roleHint?: string | null;
  disabled?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/** Só bitmap vai para os modelos; SVG e vídeo ficam na biblioteca do projeto. */
export function referenceSelectable(ref: MediaReferenceInfo): boolean {
  return ref.kind === 'image' && !ref.vector;
}

function unselectableTitle(ref: MediaReferenceInfo): string {
  if (ref.kind === 'video') {
    return 'Vídeo de exemplo: fica no projeto para o vídeo por código e para os agentes; os modelos daqui recebem só imagem.';
  }
  return 'SVG: ótimo de logo no vídeo por código, mas os modelos de imagem e vídeo só aceitam PNG, JPG, WEBP ou GIF.';
}

export function MediaReferencesPicker({
  maxSelectable,
  selected,
  onSelectedChange,
  blockedReason = null,
  roleHint = null,
  disabled = false,
}: MediaReferencesPickerProps) {
  const [refs, setRefs] = useState<MediaReferenceInfo[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tried = useRef(new Set<string>());
  const labelId = useId();

  const reload = useCallback(async () => {
    const list = await window.nexus.mediaReferences.list();
    setRefs(list ?? []);
    return list ?? [];
  }, []);

  useEffect(() => {
    void reload().catch(() => setRefs([]));
  }, [reload]);

  // A seleção só guarda o que ainda existe e cabe no modelo atual.
  useEffect(() => {
    if (!refs) return;
    const alive = new Set(refs.filter(referenceSelectable).map((r) => r.storageKey));
    const next = selected.filter((key) => alive.has(key)).slice(0, maxSelectable);
    if (next.length !== selected.length) onSelectedChange(next);
  }, [refs, selected, maxSelectable, onSelectedChange]);

  useEffect(() => {
    const pending = (refs ?? []).filter(
      (r) => r.kind === 'image' && !thumbs[r.storageKey] && !tried.current.has(r.storageKey),
    );
    if (pending.length === 0) return;
    let cancelled = false;
    for (const r of pending) tried.current.add(r.storageKey);
    void Promise.all(
      pending.map(async (r) => {
        const res = await window.nexus.mediaReferences.readDataUrl(r.storageKey);
        if (!cancelled && res.ok && res.dataUrl) {
          setThumbs((t) => ({ ...t, [r.storageKey]: res.dataUrl! }));
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [refs, thumbs]);

  async function addFiles(files: readonly File[]) {
    if (files.length === 0 || disabled) return;
    setBusy(true);
    setError(null);
    const added: MediaReferenceInfo[] = [];
    const failures: string[] = [];
    for (const file of files) {
      try {
        const res = await window.nexus.mediaReferences.save(file.name || 'colado', await file.arrayBuffer());
        if (res.ok) added.push(res.reference);
        else failures.push(res.error);
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    await reload().catch(() => undefined);
    // O que acabou de chegar já entra em uso, se couber.
    const room = Math.max(0, maxSelectable - selected.length);
    const fresh = added.filter(referenceSelectable).map((r) => r.storageKey).slice(0, room);
    if (fresh.length > 0) onSelectedChange([...selected, ...fresh]);
    if (failures.length > 0) setError(failures.join(' '));
    setBusy(false);
  }

  function toggle(ref: MediaReferenceInfo) {
    if (disabled || !referenceSelectable(ref)) return;
    if (selected.includes(ref.storageKey)) {
      onSelectedChange(selected.filter((key) => key !== ref.storageKey));
      return;
    }
    if (selected.length >= maxSelectable) {
      // Modelo de uma imagem só: trocar é o gesto esperado, não recusar.
      if (maxSelectable === 1) onSelectedChange([ref.storageKey]);
      return;
    }
    onSelectedChange([...selected, ref.storageKey]);
  }

  async function remove(ref: MediaReferenceInfo) {
    setError(null);
    const res = await window.nexus.mediaReferences.remove(ref.storageKey);
    if (!res.ok) setError(res.error ?? 'Não foi possível remover.');
    onSelectedChange(selected.filter((key) => key !== ref.storageKey));
    await reload().catch(() => undefined);
  }

  const count = selected.length;

  return (
    <section
      className={`ms-refs${dragOver ? ' ms-refs--drag' : ''}`}
      aria-labelledby={labelId}
      onDragOver={(event) => {
        if (disabled || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        void addFiles(Array.from(event.dataTransfer.files));
      }}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files);
        if (files.length === 0) return;
        event.preventDefault();
        void addFiles(files);
      }}
    >
      <div className="ms-refs__head">
        <span id={labelId} className="ms-field__label">
          Referências{maxSelectable > 0 ? ` · ${count} de ${maxSelectable} em uso` : ''}
        </span>
        <button
          type="button"
          className="ms-button ms-button--sm"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? 'Adicionando…' : 'Adicionar imagem, logo ou vídeo'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          data-testid="ms-refs-input"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            void addFiles(files);
          }}
        />
      </div>

      {blockedReason ? (
        <p className="ms-dim" role="note">{blockedReason}</p>
      ) : roleHint && maxSelectable > 0 ? (
        <p className="ms-dim" role="note">{roleHint}</p>
      ) : null}

      {refs && refs.length === 0 ? (
        <p className="ms-refs__empty ms-dim">
          Arraste para cá imagens, logos ou um vídeo de exemplo, cole com ⌘V ou clique em
          Adicionar. As cópias ficam em <code>media/referencias</code> do projeto.
        </p>
      ) : (
        <ul className="ms-refs__grid" aria-label="Referências do projeto">
          {(refs ?? []).map((ref) => {
            const order = selected.indexOf(ref.storageKey);
            const selectable = referenceSelectable(ref) && !blockedReason && maxSelectable > 0;
            return (
              <li key={ref.storageKey} className="ms-refs__item">
                <button
                  type="button"
                  className={`ms-refs__card${order >= 0 ? ' ms-refs__card--on' : ''}`}
                  aria-pressed={order >= 0}
                  disabled={disabled || !selectable}
                  title={
                    referenceSelectable(ref)
                      ? order >= 0
                        ? 'Clique para não usar'
                        : 'Clique para usar na geração'
                      : unselectableTitle(ref)
                  }
                  onClick={() => toggle(ref)}
                >
                  <span className="ms-refs__thumb">
                    {thumbs[ref.storageKey] ? (
                      <img src={thumbs[ref.storageKey]} alt="" />
                    ) : (
                      <PixelIcon name={ref.kind === 'video' ? 'mission' : 'vision'} size={16} />
                    )}
                    {order >= 0 ? <span className="ms-refs__order">{order + 1}</span> : null}
                  </span>
                  <span className="ms-refs__name">{ref.name}</span>
                  <span className="ms-refs__meta">
                    {ref.kind === 'video' ? 'vídeo' : ref.vector ? 'SVG' : 'imagem'} ·{' '}
                    {formatBytes(ref.bytes)}
                  </span>
                </button>
                <button
                  type="button"
                  className="ms-refs__remove"
                  aria-label={`Remover ${ref.name} (vai para a Lixeira)`}
                  title="Remover (vai para a Lixeira)"
                  disabled={disabled}
                  onClick={() => void remove(ref)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {error ? (
        <p className="ms-error__msg" role="alert">
          <PixelIcon name="warn" size={11} /> {error}
        </p>
      ) : null}
    </section>
  );
}
