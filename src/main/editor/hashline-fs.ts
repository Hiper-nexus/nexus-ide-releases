import type { ProjectExecutionScope } from '../../shared/types';
import {
  openWorkspaceFileForRead,
  readWorkspaceTextFile,
  removeWorkspaceFile,
  writeWorkspaceTextFile,
} from '../orch/workspace-file';
import { resolvePathCandidateForScope } from '../orch/workspace-path';
import {
  Filesystem,
  NotFoundError,
  type PreflightWriteOptions,
  type WriteResult,
} from '../../vendor/omp/hashline/fs';
import {
  applyEdit,
  type EditorDocument,
  markSaved,
} from './editor-document';

/**
 * Hashline "patch bus" filesystem adapters (oh-my-pi integration, entrega B3).
 *
 * The vendored hashline Patcher (src/vendor/omp/hashline) is storage-agnostic:
 * it talks to an abstract Filesystem. These adapters bind it to NexusIDE's
 * security model:
 *
 * - {@link WorkspaceHashlineFs} routes every read/write/delete/move through
 *   the hardened primitives in src/main/orch/workspace-file.ts (O_NOFOLLOW,
 *   descriptor revalidation, realpath containment, hardlink refusal). No
 *   security logic is reimplemented here.
 * - {@link EditorBufferHashlineFs} additionally consults the in-main registry
 *   of open editor documents so a patch validates against (and refreshes) the
 *   buffer the user actually sees, not a stale on-disk copy.
 */

/** Translate workspace-file "file not found" errors into hashline's ENOENT contract. */
function rethrowAsHashlineError(error: unknown, relativePath: string): never {
  if (
    error instanceof Error &&
    (error.message.startsWith('file not found:') ||
      (error as NodeJS.ErrnoException).code === 'ENOENT')
  ) {
    throw new NotFoundError(relativePath, error);
  }
  throw error;
}

/**
 * Disk adapter over the scoped-workspace primitives. Paths are
 * workspace-relative (the hashline patch dialect); the canonical key is the
 * lexically contained absolute path, so snapshot producers and the patcher
 * agree on identity without a second resolution scheme.
 */
export class WorkspaceHashlineFs extends Filesystem {
  constructor(protected readonly scope: ProjectExecutionScope) {
    super();
  }

  async readText(relativePath: string): Promise<string> {
    try {
      return readWorkspaceTextFile(this.scope, relativePath).content;
    } catch (error) {
      rethrowAsHashlineError(error, relativePath);
    }
  }

  async writeText(relativePath: string, content: string): Promise<WriteResult> {
    writeWorkspaceTextFile(this.scope, relativePath, content);
    return { text: content };
  }

  override async preflightWrite(
    relativePath: string,
    options?: PreflightWriteOptions,
  ): Promise<void> {
    // Containment is the gate: resolution throws on workspace escape. The
    // descriptor-level guarantees (symlink/hardlink/inode) are re-validated by
    // workspace-file.ts at commit time.
    resolvePathCandidateForScope(this.scope, relativePath);
    if (options?.fileOp?.kind === 'move') {
      resolvePathCandidateForScope(this.scope, options.fileOp.dest);
    }
  }

  override async delete(relativePath: string): Promise<void> {
    try {
      removeWorkspaceFile(this.scope, relativePath);
    } catch (error) {
      rethrowAsHashlineError(error, relativePath);
    }
  }

  override async move(
    from: string,
    to: string,
    content?: string,
  ): Promise<void> {
    const finalContent = content ?? (await this.readText(from));
    // Write-then-remove keeps both legs inside the descriptor-validated
    // workspace primitives (there is no scoped rename primitive).
    writeWorkspaceTextFile(this.scope, to, finalContent);
    try {
      removeWorkspaceFile(this.scope, from);
    } catch (error) {
      rethrowAsHashlineError(error, from);
    }
  }

