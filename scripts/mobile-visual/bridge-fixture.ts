// F-1035 — fixture do harness visual (docs/MOBILE-VISUAL.md).
//
// Sobe a Remote Bridge REAL do desktop em processo (HTTPS/WSS, pareamento,
// desafio assinado, política mobile, broker de aprovação, Git/arquivos do
// checkout) com panes/PTY/missões simulados (desktop-fakes.ts) e, na frente
// dela, um servidor HTTPS local que:
//   - serve o export web do app (mobile/web-build) como SPA;
//   - repassa o upgrade WebSocket para a bridge SEM o header Origin.
// Por quê: o WebSocket nativo do React Native não manda Origin, e a bridge
// recusa Origin de outro site (defesa contra sequestro de WebSocket). O navegador
// sempre manda; tirar o header aqui reproduz o app nativo sem afrouxar a bridge.
// Como o Tailscale Serve, o repasse chega à bridge pelo loopback.
//
// Uso direto (fica no ar até Ctrl-C): `node scripts/mobile-visual/run.mjs --serve`.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { generate } from 'selfsigned'
import { desktopFixture } from './desktop-fakes'

export type BridgeFixture = {
  /** https://127.0.0.1:<porta>/ — o app web. */
  readonly appUrl: string
  readonly bridgePort: number
  readonly frontPort: number
  /** Gira o código (como "Girar código de pareamento") e devolve o link do QR. */
  pairingUrl(): string
  /** true enquanto a bridge ainda tem um código de pareamento não usado. */
  pairingCodeOutstanding(): boolean
  /** Abre um pedido de aprovação real no broker para o pane principal. */
  openApproval(): { requestId: string; decision: Promise<string | null> }
  /** "Revogar aparelhos" do desktop. */
  revoke(): void
  readonly desktop: typeof desktopFixture
  stop(): void
}

const SCOPE = {
  version: 1 as const,
  installationId: 'install-visual',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest' as const
}

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Harness', '-c', 'user.email=harness@example.invalid', ...args], {
    cwd,
    stdio: 'ignore'
  })
}

/** Checkout git real com alterações (preparada, não preparada, novo, segredo) para F-1014. */
function createCheckout(base: string): string {
  const repo = path.join(base, 'nexus-demo')
  fs.mkdirSync(path.join(repo, 'src', 'transport'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'docs'))
  fs.writeFileSync(
    path.join(repo, 'README.md'),
    '# nexus-demo\n\nlinha 1\nlinha 2\nlinha 3\n\nComo rodar: `npm test`.\n'
  )
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const a = 1;\n')
  fs.writeFileSync(
    path.join(repo, 'src', 'transport', 'bridge-client.ts'),
    [
      "import { connect } from './socket'",
      '',
      'export async function pair(code: string): Promise<string> {',
      '  const socket = await connect()',
      "  return socket.request('pair', { code })",
      '}',
      ''
    ].join('\n')
  )
  fs.writeFileSync(path.join(repo, 'docs', 'arquitetura.md'), '# Arquitetura\n\nBridge → app.\n')
  fs.writeFileSync(path.join(repo, '.env'), 'API_TOKEN=old\n')
  gitIn(repo, 'init', '-q', '-b', 'main')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'base')
  fs.writeFileSync(
    path.join(repo, 'README.md'),
    '# nexus-demo\n\nlinha 1\nlinha dois, agora com uma frase bem mais longa para ver a quebra no celular\nlinha 3\n\nComo rodar: `npm test` (ou `npm run mobile:visual`).\n'
  )
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const a = 2;\n')
  gitIn(repo, 'add', 'src/app.ts')
  fs.writeFileSync(
    path.join(repo, 'src', 'transport', 'bridge-client.ts'),
    [
      "import { connect } from './socket'",
      '',
      'export async function pair(code: string, timeoutMs = 25_000): Promise<string> {',
      '  const socket = await connect({ timeoutMs })',
      "  return socket.request('pair', { code: code.trim().toUpperCase() })",
      '}',
      ''
    ].join('\n')
  )
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'nova nota do harness\n')
  fs.writeFileSync(path.join(repo, '.env'), 'API_TOKEN=new-secret\n')
  return repo
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

