// F-1035 — SÓ o harness visual (`npm run mobile:visual`, docs/MOBILE-VISUAL.md).
//
// O harness renderiza o app no alvo web contra a Remote Bridge real em
// https://127.0.0.1:<porta>; o pareamento recusa IP/localhost por desenho (só
// Tailscale HTTPS). Esta exceção vale apenas quando as três travas coincidem:
//   1. alvo web — este arquivo `.web.ts` não entra em bundle iOS/Android;
//   2. a variável EXPO_PUBLIC_NEXUS_VISUAL_HARNESS=1 no momento do export (o
//      babel-preset-expo a substitui por literal; sem ela vira `undefined` e o
//      ramo inteiro some);
//   3. host exatamente 127.0.0.1 (o proxy local do harness).
// Fora disso, o comportamento é o do app: QR com IP é recusado.
export function nexusVisualHarnessAllowsHost(host: string): boolean {
  return process.env.EXPO_PUBLIC_NEXUS_VISUAL_HARNESS === '1' && host === '127.0.0.1'
}
