/**
 * F-1310 — `artifacts` do worker que não chegam em lista.
 *
 * O schema MCP anuncia `artifacts` como array, mas o transporte aceita o valor
 * cru e o contrato `expect.schema` do spawn pode pedir QUALQUER forma (um
 * objeto `{ findings: [...] }` era o contrato real da s240). Descartar calado
 * apagava a entrega inteira do handoff registrado — o orquestrador via só os
 * artifacts gerados pelo Main. Um valor que não é lista vira UM artifact
 * `nexus.workerArtifacts` com o payload intacto; a lista passa sem toque.
 */
export const WORKER_ARTIFACTS_KIND = "nexus.workerArtifacts";

export function workerArtifactsList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value)
    ? value
    : [{ kind: WORKER_ARTIFACTS_KIND, payload: value }];
}
