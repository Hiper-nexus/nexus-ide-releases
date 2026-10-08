// F-1035 — harness visual do app mobile (docs/MOBILE-VISUAL.md).
//
// O que precisaria do Electron é simulado AQUI, exatamente como os vi.mock de
// src/main/remote/remote-bridge.mobile-app.test.ts: registro de panes, PTY,
// missões, autorização por projeto e o diálogo de confirmação do desktop. O
// esbuild (run.mjs) troca só estes cinco módulos; todo o resto — Remote Bridge,
// TLS, pareamento, desafio assinado, política mobile, broker de aprovação, Git e
// arquivos do checkout — é o código real do Main.

type FakePane = {
  paneId: string
  sessionId: string
  paneNumber: number
  title: string
  kind: 'cli-agent' | 'shell'
  state: 'busy' | 'idle'
  projectId: string
}

/** Estado observável do "desktop" simulado: o driver confere o que chegou aqui. */
export const desktopFixture = {
  repo: '',
  writes: [] as Array<[string, string]>,
  resizes: [] as Array<[string, number, number]>,
  confirmations: [] as string[],
  closes: [] as string[],
  tap: null as ((sessionId: string, data: string) => void) | null,
  transcripts: new Map<string, string>(),
  panes: [
    {
      paneId: 'pane-app',
      sessionId: 'sess-app',
      paneNumber: 4,
      title: 'Claude · x8 · porta o transporte',
      kind: 'cli-agent',
      state: 'busy',
      projectId: 'project-a'
    },
    {
      paneId: 'pane-review',
      sessionId: 'sess-review',
      paneNumber: 5,
      title: 'Codex · revisão do diff',
      kind: 'cli-agent',
      state: 'idle',
      projectId: 'project-a'
    },
    {
      paneId: 'pane-shell',
      sessionId: 'sess-shell',
      paneNumber: 6,
      title: 'zsh',
      kind: 'shell',
      state: 'idle',
      projectId: 'project-a'
    }
  ] as FakePane[],
  missions: [
    { id: 'mis-1', title: 'Portar o transporte do app para a bridge', status: 'running', updatedAt: 3 },
    { id: 'mis-2', title: 'Revisar F-1014 (Git e arquivos no celular)', status: 'running', updatedAt: 2 },
    { id: 'mis-3', title: 'Release 0.76 — notas', status: 'done', updatedAt: 1 }
  ]
}

desktopFixture.transcripts.set(
  'sess-app',
  [
    '╭─ Claude Code ─────────────────────────────╮',
    '│ cwd: ~/nexus-ide                          │',
    '╰───────────────────────────────────────────╯',
    '> porte o cliente da bridge para o app',
    '',
    '● Lendo mobile/src/transport/nexus-bridge-client.ts',
    '● Rodando vitest run src/transport (42 testes)',
    '  ✓ 42 passaram em 3.1s',
    '● Editando nexus-bridge-rpc-adapter.ts (+36 −4)',
    '',
    'Preciso rodar `ls -la` para conferir os arquivos gerados.',
    ''
  ].join('\n')
)
desktopFixture.transcripts.set(
  'sess-review',
  'Revisão: 3 achados (1 bloqueante) em remote-workspace-rpc.ts\n- caminho com .. não normalizado\n'
)
desktopFixture.transcripts.set('sess-shell', '$ npm test\n\n Test Files  412 passed (412)\n      Tests  5210 passed\n$ \n')

function paneBy(ref: string): FakePane | undefined {
  return desktopFixture.panes.find((pane) => pane.paneId === ref || pane.sessionId === ref)
}

// ─── ../orch/project-domain-store-registry ───
export function getProjectDomainStores() {
  return { missions: { list: () => desktopFixture.missions } }
}

// ─── ../orch/pane-registry ───
export function getPaneAuthzInfo(ref: string) {
  const pane = paneBy(ref)
  if (!pane) return null
  return {
    paneId: pane.paneId,
    sessionId: pane.sessionId,
    projectId: pane.projectId,
    checkoutId: 'checkout-a',
    kind: pane.kind,
    // Só `rootRealPath` importa para Git/arquivos do pane (F-1014).
    scope: { rootRealPath: desktopFixture.repo }
  }
}

export function listVisiblePaneSnapshots() {
  return desktopFixture.panes.map(({ paneId, sessionId, paneNumber, title, kind, state }) => ({
    paneId,
    sessionId,
    paneNumber,
    title,
    kind,
    state
  }))
}

export function readSessionOutput(sessionId: string): string {
  return desktopFixture.transcripts.get(sessionId) ?? ''
}

export function requestPaneClose(paneId: string): boolean {
  desktopFixture.closes.push(paneId)
  return true
}

// ─── ../orch/pane-authz ───
export function authorizePaneAccess(
  caller: { scope: { projectId: string } },
  pane: { projectId: string }
) {
  return caller.scope.projectId === pane.projectId
    ? { allow: true as const }
    : { allow: false as const, reason: 'scope' }
}

// ─── ../pty/pty-manager ───
/** O "shell": grava a linha e, como um PTY, devolve a saída pelo tap pouco depois. */
export function orchWriteSession(sessionId: string, data: string): boolean {
  desktopFixture.writes.push([sessionId, data])
  const reply = data.trim() === 'git status'
    ? 'On branch main\nChanges to be committed:\n  modified:   src/app.ts\nChanges not staged for commit:\n  modified:   README.md\n'
    : 'ok\n'
  const echoed = `$ ${data}${reply}`
  desktopFixture.transcripts.set(sessionId, `${readSessionOutput(sessionId)}${echoed}`)
  setTimeout(() => desktopFixture.tap?.(sessionId, echoed.replaceAll('\n', '\r\n')), 5)
  return true
}

export function orchResizeSession(sessionId: string, cols: number, rows: number): boolean {
  desktopFixture.resizes.push([sessionId, cols, rows])
  return true
}

export function tapSessionData(cb: (sessionId: string, data: string) => void): () => void {
  desktopFixture.tap = cb
  return () => {
    if (desktopFixture.tap === cb) desktopFixture.tap = null
  }
}

// ─── ./remote-desktop-confirmation ───
/** O desktop "recusa" tudo que pediria confirmação: o harness só manda comandos de rotina. */
export async function requestRemoteDesktopConfirmation(...args: unknown[]): Promise<boolean> {
  desktopFixture.confirmations.push(JSON.stringify(args).slice(0, 200))
  return false
}
