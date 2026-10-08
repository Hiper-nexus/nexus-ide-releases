/**
 * Canais IPC do card de aprovação do desktop (PRV-02). Sem dependências: o
 * preload sandboxed e o Main importam este arquivo.
 */
export const APPROVAL_CHANNELS = {
  /** invoke: renderer → main. Pedidos pendentes do broker. */
  list: 'approvals:list',
  /** invoke: renderer → main. `{ requestId, expectedRevision, optionId }` → resultado do broker. */
  respond: 'approvals:respond',
  /**
   * invoke: renderer → main. Sessões cujo card está VISÍVEL agora — é o que
   * faz o hook PermissionRequest esperar pelo desktop.
   */
  surfaces: 'approvals:surfaces',
  /** push: main → renderer. A lista mudou (abriu, respondeu, expirou). */
  changed: 'approvals:changed',
} as const;
