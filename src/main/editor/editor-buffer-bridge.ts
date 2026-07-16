import { openEditorDocuments } from './hashline-fs';
import type { EditorDocument } from './editor-document';

/**
 * Bridge: editor IPC → open-document registry (oh-my-pi hashline, entrega B3).
 *
 * The editor IPC (`product-wave-ipc.ts`) is stateless per call, but hashline's
 * buffer-aware adapter (`EditorBufferHashlineFs`) needs to know which documents
 * are OPEN — and whether they are dirty — so a patch validates against the live
 * buffer the user sees rather than a stale on-disk copy. This module publishes
 * the editor's open / edit / save / close transitions into the in-main
 * `openEditorDocuments` singleton.
 *
 * Contracts:
 * - **Fail-safe.** Every entry point swallows its own errors: registry
 *   bookkeeping must NEVER surface into (or break) the editor. Worst case the
 *   patcher just falls back to the pure disk adapter.
 * - **Key = `doc.path`** (the realpath from `resolveScopedPath`). Hashline looks
 *   documents up by its lexical `canonicalPath`, which equals the realpath for
 *   every file without a symlinked leaf — the common case matches; a symlinked
 *   leaf simply misses the buffer and reads from disk (safe).
 * - **Bounded.** The contextual editor shows one document per renderer at a
 *   time, so opening a new path supersedes (unregisters) that sender's previous
 *   document — the registry does not accumulate one entry per file ever opened,
 *   and no explicit close round-trip is required for the common navigate-away.
 */

/** sender.id → realpath of the document that renderer currently has open. */
const currentBySender = new Map<number, string>();

/** Minimal shape of the IPC sender we depend on (Electron WebContents). */
interface SenderRef {
  readonly id: number;
}

function safely(action: () => void): void {
  try {
    action();
  } catch {
    // Best-effort registry maintenance — never propagate into the editor path.
  }
}

/**
 * Publish an opened editor document. Supersedes the sender's previously-open
 * document when the path changed (single-document contextual panel), then
 * registers the fresh buffer so hashline reads/patches see it.
 */
export function publishEditorDocumentOpen(
  sender: SenderRef,
  doc: EditorDocument,
): void {
  safely(() => {
    const previous = currentBySender.get(sender.id);
    if (previous && previous !== doc.path) {
      openEditorDocuments.close(previous);
    }
    currentBySender.set(sender.id, doc.path);
    openEditorDocuments.open(doc);
  });
}

/**
 * Publish an edit/save result. The IPC returns the document in its new state —
 * dirty (write:false) or clean/saved (write:true) — and we refresh the registry
 * so a hashline patch validates against exactly that content.
 */
export function publishEditorDocumentApply(
  sender: SenderRef,
  doc: EditorDocument,
): void {
  safely(() => {
    currentBySender.set(sender.id, doc.path);
    openEditorDocuments.open(doc);
  });
}

/**
 * Explicit close for a document (used when the editor UI closes a buffer). Also
 * clears the per-sender bookkeeping when it matches.
 */
export function publishEditorDocumentClose(
  sender: SenderRef,
  absolutePath: string,
): void {
  safely(() => {
    openEditorDocuments.close(absolutePath);
    if (currentBySender.get(sender.id) === absolutePath) {
      currentBySender.delete(sender.id);
    }
  });
}

/** Test seam: forget every tracked sender (does not touch the registry). */
export function resetEditorBufferBridge(): void {
  currentBySender.clear();
}
