/**
 * Uma sessão de writer credita no máximo uma task selada — MCP/PTY
 * SUCCESS ou files-modified no done, nunca os dois. Arquivos já
 * creditados não fecham uma segunda task no reconcile do disco.
 * Recibo SUCCESS no store também trava files-modified (o gancho PTY
 * local pode avançar o board sem passar por aqui).
 */
const creditedSessions = new Set<string>();
const creditedFilesByMission = new Map<string, Set<string>>();

export function markSessionSealedBoardCredited(sessionId: string): void {
  const id = sessionId.trim();
  if (id) creditedSessions.add(id);
}

export function sessionAlreadyCreditedSealedBoard(sessionId: string): boolean {
  return creditedSessions.has(sessionId.trim());
}

function missionFileSet(missionId: string): Set<string> {
  let set = creditedFilesByMission.get(missionId);
  if (!set) {
    set = new Set<string>();
    creditedFilesByMission.set(missionId, set);
  }
  return set;
}

export function markMissionFilesCredited(
  missionId: string,
  files: readonly string[],
): void {
  const id = missionId.trim();
  if (!id) return;
  const set = missionFileSet(id);
  for (const file of files) {
    const normalized = file.trim().replace(/\\/g, '/');
    if (normalized) set.add(normalized);
  }
}

export function uncreditedMissionFiles(
  missionId: string,
  files: readonly string[],
): string[] {
  const credited = creditedFilesByMission.get(missionId.trim());
  if (!credited || credited.size === 0) return [...files];
  return files.filter((file) => !credited.has(file.replace(/\\/g, '/')));
}

export function clearSealedBoardSessionCredits(): void {
  creditedSessions.clear();
  creditedFilesByMission.clear();
}
