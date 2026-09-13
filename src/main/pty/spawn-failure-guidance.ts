/**
 * Operator-facing translation for PTY pre-spawn supervisor failures.
 *
 * The packaged Darwin PTY supervisor fails CLOSED on any ownership doubt:
 * when the app bundle on disk changed while this process was already running
 * (hot-swap, update, manual replace), the live main/utility image no longer
 * resolves inside the current bundle and every spawn is refused before a
 * process tree exists. That refusal is correct — but dumping the raw English
 * preflight text into the pane leaves the operator with an undecipherable
 * dead terminal (bug report 2026-08-18). This pure mapper turns the known
 * failure classes into one actionable sentence; unknown failures stay raw
 * (null) so we never invent guidance we cannot stand behind.
 */

/** Bundle changed underneath the running process → restart heals it. */
const SWAPPED_BUNDLE_MARKERS = [
  'application bundle does not own the running main/utility code chain',
  'running executable is not the exact main/utility image inside this bundle',
] as const;

/** Bundle or Resources was removed, deleted, or unlinked while running. */
const MISSING_BUNDLE_MARKERS = [
  'no such file or directory',
  'ENOENT',
  'packaged application has no absolute resourcesPath',
  'resourcesPath is not inside a macOS application bundle',
] as const;

/** Signature chain broken → reinstall, a restart cannot heal this. */
const BROKEN_SIGNATURE_MARKERS = [
  'must both carry Nexus Team ID',
  'code signature has no CDHash',
  'packaged Resources is not an application-owned directory',
] as const;

export function spawnFailureGuidance(errorText: string): string | null {
  const text = errorText ?? '';
  if (SWAPPED_BUNDLE_MARKERS.some((marker) => text.includes(marker))) {
    return (
      'O Nexus foi atualizado em disco enquanto estava aberto — feche e ' +
      'reabra o Nexus para religar os terminais; a missão continua no rail.'
    );
  }
  if (
    text.includes('Packaged Darwin PTY responsibility supervisor') &&
    MISSING_BUNDLE_MARKERS.some((marker) => text.includes(marker))
  ) {
    return (
      'O aplicativo NexusIDE no disco foi apagado, movido ou reinstalado enquanto estava aberto — ' +
      'feche e reabra o Nexus (ou gere um novo build) para religar os terminais.'
    );
  }
  if (BROKEN_SIGNATURE_MARKERS.some((marker) => text.includes(marker))) {
    return (
      'A instalação do Nexus parece corrompida ou incompleta — reinstale o ' +
      'app e abra de novo; a missão continua no rail.'
    );
  }
  return null;
}
