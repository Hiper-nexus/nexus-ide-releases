import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { PixelIcon } from './PixelIcon';
import {
  filesFromClipboardData,
  formatMissionAttachmentSize,
  stageMissionAttachment,
  validateMissionAttachment,
  type MissionAttachment,
} from '../lib/mission-attachments';

type MissionAttachmentPickerProps = {
  attachments: readonly MissionAttachment[];
  onChange: (attachments: MissionAttachment[]) => void;
  disabled?: boolean;
};

const PASTE_SHORTCUT =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
    ? '⌘V'
    : 'Ctrl+V';

export function MissionAttachmentPicker({
  attachments,
  onChange,
  disabled = false,
}: MissionAttachmentPickerProps) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);
  const busyRef = useRef(false);
  const disabledRef = useRef(disabled);
  const onChangeRef = useRef(onChange);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  attachmentsRef.current = attachments;
  busyRef.current = busy;
  disabledRef.current = disabled;
  onChangeRef.current = onChange;

  async function addFiles(files: FileList | File[]) {
    if (disabledRef.current || busyRef.current) return;
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    setBusy(true);
    setError(null);
    const baseline = attachmentsRef.current;
    const next = [...baseline];
    const errors: string[] = [];
    try {
      for (const file of incoming) {
        const validation = validateMissionAttachment(file, next);
        if (validation) {
          errors.push(validation);
          continue;
        }
        try {
          next.push(await stageMissionAttachment(file));
        } catch (cause) {
          errors.push(
            cause instanceof Error
              ? cause.message
              : `Falha ao salvar ${file.name || 'anexo'}.`,
          );
        }
      }
      if (next.length !== baseline.length) onChangeRef.current(next);
      if (errors.length > 0) setError(errors.join(' '));
    } finally {
      setBusy(false);
    }
  }

  // While this picker is on screen (objetivo / compose), paste of a screenshot
  // attaches immediately — even when focus is on the intent textarea.
  // capture:true so preventDefault runs before the textarea inserts binary junk.
  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      if (disabledRef.current) return;
      const files = filesFromClipboardData(event.clipboardData);
      if (files.length === 0) return;
      // Always stop image/audio paste from landing as garbage text in the intent.
      event.preventDefault();
      event.stopPropagation();
      if (busyRef.current) {
        setError('Aguarde o anexo anterior terminar de salvar.');
        return;
      }
      void addFiles(files);
    }
    window.addEventListener('paste', handlePaste, true);
    return () => window.removeEventListener('paste', handlePaste, true);
  }, []);

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    void addFiles(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
  }

  return (
    <div
      className={`mission-attachments ${dragActive ? 'mission-attachments--active' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        void addFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={handleInputChange}
      />
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/*"
        multiple
        hidden
        onChange={handleInputChange}
      />
      <div className="mission-attachments__head">
        <div>
          <p className="mission-attachments__title">EVIDÊNCIAS OPCIONAIS</p>
          <p className="mission-attachments__hint">
            Anexe prints de erro ou áudios para o time investigar junto com o
            objetivo. Cole o print com {PASTE_SHORTCUT}.
          </p>
        </div>
        <span className="mission-attachments__limit">{attachments.length}/6</span>
      </div>
      <div className="mission-attachments__actions">
        <button
          type="button"
          className="wizard__btn mission-attachments__button"
          disabled={disabled || busy}
          onClick={() => imageInputRef.current?.click()}
        >
          <PixelIcon name="vision" />
          {busy ? 'Salvando…' : 'Anexar print'}
        </button>
        <button
          type="button"
          className="wizard__btn mission-attachments__button"
          disabled={disabled || busy}
          onClick={() => audioInputRef.current?.click()}
        >
          <PixelIcon name="mic" />
          Anexar áudio
        </button>
        <span className="mission-attachments__drop-hint">
          ou cole {PASTE_SHORTCUT} / arraste · até 14 MB cada
        </span>
      </div>
      {attachments.length > 0 && (
        <ul className="mission-attachments__list" aria-label="Arquivos anexados">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="mission-attachments__item">
              <span className="mission-attachments__kind" aria-hidden="true">
                <PixelIcon name={attachment.kind === 'image' ? 'vision' : 'mic'} />
              </span>
              <span className="mission-attachments__file">
                <strong title={attachment.name}>{attachment.name}</strong>
                <small>{formatMissionAttachmentSize(attachment.size)}</small>
              </span>
              <button
                type="button"
                className="mission-attachments__remove"
                aria-label={`Remover ${attachment.name}`}
                disabled={disabled || busy}
                onClick={() =>
                  onChange(attachments.filter((item) => item.id !== attachment.id))
                }
              >
                <PixelIcon name="close" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="mission-attachments__error" role="alert">
          {error}
        </p>
      )}
      {!dragActive && attachments.length === 0 && (
        <p className="mission-attachments__empty">
          PNG, JPG, WEBP, MP3, M4A, WAV — cole o print ({PASTE_SHORTCUT}) ou
          arraste o arquivo.
        </p>
      )}
      {dragActive && (
        <p className="mission-attachments__empty">Solte para anexar ao objetivo.</p>
      )}
    </div>
  );
}