function serveStatic(webRoot: string) {
  const root = fs.realpathSync(webRoot)
  return (req: IncomingMessage, res: ServerResponse) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'https://x').pathname)
    let file = path.join(root, path.normalize(pathname))
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // SPA: rotas do expo-router (/h/<id>, /pair-scan…) caem no index.html.
      file = path.join(root, 'index.html')
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store'
    })
    fs.createReadStream(file).pipe(res)
  }
}

/** Repassa o upgrade para a bridge sem `Origin` (como o WebSocket nativo do RN). */
function proxyUpgrade(bridgePort: number) {
  return (req: IncomingMessage, client: Duplex, head: Buffer) => {
    // Só o harness: o certificado autoassinado da bridge local não é verificado.
    const upstream = tls.connect({ host: '127.0.0.1', port: bridgePort, rejectUnauthorized: false }, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!
        if (name.toLowerCase() === 'origin') continue
        lines.push(`${name}: ${req.rawHeaders[i + 1]}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    const drop = () => {
      upstream.destroy()
      client.destroy()
    }
    upstream.on('error', drop)
    client.on('error', drop)
    upstream.on('close', () => client.destroy())
    client.on('close', () => upstream.destroy())
  }
}

export async function startBridgeFixture(opts: { webRoot: string }): Promise<BridgeFixture> {
  // A bridge guarda TLS e tokens em ~/.nexus/remote-bridge, lido ao importar o
  // módulo: um HOME temporário antes do import isola o perfil real do operador.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mobile-visual-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  desktopFixture.repo = createCheckout(fs.realpathSync(home))
  const bridge = await import('../../src/main/remote/remote-bridge')
  const broker = await import('../../src/main/agent-hooks/approval-broker')
  const info = await bridge.startRemoteBridge({ host: '127.0.0.1' }, SCOPE)
  const bridgePort = info.port!

  const pems = await generate([{ name: 'commonName', value: '127.0.0.1' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]
  })
  const front = https.createServer({ key: pems.private, cert: pems.cert }, serveStatic(opts.webRoot))
  front.on('upgrade', proxyUpgrade(bridgePort))
  await new Promise<void>((resolve, reject) => {
    front.once('error', reject)
    front.listen(0, '127.0.0.1', () => resolve())
  })
  const address = front.address()
  const frontPort = typeof address === 'object' && address ? address.port : 0
  const origin = `https://127.0.0.1:${frontPort}`

  return {
    appUrl: `${origin}/`,
    bridgePort,
    frontPort,
    desktop: desktopFixture,
    pairingUrl() {
      const code = bridge.rotateRemotePairing(SCOPE).pairingCode
      if (!code) throw new Error('a bridge não emitiu código de pareamento')
      return `${origin}/#code=${code}`
    },
    pairingCodeOutstanding() {
      return bridge.getRemoteBridgeInfo(SCOPE).pairingCode !== undefined
    },
    openApproval() {
      const opened = broker.approvalBroker.open({
        sessionId: 'sess-app',
        provider: 'claude',
        tool: 'Bash',
        summary: 'ls -la mobile/src/transport',
        options: [{ optionId: 'accept' }, { optionId: 'decline' }],
        waitMs: 30 * 60_000,
        fingerprint: broker.approvalFingerprint('Bash', { command: 'ls -la mobile/src/transport' }),
        highImpact: false
      })
      if (!opened) throw new Error('o broker recusou abrir a aprovação')
      return { requestId: opened.request.requestId, decision: opened.decision }
    },
    revoke() {
      bridge.revokeRemoteTokens(SCOPE)
    },
    stop() {
      front.close()
      bridge.stopRemoteBridge()
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
}
