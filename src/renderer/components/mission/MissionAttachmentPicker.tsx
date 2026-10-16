import { useEffect, useId, useRef, useState } from 'react';
import {
  classifyMissionAttachment,
  consumeDroppedFiles,
  formatMissionAttachmentSize,
  isMissionContextAttachmentPath,
  MISSION_ATTACHMENT_LIMITS,
  normalizeMissionImageFileMimeType,
  stageMissionAttachment,
  validateMissionAttachment,
  filesFromClipboardData,
  missionAttachmentContentKey,
  type MissionAttachment,
} from '../../lib/mission-attachments';
import {
  imageNeedsPreparation,
  isHeicImageFile,
  prepareImageForAttachment,
  type CompressImageFileResult,
} from '../../lib/image-compression';
import {
  describeShellDrop,
  importDroppedUriForMission,
  type DroppedUri,
} from '../../lib/mission-shell-file-intake';
import { useWorkspaceStore } from '../../state/workspace-store';
import {
  attachmentDisplayName,
  finishPendingAttachment,
  rememberAttachment,
  rememberAttachmentThumbnail,
  useMissionAttachmentPresentation,
} from '../../state/mission-attachment-presentation';

const FILE_ACCEPT =
  'audio/*,image/*,.heic,.heif,application/pdf,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.rtf,' +
  '.txt,.md,.mdx,.csv,.json,.ts,.tsx,.js,.jsx,.css,.html,.yml,.yaml';

const WORKSPACE_CHANGED_MESSAGE =
  'A pasta do projeto mudou enquanto o anexo era preparado. Anexe o arquivo de novo.';

function currentWorkspacePath(): string | null {
  return useWorkspaceStore.getState().current?.path ?? null;
}

function imageFormatLabel(mime: string): string {
  if (mime === 'image/jpeg') return 'JPEG';
  if (mime === 'image/webp') return 'WebP';
  return mime;
}

/** Conversão/compressão troca o arquivo: o usuário precisa saber o que foi. */
function preparationNotice(original: File, prepared: File): string {
  const action = isHeicImageFile(original) ? 'convertida' : 'comprimida';
  return (
    `A imagem ${original.name} foi ${action} para ${imageFormatLabel(prepared.type)} ` +
    `(${prepared.name}, ${formatMissionAttachmentSize(prepared.size)}).`
  );
}

function preparationFailure(
  name: string,
  failure: Extract<CompressImageFileResult, { ok: false }>,
): string {
  if (failure.message) return `${name}: ${failure.message}`;
  if (failure.reason === 'too-large') {
    return `${name} é grande demais para anexar, mesmo depois de comprimir (limite de 14 MB por arquivo).`;
  }
  if (failure.reason === 'unsupported') {
    return `${name}: HEIC não suportado neste sistema.`;
  }
  return `${name} não pôde ser lido como imagem.`;
}

interface MissionAttachmentPickerProps {
  contextPaths: readonly string[];
  disabled: boolean;
  compact?: boolean;
  onContextPathsChange(paths: readonly string[]): void;
}

function importedPaths(contextPaths: readonly string[]): string[] {
  return contextPaths.filter(isMissionContextAttachmentPath);
}

const displayName = attachmentDisplayName;

