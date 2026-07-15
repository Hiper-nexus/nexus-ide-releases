import { useRef, useState, type ChangeEvent } from 'react';
import { PixelIcon } from './PixelIcon';
import {
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

export function MissionAttachmentPicker({
  attachments,
  onChange,
  disabled = false,
}: MissionAttachmentPickerProps) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addFiles(files: FileList | File[]) {
    if (disabled || busy) return;
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    setBusy(true);
    setError(null);
    const next = [...attachments];
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
          errors.push(cause instanceof Error ? cause.message : `Falha ao salvar ${file.name}.`);
        }
      }
      if (next.length !== attachments.length) onChange(next);
      if (errors.length > 0) setError(errors.join(' '));
    } finally {
      setBusy(false);
    }
  }

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
            Anexe prints de erro ou áudios para o time investigar junto com o objetivo.
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
        <span className="mission-attachments__drop-hint">ou arraste aqui · até 14 MB cada</span>
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
                onClick={() => onChange(attachments.filter((item) => item.id !== attachment.id))}
              >
                <PixelIcon name="close" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mission-attachments__error" role="alert">{error}</p>}
      {!dragActive && attachments.length === 0 && (
        <p className="mission-attachments__empty">PNG, JPG, WEBP, MP3, M4A, WAV e outros formatos compatíveis.</p>
      )}
      {dragActive && <p className="mission-attachments__empty">Solte para anexar ao objetivo.</p>}
    </div>
  );
}
