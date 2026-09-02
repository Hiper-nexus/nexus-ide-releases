/**
 * In-memory attach-mode store for subsequent turn Stop payloads on the same handoff.
 * Preserves fullText and transcripts for orchestrator delivery without violating
 * the SQLite immutability trigger on the primary handoffs table.
 */

const MAX_ATTACHMENTS_CACHE = 200;
const attachmentsByHandoffId = new Map<string, Array<Record<string, unknown>>>();

export function getHandoffAttachments(
  handoffId: string,
): readonly Record<string, unknown>[] {
  return attachmentsByHandoffId.get(handoffId) ?? [];
}

export function attachToExistingHandoff(
  handoffId: string,
  artifact: Record<string, unknown>,
): void {
  const list = attachmentsByHandoffId.get(handoffId) ?? [];
  list.push(artifact);
  attachmentsByHandoffId.set(handoffId, list);

  if (attachmentsByHandoffId.size > MAX_ATTACHMENTS_CACHE) {
    const oldestKey = attachmentsByHandoffId.keys().next().value;
    if (oldestKey !== undefined) {
      attachmentsByHandoffId.delete(oldestKey);
    }
  }
}

export function clearHandoffAttachmentsForTest(): void {
  attachmentsByHandoffId.clear();
}