/** Nome escolhido pelo operador com a extensão do arquivo que foi anexado. */
function chosenName(original: File, attached: File): string {
  if (!original.name) return attached.name;
  if (original === attached || original.name === attached.name) return original.name;
  const dot = attached.name.lastIndexOf('.');
  const extension = dot > 0 ? attached.name.slice(dot) : '';
  const originalDot = original.name.lastIndexOf('.');
  const base = originalDot > 0 ? original.name.slice(0, originalDot) : original.name;
  return `${base}${extension}`;
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
  const [notice, setNotice] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const presentation = useMissionAttachmentPresentation((s) => s.presentation);
  const pending = useMissionAttachmentPresentation((s) => s.pending);
  const dropRef = useRef<HTMLDivElement>(null);
  const importingFileKeysRef = useRef(new Set<string>());
  const importedContentKeysRef = useRef(new Map<string, string>());
  const importedSizesRef = useRef(new Map<string, number>());

  const importFiles = async (files: readonly File[]): Promise<void> => {
    if (disabled || files.length === 0) return;
    // Cada await pode atravessar uma troca de projeto: o anexo e o rascunho
    // de agora pertencem ao projeto do início, nunca ao novo.
    const workspaceAtStart = currentWorkspacePath();
    const workspaceMoved = (): boolean =>
      currentWorkspacePath() !== workspaceAtStart;
    setBusy(true);
    setError(null);
    setNotice(null);
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
        size: importedSizesRef.current.get(path) ?? 0,
        path,
      }),
    );
    const failures: string[] = [];
    const notices: string[] = [];
    let stopReason: string | null = null;
    try {
      for (const original of files) {
        // A chave é do ORIGINAL: o mesmo HEIC colado de novo não reconverte.
        const contentKey = await missionAttachmentContentKey(original);
        if (workspaceMoved()) {
          setError(WORKSPACE_CHANGED_MESSAGE);
          return;
        }
        const signature = fileSignature(original);
        if (
          importingFileKeysRef.current.has(signature) ||
          importingFileKeysRef.current.has(contentKey) ||
          importedContentKeysRef.current.has(contentKey)
        ) {
          continue;
        }
        importingFileKeysRef.current.add(signature);
        importingFileKeysRef.current.add(contentKey);
        try {
          let file = original;
          if (classifyMissionAttachment(original) === 'image') {
            // Tipo, vazio e contagem antes de preparar; os limites de bytes
            // valem para o arquivo que será anexado de fato (abaixo).
            const preflight = validateMissionAttachment(
              { name: original.name, type: original.type, size: Math.min(original.size, 1) },
              currentAttachments,
            );
            if (preflight) {
              stopReason = preflight;
              break;
            }
            file = normalizeMissionImageFileMimeType(original);
            if (imageNeedsPreparation(file, MISSION_ATTACHMENT_LIMITS.maxBytesPerFile)) {
              const prepared = await prepareImageForAttachment(
                file,
                MISSION_ATTACHMENT_LIMITS.maxBytesPerFile,
              );
              if (workspaceMoved()) {
                setError(WORKSPACE_CHANGED_MESSAGE);
                return;
              }
              if (!prepared.ok) {
                // Uma foto sem conversão não derruba os outros anexos.
                failures.push(preparationFailure(original.name || 'imagem', prepared));
                continue;
              }
              if (prepared.recompressed) {
                notices.push(preparationNotice(original, prepared.file));
              }
              file = prepared.file;
            }
          }
          const invalid = validateMissionAttachment(file, currentAttachments);
          if (invalid) {
            stopReason = invalid;
            break;
          }
          const staged = await stageMissionAttachment(file);
          if (workspaceMoved()) {
            setError(WORKSPACE_CHANGED_MESSAGE);
            return;
          }
          currentAttachments.push(staged);
          importedContentKeysRef.current.set(contentKey, staged.path);
          importedSizesRef.current.set(staged.path, staged.size);
          // F-1005: a lista mostra o nome que o operador escolheu (não o
          // token interno do Main) e, para imagem, uma miniatura.
          rememberAttachment(staged.path, { name: chosenName(original, file) });
          if (staged.kind === 'image') {
            rememberAttachmentThumbnail(staged.path, file);
          }
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
      const problems = stopReason ? [...failures, stopReason] : failures;
      if (problems.length > 0) setError(problems.join(' '));
      if (notices.length > 0) setNotice(notices.join(' '));
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
    const workspaceAtStart = currentWorkspacePath();
    setBusy(true);
    setError(null);
    setNotice(null);
    const next = [...contextPaths];
    const nextPathSet = new Set(next);
    try {
      const failures: string[] = [];
      for (const dropped of uris) {
        const result = await importDroppedUriForMission(dropped.uri);
        if (currentWorkspacePath() !== workspaceAtStart) {
          setError(WORKSPACE_CHANGED_MESSAGE);
          return;
        }
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
          <h2>Anexos</h2>
          {compact ? (
            <p>Imagem, áudio, PDF ou texto.</p>
          ) : (
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
        role="group"
        aria-label="Anexar arquivos: solte, cole ou escolha no disco"
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
          tabIndex={-1}
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

      {notice && (
        <p className="mission-setup__hint" role="status">
          {notice}
        </p>
      )}

      {(currentImported.length > 0 || pending.length > 0) && (
        <ul className="mission-attachment-picker__list" aria-label="Anexos importados">
          {pending.map((item) => (
            <li
              key={item.id}
              className={
                item.error ? 'mission-attachment-picker__item--failed' : undefined
              }
            >
              <span className="mission-attachment-picker__kind">
                {item.error ? 'Falhou' : 'Anexando…'}
              </span>
              <span className="mission-attachment-picker__file">
                <strong>{item.name}</strong>
                <small role={item.error ? 'alert' : 'status'}>
                  {item.error ?? 'Copiando para a missão'}
                </small>
              </span>
              {item.error && (
                <button
                  type="button"
                  className="mission-setup__button mission-setup__button--quiet"
                  aria-label={`Dispensar aviso de ${item.name}`}
                  onClick={() => finishPendingAttachment(item.id)}
                >
                  Dispensar
                </button>
              )}
            </li>
          ))}
          {currentImported.map((path) => (
            <li key={path}>
              {presentation.get(path)?.thumbnail ? (
                <img
                  className="mission-attachment-picker__thumb"
                  src={presentation.get(path)?.thumbnail}
                  alt=""
                  width={48}
                  height={48}
                />
              ) : (
                <span className="mission-attachment-picker__kind">
                  {kindLabel(path)}
                </span>
              )}
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
