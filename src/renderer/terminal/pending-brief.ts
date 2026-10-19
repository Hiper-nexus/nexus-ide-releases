/**
 * First prompt of a pane opened for a task (F-1596: "Novo vídeo de
 * apresentação"). Kept in memory by pane id until the pane's CLI is ready;
 * terminal-host delivers it once, through the same readiness wait the
 * continuity pack uses. Never persisted: a restart drops an undelivered brief.
 */

const pending = new Map<string, string>();
const MAX_BRIEF_CHARS = 8_000;

export function stashPendingBrief(paneId: string, brief: string): void {
  const text = brief.trim().slice(0, MAX_BRIEF_CHARS);
  if (text) pending.set(paneId, text);
}

export function takePendingBrief(paneId: string): string | undefined {
  const brief = pending.get(paneId);
  pending.delete(paneId);
  return brief;
}
