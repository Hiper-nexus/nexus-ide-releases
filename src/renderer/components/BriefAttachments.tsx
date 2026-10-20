import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaReferenceInfo } from '../../shared/media-reference-types';
import { useWorkspaceStore } from '../state/workspace-store';
import { PixelIcon } from './PixelIcon';
import { isVideoReferenceKey } from './media-studio-options';
import {
  BRIEF_ATTACHMENT_ROLES,
  BRIEF_ATTACHMENT_ROLE_LABEL,
  guessAttachmentRole,
  type BriefAttachment,
  type BriefAttachmentRole,
} from './video-brief';

/**
 * Anexos do "Novo vídeo de apresentação": logo, mascote, vídeo de exemplo e
 * prints do sistema, por Adicionar, arrastando ou colando. Viram cópias em
 * `media/referencias/` (a mesma biblioteca do Estúdio) e o brief diz ao agente
 * o papel de cada um. SVG entra aqui: serve de logo no vídeo por código.
 */

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml,video/mp4,video/quicktime,video/webm';
const MAX_ATTACHMENTS = 20;

export interface BriefAttachmentsProps {
  readonly attachments: readonly BriefAttachment[];
  readonly onChange: (next: BriefAttachment[]) => void;
}

function toAttachment(ref: MediaReferenceInfo): BriefAttachment {
  return {
    storageKey: ref.storageKey,
    name: ref.name,
    role: guessAttachmentRole(ref.name, ref.kind === 'video'),
  };
}

export function BriefAttachments({ attachments, onChange }: BriefAttachmentsProps) {
  const [library, setLibrary] = useState<readonly MediaReferenceInfo[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tried = useRef(new Set<string>());

  const reload = useCallback(async () => {
    const list = await window.nexus.mediaReferences.list();
    setLibrary(list ?? []);
  }, []);

  useEffect(() => {
    void reload().catch(() => setLibrary([]));
  }, [reload]);

  useEffect(() => {
    const pending = attachments.filter(
      (item) => !isVideoReferenceKey(item.storageKey) && !thumbs[item.storageKey] && !tried.current.has(item.storageKey),
    );
    if (pending.length === 0) return;
    let cancelled = false;
    for (const item of pending) tried.current.add(item.storageKey);
    void Promise.all(
      pending.map(async (item) => {
        const res = await window.nexus.mediaReferences.readDataUrl(item.storageKey);
        if (!cancelled && res.ok && res.dataUrl) setThumbs((t) => ({ ...t, [item.storageKey]: res.dataUrl! }));
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [attachments, thumbs]);

  async function addFiles(files: readonly File[]) {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    // O Main resolve o projeto de destino no `save` pelo workspace ATIVO: depois
    // de cada espera (leitura do arquivo, cópia anterior) confere que ele ainda
    // é o de onde o anexo saiu, senão a cópia cairia em outro projeto.
    const origin = useWorkspaceStore.getState().current?.path ?? null;
    const sameWorkspace = () => (useWorkspaceStore.getState().current?.path ?? null) === origin;
    const added: BriefAttachment[] = [];
    const failures: string[] = [];
    for (const file of files) {
      try {
        const bytes = await file.arrayBuffer();
        if (!sameWorkspace()) break;
        const res = await window.nexus.mediaReferences.save(file.name || 'colado', bytes);
        if (res.ok) added.push(toAttachment(res.reference));
        else failures.push(res.error);
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (!sameWorkspace()) {
      // Trocou de projeto no meio: nada do que chegou pertence ao brief daqui.
      setBusy(false);
      return;
    }
    await reload().catch(() => undefined);
    if (!sameWorkspace()) {
      setBusy(false);
      return;
    }
    const known = new Set(attachments.map((item) => item.storageKey));
    const next = [...attachments, ...added.filter((item) => !known.has(item.storageKey))].slice(0, MAX_ATTACHMENTS);
    if (next.length !== attachments.length) onChange(next);
    if (failures.length > 0) setError(failures.join(' '));
    setBusy(false);
  }

  function setRole(storageKey: string, role: BriefAttachmentRole) {
    onChange(attachments.map((item) => (item.storageKey === storageKey ? { ...item, role } : item)));
  }

  const attached = new Set(attachments.map((item) => item.storageKey));
  const reusable = library.filter((ref) => !attached.has(ref.storageKey));

  return (
    <section
      className={`ms-refs vp-field--wide${dragOver ? ' ms-refs--drag' : ''}`}
      aria-label="Anexos do vídeo"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
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
        <span className="ms-field__label">
          Anexos{attachments.length > 0 ? ` · ${attachments.length}` : ' (opcional)'}
        </span>
        <button type="button" className="ms-button ms-button--sm" disabled={busy || attachments.length >= MAX_ATTACHMENTS} onClick={() => inputRef.current?.click()}>
          {busy ? 'Adicionando…' : 'Anexar logo, mascote, prints ou vídeo'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          data-testid="vp-attach-input"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            void addFiles(files);
          }}
        />
      </div>

      {attachments.length === 0 ? (
        <p className="ms-refs__empty ms-dim">
          Arraste para cá o logo, o mascote, prints do seu sistema e até um vídeo de exemplo do
          estilo que você quer (ou cole com Ctrl+V). O agente recebe cada um com o papel certo.
        </p>
      ) : (
        <ul className="vp-attach__list" aria-label="Anexos escolhidos">
          {attachments.map((item) => (
            <li key={item.storageKey} className="vp-attach__item">
              <span className="vp-attach__thumb">
                {thumbs[item.storageKey] ? (
                  <img src={thumbs[item.storageKey]} alt="" />
                ) : (
                  <PixelIcon name={isVideoReferenceKey(item.storageKey) ? 'mission' : 'vision'} size={16} />
                )}
              </span>
              <span className="vp-attach__name" title={item.name}>
                {item.name}
              </span>
              <select
                className="ms-select vp-attach__role"
                aria-label={`Papel de ${item.name}`}
                value={item.role}
                onChange={(event) => setRole(item.storageKey, event.target.value as BriefAttachmentRole)}
              >
                {BRIEF_ATTACHMENT_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {BRIEF_ATTACHMENT_ROLE_LABEL[role]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ms-refs__remove vp-attach__remove"
                aria-label={`Tirar ${item.name} do pedido`}
                title="Tirar do pedido (o arquivo continua no projeto)"
                onClick={() => onChange(attachments.filter((other) => other.storageKey !== item.storageKey))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {reusable.length > 0 && attachments.length < MAX_ATTACHMENTS && (
        <div className="ms-chips" role="group" aria-label="Já no projeto">
          <span className="ms-dim">Já no projeto:</span>
          {reusable.slice(0, 8).map((ref) => (
            <button
              key={ref.storageKey}
              type="button"
              className="ms-chip"
              title={`Usar ${ref.name}`}
              onClick={() => onChange([...attachments, toAttachment(ref)])}
            >
              + {ref.name}
            </button>
          ))}
        </div>
      )}

      {error ? (
        <p className="ms-error__msg" role="alert">
          <PixelIcon name="warn" size={11} /> {error}
        </p>
      ) : null}
    </section>
  );
}
