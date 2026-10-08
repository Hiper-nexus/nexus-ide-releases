// F-1035: no app de verdade (iOS/Android) e nos testes, NUNCA há exceção — o QR
// com IP/localhost continua recusado (NEXUS_SELF_SIGNED_MESSAGE). A exceção do
// harness visual existe só em `nexus-bridge-visual-harness.web.ts`, que o Metro
// usa apenas no alvo web; um bundle nativo nem contém aquele arquivo.
export function nexusVisualHarnessAllowsHost(_host: string): boolean {
  return false
}
