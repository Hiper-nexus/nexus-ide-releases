// F-1035 — entrada do harness visual, empacotada por run.mjs (esbuild troca os
// módulos do Electron por desktop-fakes.ts). Ver docs/MOBILE-VISUAL.md.
import path from 'node:path'
import { startBridgeFixture } from './bridge-fixture'
import { runVisual } from './drive'

export async function main(opts: { repo: string; webRoot: string; serve: boolean }): Promise<number> {
  if (opts.serve) {
    // Modo manual: bridge + app no ar até Ctrl-C, para abrir num Chrome à mão.
    const fixture = await startBridgeFixture({ webRoot: opts.webRoot })
    const approval = fixture.openApproval()
    void approval.decision.then((decision) => console.log(`aprovação respondida: ${decision}`))
    console.log(`app:        ${fixture.appUrl}`)
    console.log(`pareamento: ${fixture.pairingUrl()}`)
    console.log(`bridge:     wss://127.0.0.1:${fixture.bridgePort} (repasse sem Origin em ${fixture.frontPort})`)
    console.log('Chrome precisa de --ignore-certificate-errors (certificado autoassinado local). Ctrl-C encerra.')
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve())
      process.once('SIGTERM', () => resolve())
    })
    fixture.stop()
    return 0
  }
  const ok = await runVisual({
    webRoot: opts.webRoot,
    outDir: path.join(opts.repo, 'docs', 'qa', 'evidence', 'mobile-web')
  })
  return ok ? 0 : 1
}
