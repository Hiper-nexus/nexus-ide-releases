import { useEffect, useId, useRef, useState } from 'react';
import {
  classifyMissionAttachment,
  consumeDroppedFiles,
  isMissionContextAttachmentPath,
  MISSION_ATTACHMENT_LIMITS,
  stageMissionAttachment,
  validateMissionAttachment,
  filesFromClipboardData,
  type MissionAttachment,
} from '../../lib/mission-attachments';

const FILE_ACCEPT =
  'audio/*,image/*,application/pdf,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.rtf,' +
  '.txt,.md,.mdx,.csv,.json,.ts,.tsx,.js,.jsx,.css,.html,.yml,.yaml';

interface MissionAttachmentPickerProps {
  contextPaths: readonly string[];
  disabled: boolean;
  onContextPathsChange(paths: readonly string[]): void;
}

function importedPaths(contextPaths: readonly string[]): string[] {
  return contextPaths.filter(isMissionContextAttachmentPath);
}

function displayName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

function kindLabel(path: string): string {
  const kind = classifyMissionAttachment({ name: displayName(path), type: '' });
  if (kind === 'audio') return 'Áudio';
  if (kind === 'image') return 'Imagem';
  if (kind === 'document') return 'Documento';
  return 'Texto';
}

export function MissionAttachmentPicker({
  contextPaths,
  disabled,
  onContextPathsChange,
}: MissionAttachmentPickerProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);

  const importFiles = async (files: readonly File[]): Promise<void> => {
    if (disabled || files.length === 0) return;
    setBusy(true);
    setError(null);
    const next = [...contextPaths];
    const currentAttachments: MissionAttachment[] = importedPaths(next).map(
      (path, index) => ({
        id: `${index}`,
        name: displayName(path),
        kind: classifyMissionAttachment({ name: displayName(path), type: '' }) ?? 'file',
        mime: '',
        size: 0,
        path,
      }),
    );
    try {
      for (const file of files) {
        const invalid = validateMissionAttachment(file, currentAttachments);
        if (invalid) {
          setError(invalid);
          break;
        }
        const staged = await stageMissionAttachment(file);
        currentAttachments.push(staged);
        next.push(staged.path);
      }
      if (next.length !== contextPaths.length) {
        onContextPathsChange(next);
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Não foi possível importar o arquivo.',
      );
    } finally {
      setBusy(false);
    }
  };

  const importFilesRef = useRef(importFiles);
  importFilesRef.current = importFiles;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    const pending = consumeDroppedFiles();
    if (pending.length > 0) void importFilesRef.current(pending);
  }, []);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (disabledRef.current || event.defaultPrevented) return;
      const files = filesFromClipboardData(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      void importFilesRef.current(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const currentImported = importedPaths(contextPaths);

  return (
    <div className="mission-attachment-picker">
      <div className="mission-setup__section-heading">
        <div>
          <h2>Anexos do cliente</h2>
          <p>
            Áudio, imagem, documento (PDF/Office) ou texto — mesmo de fora da
            pasta do projeto. O Nexus copia o arquivo para dentro da missão.
          </p>
        </div>
        <span>
          {currentImported.length}/{MISSION_ATTACHMENT_LIMITS.maxCount}
        </span>
      </div>

      <div
        className={`mission-attachment-picker__drop${
          dropActive ? ' mission-attachment-picker__drop--active' : ''
        }`}
        tabIndex={0}
        onDragOver={(event) => {
          if (disabled) return;
          event.preventDefault();
          event.stopPropagation();
          setDropActive(true);
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDropActive(false);
          if (disabled) return;
          // Arquivos crus: o filtro de clipboard engolia PDF em silêncio.
          // validateMissionAttachment (dentro de importFiles) explica o que
          // não passa em vez de fingir que nada foi solto.
          const dropped = Array.from(event.dataTransfer?.files ?? []);
          if (dropped.length > 0) {
            void importFiles(dropped);
            return;
          }
          void importFiles(filesFromClipboardData(event.dataTransfer));
        }}
        onPaste={(event) => {
          if (disabled) return;
          const files = filesFromClipboardData(event.clipboardData);
          if (files.length === 0) return;
          event.preventDefault();
          void importFiles(files);
        }}
      >
        <p>Solte aqui, cole, ou escolha no disco.</p>
        <button
          type="button"
          className="mission-setup__button mission-setup__button--secondary"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? 'Anexando…' : 'Anexar arquivo'}
        </button>
        <input
          id={inputId}
          ref={inputRef}
          className="mission-setup__sr-only"
          type="file"
          accept={FILE_ACCEPT}
          multiple
          disabled={disabled || busy}
          aria-label="Anexar áudio, imagem ou texto"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            void importFiles(files);
          }}
        />
      </div>

      {error && (
        <p className="mission-setup__inline-error" role="alert">
          {error}
        </p>
      )}

      {currentImported.length > 0 && (
        <ul className="mission-attachment-picker__list" aria-label="Anexos importados">
          {currentImported.map((path) => (
            <li key={path}>
              <span>
                {kindLabel(path)} · {displayName(path)}
              </span>
              <button
                type="button"
                className="mission-setup__button mission-setup__button--quiet"
                disabled={disabled}
                aria-label={`Remover ${displayName(path)}`}
                onClick={() =>
                  onContextPathsChange(
                    contextPaths.filter((item) => item !== path),
                  )
                }
              >
                Remover
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
