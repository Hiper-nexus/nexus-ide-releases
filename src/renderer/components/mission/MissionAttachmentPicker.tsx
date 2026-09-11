import { useEffect, useId, useRef, useState } from 'react';
import {
  classifyMissionAttachment,
  consumeDroppedFiles,
  isMissionContextAttachmentPath,
  MISSION_ATTACHMENT_LIMITS,
  stageMissionAttachment,
  validateMissionAttachment,
  filesFromClipboardData,
  missionAttachmentContentKey,
  type MissionAttachment,
} from '../../lib/mission-attachments';
import {
  describeShellDrop,
  importDroppedUriForMission,
  type DroppedUri,
} from '../../lib/mission-shell-file-intake';

const FILE_ACCEPT =
  'audio/*,image/*,application/pdf,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.rtf,' +
  '.txt,.md,.mdx,.csv,.json,.ts,.tsx,.js,.jsx,.css,.html,.yml,.yaml';

interface MissionAttachmentPickerProps {
  contextPaths: readonly string[];
  disabled: boolean;
  compact?: boolean;
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

function fileSignature(file: File): string {
  return [
    file.name.trim().toLowerCase(),
    file.size,
    file.type.toLowerCase(),
    file.lastModified,
  ].join('\0');
}

export function MissionAttachmentPicker({
  contextPaths,
  disabled,
  compact = false,
  onContextPathsChange,
}: MissionAttachmentPickerProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);
  const importingFileKeysRef = useRef(new Set<string>());
  const importedContentKeysRef = useRef(new Map<string, string>());

  const importFiles = async (files: readonly File[]): Promise<void> => {
    if (disabled || files.length === 0) return;
    setBusy(true);
    setError(null);
    const next = [...contextPaths];
    const nextPathSet = new Set(next);
    const currentImported = importedPaths(next);
    for (const [key, path] of [...importedContentKeysRef.current]) {
      if (!currentImported.includes(path)) importedContentKeysRef.current.delete(key);
    }
    const currentAttachments: MissionAttachment[] = currentImported.map(
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
        const contentKey = await missionAttachmentContentKey(file);
        const signature = fileSignature(file);
        if (
          importingFileKeysRef.current.has(signature) ||
          importingFileKeysRef.current.has(contentKey) ||
          importedContentKeysRef.current.has(contentKey)
        ) {
          continue;
        }
        const invalid = validateMissionAttachment(file, currentAttachments);
        if (invalid) {
          setError(invalid);
          break;
        }
        importingFileKeysRef.current.add(signature);
        importingFileKeysRef.current.add(contentKey);
        try {
          const staged = await stageMissionAttachment(file);
          currentAttachments.push(staged);
          importedContentKeysRef.current.set(contentKey, staged.path);
          if (!nextPathSet.has(staged.path)) {
            nextPathSet.add(staged.path);
            next.push(staged.path);
          }
        } finally {
          importingFileKeysRef.current.delete(signature);
          importingFileKeysRef.current.delete(contentKey);
        }
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

  /**
   * Anexa endereços aproveitados de um arraste sem `File` (a promessa que o
   * Chromium não materializa). Sem esta perna o drop na zona era silêncio puro:
   * `filesFromClipboardData` devolve [] por construção quando não há arquivo.
   */
  const importDroppedUris = async (
    uris: readonly DroppedUri[],
  ): Promise<void> => {
    if (disabled || uris.length === 0) return;
    setBusy(true);
    setError(null);
    const next = [...contextPaths];
    const nextPathSet = new Set(next);
    try {
      const failures: string[] = [];
      for (const dropped of uris) {
        const result = await importDroppedUriForMission(dropped.uri);
        if (!result.ok) {
          failures.push(result.message);
          continue;
        }
        if (!nextPathSet.has(result.path)) {
          nextPathSet.add(result.path);
          next.push(result.path);
        }
      }
      if (next.length !== contextPaths.length) onContextPathsChange(next);
      if (failures.length > 0) setError(failures.join(' '));
    } finally {
      setBusy(false);
    }
  };

  const importFilesRef = useRef(importFiles);
  importFilesRef.current = importFiles;

  useEffect(() => {
    const pending = consumeDroppedFiles();
    if (pending.length > 0) void importFilesRef.current(pending);
  }, []);

  const currentImported = importedPaths(contextPaths);

  return (
    <div
      className={
        compact
          ? 'mission-attachment-picker mission-attachment-picker--compact'
          : 'mission-attachment-picker'
      }
    >
      <div className="mission-setup__section-heading">
        <div>
          <h2>Anexos do cliente</h2>
          {compact ? null : (
          <p>
            Áudio, imagem, documento (PDF/Office) ou texto — mesmo de fora da
            pasta do projeto. O Nexus copia o arquivo para dentro da missão.
          </p>
          )}
        </div>
        <span>
          {currentImported.length}/{MISSION_ATTACHMENT_LIMITS.maxCount}
        </span>
      </div>

      <div
        ref={dropRef}
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
          const plan = describeShellDrop(event.dataTransfer, {
            allowUrlDownload: false,
          });
          // Texto puro e arraste interno de skill não são intake.
          if (plan.action === 'ignore') return;
          // Desabilitado: NÃO reivindica o evento. Sem `stopPropagation` o
          // intake do shell assume e avisa; engolir aqui era silêncio total.
          if (disabled) return;
          event.preventDefault();
          event.stopPropagation();
          setDropActive(false);
          if (plan.action === 'warn') {
            setError(plan.message);
            return;
          }
          if (plan.action === 'uris') {
            void importDroppedUris(plan.uris);
            return;
          }
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
          // O intake do shell é dono do paste no app inteiro; sem parar aqui a
          // MESMA imagem seria importada duas vezes.
          event.stopPropagation();
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
              <span className="mission-attachment-picker__kind">
                {kindLabel(path)}
              </span>
              <span className="mission-attachment-picker__file">
                <strong>{displayName(path)}</strong>
                <small>Copiado para a missão</small>
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
