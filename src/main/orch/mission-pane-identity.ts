/**
 * Identidade durável de um membro da composição (`missionPanes.record`).
 * Adapter + model + account + cwd + title + role + incarnation.
 * First-wave 068: 7 clones Codex com o mesmo title colapsavam em 1 row.
 */
export function missionPaneCompositionIdentity(input: {
  readonly adapterId: string;
  readonly model?: string | null;
  readonly accountId?: string | null;
  readonly cwd?: string | null;
  readonly title: string;
  readonly role: string;
  readonly workerIncarnationId?: string | null;
}): string {
  return [
    input.adapterId,
    input.model ?? '',
    input.accountId ?? '',
    input.cwd ?? '',
    input.title,
    input.role,
    input.workerIncarnationId ?? '',
  ].join('\0');
}

export function sameMissionPaneComposition(
  left: Parameters<typeof missionPaneCompositionIdentity>[0],
  right: Parameters<typeof missionPaneCompositionIdentity>[0],
): boolean {
  return (
    missionPaneCompositionIdentity(left) ===
    missionPaneCompositionIdentity(right)
  );
}