  override async exists(relativePath: string): Promise<boolean> {
    try {
      openWorkspaceFileForRead(this.scope, relativePath).close();
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith('file not found:') ||
          (error as NodeJS.ErrnoException).code === 'ENOENT')
      ) {
        return false;
      }
      throw error;
    }
  }

  override canonicalPath(relativePath: string): string {
    // Lexical containment under the scope root; throws on escape so a hostile
    // header path fails closed before any I/O.
    return resolvePathCandidateForScope(this.scope, relativePath);
  }

  override allowTagPathRecovery(
    _authoredPath: string,
    resolvedPath: string,
  ): boolean {
    // Tag-based path recovery may only rebind onto paths that still resolve
    // inside this workspace scope.
    try {
      resolvePathCandidateForScope(this.scope, resolvedPath);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * In-main registry of open editor documents, keyed by the canonical absolute
 * path used by {@link WorkspaceHashlineFs.canonicalPath}. The renderer editor
 * IPC can publish documents here on open/close so hashline patches see and
 * refresh live buffers. Until that wiring lands, the registry is simply empty
 * and the adapters behave as pure disk adapters.
 */
export class OpenEditorDocumentRegistry {
  readonly #documents = new Map<string, EditorDocument>();

  /** Publish (or refresh) an open document. Key: `doc.path` (absolute). */
  open(doc: EditorDocument): void {
    this.#documents.set(doc.path, doc);
  }

  get(absolutePath: string): EditorDocument | undefined {
    return this.#documents.get(absolutePath);
  }

  /**
   * Reflect a hashline commit into the open buffer: the disk now holds
   * `content`, so the document adopts it as saved (clean) state. A document
   * that cannot hold the content (editor size limit) is closed instead of
   * silently diverging from disk.
   */
  applyPatchedContent(absolutePath: string, content: string): void {
    const doc = this.#documents.get(absolutePath);
    if (!doc) return;
    try {
      this.#documents.set(absolutePath, markSaved(applyEdit(doc, content)));
    } catch {
      this.#documents.delete(absolutePath);
    }
  }

  close(absolutePath: string): void {
    this.#documents.delete(absolutePath);
  }

  relocate(fromAbsolutePath: string, toAbsolutePath: string): void {
    const doc = this.#documents.get(fromAbsolutePath);
    if (!doc) return;
    this.#documents.delete(fromAbsolutePath);
    this.#documents.set(toAbsolutePath, { ...doc, path: toAbsolutePath });
  }

  clear(): void {
    this.#documents.clear();
  }
}

/** Singleton registry shared by the MCP patch tools and (future) editor IPC. */
export const openEditorDocuments = new OpenEditorDocumentRegistry();

/**
 * Buffer-aware adapter: reads prefer the open (possibly dirty) editor
 * document for the same canonical path; writes land on disk through the
 * workspace primitives and then refresh the open document so the user's
 * editor shows the patched content as saved state.
 */
export class EditorBufferHashlineFs extends WorkspaceHashlineFs {
  constructor(
    scope: ProjectExecutionScope,
    private readonly documents: OpenEditorDocumentRegistry = openEditorDocuments,
  ) {
    super(scope);
  }

  override async readText(relativePath: string): Promise<string> {
    const doc = this.documents.get(this.canonicalPath(relativePath));
    if (doc && !doc.binary && !doc.tooLarge) return doc.content;
    return super.readText(relativePath);
  }

  override async exists(relativePath: string): Promise<boolean> {
    if (this.documents.get(this.canonicalPath(relativePath))) return true;
    return super.exists(relativePath);
  }

  override async writeText(
    relativePath: string,
    content: string,
  ): Promise<WriteResult> {
    const result = await super.writeText(relativePath, content);
    this.documents.applyPatchedContent(this.canonicalPath(relativePath), content);
    return result;
  }

  override async delete(relativePath: string): Promise<void> {
    await super.delete(relativePath);
    this.documents.close(this.canonicalPath(relativePath));
  }

  override async move(
    from: string,
    to: string,
    content?: string,
  ): Promise<void> {
    await super.move(from, to, content);
    const fromCanonical = this.canonicalPath(from);
    const toCanonical = this.canonicalPath(to);
    this.documents.relocate(fromCanonical, toCanonical);
    if (content !== undefined) {
      this.documents.applyPatchedContent(toCanonical, content);
    }
  }
}
