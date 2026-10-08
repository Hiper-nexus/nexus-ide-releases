import crypto from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NexusBridgeClient,
  type NexusBridgeSocketFactory,
  type NexusBridgeSocketHandlers
} from './nexus-bridge-client'
import { createNexusBridgeDeviceKey, nexusBridgeDeviceIdentity } from './nexus-bridge-device-key'
import {
  NEXUS_HOST_UNSUPPORTED,
  NEXUS_RAW_KEYS_MESSAGE,
  createNexusBridgeRpcClient,
  type NexusPaneOutput
} from './nexus-bridge-rpc-adapter'
import { isRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { TerminalStreamOpcode, encodeTerminalStreamFrame } from './terminal-stream-protocol'

type Frame = { id: string; type: string; [key: string]: unknown }
type Reply = { result: unknown } | { error: string } | 'hold'

const identity = nexusBridgeDeviceIdentity(
  createNexusBridgeDeviceKey((length) => new Uint8Array(crypto.randomBytes(length)))
)

// O desktop real verifica assim (remote-device-authority.ts): JWK P-256 + IEEE-P1363.
function verifiesLikeDesktop(challenge: string, signature: unknown): boolean {
  return (
    typeof signature === 'string' &&
    crypto.verify(
      'sha256',
      Buffer.from(challenge),
      {
        key: crypto.createPublicKey({ key: { ...identity.publicKey }, format: 'jwk' }),
        dsaEncoding: 'ieee-p1363'
      },
      Buffer.from(signature, 'base64url')
    )
  )
}

class FakeSocket {
  readonly sent: Frame[] = []
  closed = false
  constructor(
    readonly handlers: NexusBridgeSocketHandlers,
    private readonly bridge: FakeBridge
  ) {}
  send(data: string): void {
    const frame = JSON.parse(data) as Frame
    this.sent.push(frame)
    const reply = this.bridge.reply(frame)
    if (reply === 'hold') {
      return
    }
    queueMicrotask(() =>
      this.handlers.onMessage(
        JSON.stringify(
          'error' in reply
            ? { id: frame.id, ok: false, error: reply.error }
            : { id: frame.id, ok: true, result: reply.result }
        )
      )
    )
  }
  close(): void {
    this.closed = true
  }
  push(message: Record<string, unknown>): void {
    this.handlers.onMessage(JSON.stringify(message))
  }
  types(): string[] {
    return this.sent.map((frame) => frame.type)
  }
}

class FakeBridge {
  readonly sockets: FakeSocket[] = []
  overrides: Partial<Record<string, (frame: Frame) => Reply>> = {}
  /** Quantos sockets seguintes falham antes de abrir (rede fora, TLS recusado). */
  failOpens = 0
  readonly factory: NexusBridgeSocketFactory = (_url, handlers) => {
    const socket = new FakeSocket(handlers, this)
    this.sockets.push(socket)
    const fails = this.failOpens > 0
    this.failOpens -= fails ? 1 : 0
    queueMicrotask(() => (fails ? handlers.onClose(1006, '') : handlers.onOpen()))
    return socket
  }
  get last(): FakeSocket {
    return this.sockets[this.sockets.length - 1]!
  }
  reply(frame: Frame): Reply {
    const override = this.overrides[frame.type]
    if (override) {
      return override(frame)
    }
    switch (frame.type) {
      case 'auth.challenge':
        return { result: { challengeId: 'c1', challenge: 'nexus-remote-auth-v1:abc' } }
      case 'auth':
        return frame.token === 'tok' && verifiesLikeDesktop('nexus-remote-auth-v1:abc', frame.signature)
          ? { result: { ok: true } }
          : { error: 'invalid device authentication' }
      case 'status':
        return { result: { running: true, port: 4443, tokenCount: 1 } }
      case 'ops.snapshot':
        return {
          result: {
            panes: [{ paneId: 'p1', title: 'Claude', state: 'busy', kind: 'cli-agent', paneNumber: 3 }, { bogus: true }],
            missions: [{ id: 'm1', title: 'Missão', status: 'running' }],
            approvals: [
              {
                requestId: 'r1',
                revision: 1,
                paneId: 'p1',
                tool: 'Bash',
                summary: 'ls',
                options: [{ optionId: 'accept' }, { optionId: 'decline' }],
                responseCapability: 'live',
                expiresAt: 99
              },
              { requestId: 'r2', revision: 1, paneId: 'p1', tool: 'Bash', options: [{ optionId: 'acceptAlways' }] }
            ]
          }
        }
      case 'pane.stream.open':
        return { result: { streamId: 7, pushAvailable: true, pushSeq: 3 } }
      case 'pane.read':
        return { result: { output: '\u001b[32mhello\u001b[0m\n', stream: { pushSeq: 3 } } }
      case 'pane.input':
      case 'pane.close':
      case 'pane.resize':
      case 'pane.stream.close':
        return { result: { ok: true } }
      case 'agentSession.respondToApproval':
        return { result: { status: 'accepted' } }
      default:
        return { error: `unknown command: ${frame.type}` }
    }
  }
}

function frameBase64(text: string, seq: number): string {
  return Buffer.from(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Output,
      streamId: 7,
      seq,
      payload: new TextEncoder().encode(text)
    })
  ).toString('base64')
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function open(bridge: FakeBridge, extra: { reconnectBaseMs?: number } = {}) {
  const logs: string[] = []
  const client = createNexusBridgeRpcClient({
    url: 'wss://mac.tail.ts.net',
    token: 'tok',
    identity: async () => identity,
    createSocket: bridge.factory,
    random: () => 0.5,
    onLog: (_level, message) => logs.push(message),
    ...extra
  })
  return { client, logs }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Nexus bridge transport — handshake', () => {
  it('authenticates a saved token with a challenge signature the desktop verifier accepts', async () => {
    const bridge = new FakeBridge()
    const { client } = open(bridge)
    await settle()
    expect(bridge.last.types()).toEqual(['auth.challenge', 'auth'])
    expect(bridge.last.sent[0]).toMatchObject({ token: 'tok', deviceId: identity.deviceId })
    expect(client.getState()).toBe('connected')
    client.close()
  })

  it('a rejected credential is final: auth-failed, no reconnect loop, requests refuse', async () => {
    const bridge = new FakeBridge()
    bridge.overrides.auth = () => ({ error: 'invalid device authentication' })
    const { client } = open(bridge, { reconnectBaseMs: 1 })
    await settle()
    expect(client.getState()).toBe('auth-failed')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(bridge.sockets).toHaveLength(1)
    await expect(client.sendRequest('status.get')).rejects.toThrow(/pareie de novo/)
  })

  it('a live revocation close goes to auth-failed instead of reconnecting', async () => {
    const bridge = new FakeBridge()
    const { client } = open(bridge, { reconnectBaseMs: 1 })
    await settle()
    bridge.last.handlers.onClose(1008, 'tokens revoked')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.getState()).toBe('auth-failed')
    expect(bridge.sockets).toHaveLength(1)
  })
})

describe('Nexus bridge adapter — Orca methods mapped to bridge commands', () => {
  it('maps status, terminal list, send line, close, viewport, missions and approvals', async () => {
    const bridge = new FakeBridge()
    const { client } = open(bridge)
    await settle()

    await expect(client.sendRequest('status.get')).resolves.toMatchObject({
      ok: true,
      result: { running: true, nexusBridge: true }
    })
    await expect(client.sendRequest('terminal.list')).resolves.toMatchObject({
      ok: true,
      result: { terminals: [{ handle: 'p1', title: 'Claude', state: 'busy', kind: 'cli-agent' }] }
    })
    await expect(
      client.sendRequest('terminal.send', {
        terminal: 'p1',
        text: 'git status',
        enter: true,
        clientMessageId: 'msg-1'
      })
    ).resolves.toMatchObject({ ok: true })
    expect(bridge.last.sent.find((frame) => frame.type === 'pane.input')).toMatchObject({
      paneId: 'p1',
      data: 'git status',
      messageId: 'msg-1'
    })
    await client.sendRequest('terminal.close', { terminal: 'p1' })
    await client.sendRequest('terminal.updateViewport', {
      terminal: 'p1',
      viewport: { cols: 80, rows: 24 }
    })
    await client.sendRequest('mission.list')
    await expect(
      client.sendRequest('agentSession.respondToApproval', {
        itemId: 'r1',
        expectedRevision: 1,
        optionId: 'decline',
        extra: 'dropped'
      })
    ).resolves.toMatchObject({ ok: true, result: { status: 'accepted' } })
    const sent = bridge.last.sent
    expect(sent.find((frame) => frame.type === 'pane.close')).toMatchObject({ paneId: 'p1' })
    expect(sent.find((frame) => frame.type === 'pane.resize')).toMatchObject({
      paneId: 'p1',
      cols: 80,
      rows: 24
    })
    expect(sent.some((frame) => frame.type === 'mission.list')).toBe(true)
    const approval = sent.find((frame) => frame.type === 'agentSession.respondToApproval')
    expect(approval).toMatchObject({ itemId: 'r1', expectedRevision: 1, optionId: 'decline' })
    expect(approval).not.toHaveProperty('extra')
    client.close()
  })

  it('refuses raw keys and unmapped areas explicitly, without touching the bridge', async () => {
    const bridge = new FakeBridge()
    const { client, logs } = open(bridge)
    await settle()
    const before = bridge.last.sent.length

    const escape = await client.sendRequest('terminal.send', {
      terminal: 'p1',
      text: '\u001b',
      enter: false
    })
    expect(escape).toMatchObject({ ok: false, error: { code: NEXUS_HOST_UNSUPPORTED, message: NEXUS_RAW_KEYS_MESSAGE } })
    const ctrlC = await client.sendRequest('terminal.send', { terminal: 'p1', text: '\u0003', enter: true })
    expect(ctrlC).toMatchObject({ ok: false, error: { code: NEXUS_HOST_UNSUPPORTED } })
    // "1" sem Enter (escolha de menu da TUI) é tecla crua: virar "1\n" mudaria o que o agente recebe.
    const menuKey = await client.sendRequest('terminal.send', { terminal: 'p1', text: '1', enter: false })
    expect(menuKey).toMatchObject({ ok: false, error: { code: NEXUS_HOST_UNSUPPORTED, message: NEXUS_RAW_KEYS_MESSAGE } })

    // F-1014: git.status/git.diff/files.list/files.read são atendidos; a escrita segue recusada.
    for (const method of ['git.commit', 'git.stage', 'files.write', 'worktree.ps', 'session.tabs.list', 'speech.models.list', 'linear.listIssues']) {
      const response = await client.sendRequest(method)
      expect(response).toMatchObject({ ok: false, error: { code: NEXUS_HOST_UNSUPPORTED } })
      expect(!response.ok && response.error.message).toMatch(/não disponível em host Nexus$/)
    }
    const unsubscribe = client.subscribe('accounts.subscribe', null, () => {
      throw new Error('never delivered')
    })
    unsubscribe()
    expect(bridge.last.sent.length).toBe(before)
    expect(logs).toContain('Escrita no Git (git.commit) não disponível em host Nexus')
    expect(logs).toContain('Escrita e busca de arquivos (files.write) não disponível em host Nexus')
    expect(logs).toContain('Contas (accounts.subscribe) não disponível em host Nexus')
    client.close()
  })

  it('F-1014: maps git.status/git.diff/files.list/files.read (Orca names) to read-only bridge commands', async () => {
    const bridge = new FakeBridge()
    bridge.overrides['git.status'] = () => ({
      result: {
        paneId: 'p1',
        branch: 'main',
        ahead: 1,
        behind: 0,
        hasUpstream: true,
        clean: false,
        truncated: false,
        hasUnresolvedConflicts: true,
        staged: [{ path: 'src/a.ts', status: 'M' }],
        unstaged: [
          { path: 'b.ts', status: 'D' },
          { path: 'c.ts', status: 'U' },
          { path: 'new.ts', status: 'R', originalPath: 'old.ts' },
          { path: '.env', status: 'M', restricted: true },
          { bogus: true }
        ],
        untracked: [{ path: 'notes.txt', status: '?' }]
      }
    })
    bridge.overrides['git.diff'] = (frame) => ({
      result: { kind: 'patch', path: frame.path, staged: frame.staged, patch: '@@ -1 +1 @@\n-a\n+b\n', truncated: false }
    })
    bridge.overrides['files.list'] = (frame) => ({
      result: {
        path: frame.path,
        entries: [
          { name: 'src', path: 'src', kind: 'dir' },
          { name: 'x', path: 'x', kind: 'symlink' }
        ],
        truncated: false
      }
    })
    bridge.overrides['files.read'] = (frame) => ({
      result: { path: frame.path, content: 'oi\n', truncated: false, byteLength: 3, binary: false }
    })
    const { client } = open(bridge)
    await settle()

    const status = await client.sendRequest('git.status', { worktree: 'id:p1' })
    expect(status).toMatchObject({
      ok: true,
      result: {
        branch: 'main',
        upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 },
        clean: false,
        entries: [
          { path: 'src/a.ts', area: 'staged', status: 'modified', letter: 'M', restricted: false },
          { path: 'b.ts', area: 'unstaged', status: 'deleted' },
          { path: 'c.ts', area: 'unstaged', status: 'modified', conflictStatus: 'unresolved' },
          { path: 'new.ts', area: 'unstaged', status: 'renamed', oldPath: 'old.ts' },
          { path: '.env', restricted: true },
          { path: 'notes.txt', area: 'untracked', status: 'untracked' }
        ]
      }
    })
    // O leitor de status das telas do Orca entende a mesma resposta.
    const { readMobileGitStatusResult } = await import('../session/mobile-diff-review-rpc')
    expect(readMobileGitStatusResult(status.ok ? status.result : null)?.entries).toHaveLength(6)

    await expect(
      client.sendRequest('git.diff', { worktree: 'id:p1', filePath: 'src/a.ts', staged: true })
    ).resolves.toMatchObject({ ok: true, result: { kind: 'patch', path: 'src/a.ts', staged: true } })
    await expect(
      client.sendRequest('files.list', { paneId: 'p1', path: 'src' })
    ).resolves.toMatchObject({ ok: true, result: { path: 'src', entries: [{ name: 'src', kind: 'dir' }] } })
    await expect(
      client.sendRequest('files.read', { worktree: 'id:p1', relativePath: 'README.md' })
    ).resolves.toMatchObject({ ok: true, result: { content: 'oi\n', truncated: false, byteLength: 3 } })
    await expect(client.nexus.workspace.gitDiff('p1', { path: 'notes.txt', area: 'untracked' })).resolves.toMatchObject({
      kind: 'patch'
    })

    const sent = bridge.last.sent
    expect(sent.find((frame) => frame.type === 'git.status')).toMatchObject({ paneId: 'p1' })
    expect(sent.filter((frame) => frame.type === 'git.diff')).toEqual([
      expect.objectContaining({ paneId: 'p1', path: 'src/a.ts', staged: true, untracked: false }),
      expect.objectContaining({ paneId: 'p1', path: 'notes.txt', staged: false, untracked: true })
    ])
    expect(sent.find((frame) => frame.type === 'files.list')).toMatchObject({ paneId: 'p1', path: 'src' })
    expect(sent.find((frame) => frame.type === 'files.read')).toMatchObject({ paneId: 'p1', path: 'README.md' })

    // Recusa do desktop (caminho para fora do checkout) vira falha do host, não erro de transporte.
    bridge.overrides['files.read'] = () => ({ error: 'not authorized: path-escapes-checkout' })
    await expect(client.sendRequest('files.read', { paneId: 'p1', relativePath: 'leak' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'nexus_bridge_refused', message: 'not authorized: path-escapes-checkout' }
    })
    // Sem pane: recusa de forma, sem ir à bridge.
    const before = bridge.last.sent.length
    await expect(client.sendRequest('files.read', { relativePath: 'x' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'nexus_bridge_refused', message: 'parâmetro paneId ausente' }
    })
    expect(bridge.last.sent.length).toBe(before)
    client.close()
  })

  it('surfaces a desktop refusal as a host failure, not a transport error', async () => {
    const bridge = new FakeBridge()
    bridge.overrides['pane.input'] = () => ({ error: 'not authorized: desktop confirmation required or denied' })
    const { client } = open(bridge)
    await settle()
    await expect(
      client.sendRequest('terminal.send', { terminal: 'p1', text: 'rm -rf build', enter: true })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'nexus_bridge_refused', message: 'not authorized: desktop confirmation required or denied' }
    })
    client.close()
  })

  it('marks a request that reached the wire as delivery-unknown when the socket drops', async () => {
    const bridge = new FakeBridge()
    bridge.overrides['pane.input'] = () => 'hold'
    const { client } = open(bridge, { reconnectBaseMs: 60_000 })
    await settle()
    const sending = client.sendRequest('terminal.send', { terminal: 'p1', text: 'git status', enter: true })
    await settle()
    bridge.last.handlers.onClose(1006, '')
    const error = await sending.catch((caught: unknown) => caught)
    expect(isRpcDeliveryUnknown(error)).toBe(true)
    client.close()
  })

  it('validates the ops snapshot: drops malformed panes and approvals', async () => {
    const bridge = new FakeBridge()
    const { client } = open(bridge)
    await settle()
    const snapshot = await client.nexus.snapshot()
    expect(snapshot.panes).toEqual([
      { paneId: 'p1', title: 'Claude', state: 'busy', kind: 'cli-agent', paneNumber: 3 }
    ])
    expect(snapshot.missions).toEqual([{ id: 'm1', title: 'Missão', status: 'running' }])
    expect(snapshot.approvals.map((approval) => approval.requestId)).toEqual(['r1'])
    expect(snapshot.approvals[0]).toMatchObject({ paneId: 'p1', revision: 1, responseCapability: 'live' })
    client.close()
  })
})

describe('Nexus bridge adapter — live pane output', () => {
  it('opens push before reading, applies pushes in order and resyncs on a gap', async () => {
    const bridge = new FakeBridge()
    const { client } = open(bridge)
    await settle()
    const outputs: NexusPaneOutput[] = []
    const unsubscribe = client.subscribe('terminal.subscribe', { terminal: 'p1' }, (output) =>
      outputs.push(output as NexusPaneOutput)
    )
    await settle()
    const types = bridge.last.types()
    expect(types.indexOf('pane.stream.open')).toBeLessThan(types.indexOf('pane.read'))
    expect(outputs).toEqual([{ type: 'nexus.output', text: 'hello\n', reset: true }])

    bridge.last.push({ type: 'pane.stream.data', streamId: 7, seq: 3, frameBase64: frameBase64('old', 3) })
    bridge.last.push({ type: 'pane.stream.data', streamId: 99, seq: 4, frameBase64: frameBase64('other', 4) })
    bridge.last.push({ type: 'pane.stream.data', streamId: 7, seq: 4, frameBase64: frameBase64('$ ls\r\n', 4) })
    expect(outputs.slice(1)).toEqual([{ type: 'nexus.output', text: '$ ls\n', reset: false }])

    const readsBefore = bridge.last.types().filter((type) => type === 'pane.read').length
    bridge.last.push({ type: 'pane.stream.data', streamId: 7, seq: 9, frameBase64: frameBase64('lost', 9) })
    await settle()
    expect(bridge.last.types().filter((type) => type === 'pane.read').length).toBe(readsBefore + 1)
    expect(outputs.at(-1)).toMatchObject({ reset: true })

    unsubscribe()
    await settle()
    expect(bridge.last.sent.at(-1)).toMatchObject({ type: 'pane.stream.close', paneId: 'p1' })
    client.close()
  })

  it('forwards approvals.changed pushes to the screen', async () => {
    const bridge = new FakeBridge()
    const { client } = open(bridge)
    await settle()
    const changed = vi.fn()
    const off = client.nexus.onApprovalsChanged(changed)
    bridge.last.push({ type: 'approvals.changed' })
    expect(changed).toHaveBeenCalledTimes(1)
    off()
    bridge.last.push({ type: 'approvals.changed' })
    expect(changed).toHaveBeenCalledTimes(1)
    client.close()
  })
})

describe('Nexus bridge transport — reconnection', () => {
  it('backs off exponentially, re-authenticates and re-opens the live pane on the new socket', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const bridge = new FakeBridge()
    const { client } = open(bridge, { reconnectBaseMs: 1_000 })
    await settle()
    client.subscribe('terminal.subscribe', { terminal: 'p1' }, () => undefined)
    await settle()

    // Primeira queda: 1 s (com jitter neutro). Ainda sem socket novo antes disso.
    bridge.failOpens = 1
    bridge.last.handlers.onClose(1006, '')
    expect(client.getState()).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(999)
    expect(bridge.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(bridge.sockets).toHaveLength(2)

    // O socket novo não abre (rede ainda fora): a próxima espera dobra.
    expect(client.getState()).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(1_999)
    expect(bridge.sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(bridge.sockets).toHaveLength(3)
    expect(client.getState()).toBe('connected')
    expect(client.getReconnectAttempt()).toBe(0)
    expect(bridge.last.types()).toEqual(['auth.challenge', 'auth', 'pane.stream.open', 'pane.read'])
    client.close()
  })

  it('a transient auth refusal (rate limited) retries with backoff instead of discarding the token', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const bridge = new FakeBridge()
    let refusals = 1
    bridge.overrides.auth = (frame) => {
      if (refusals > 0) {
        refusals -= 1
        return { error: 'rate limited' }
      }
      delete bridge.overrides.auth
      return bridge.reply(frame)
    }
    const { client } = open(bridge, { reconnectBaseMs: 1_000 })
    await settle()
    expect(client.getState()).toBe('reconnecting')
    expect(bridge.last.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(bridge.sockets).toHaveLength(2)
    expect(client.getState()).toBe('connected')
    client.close()
  })

  it('a credential refusal on auth.challenge is still final', async () => {
    const bridge = new FakeBridge()
    bridge.overrides['auth.challenge'] = () => ({ error: 'invalid token or device' })
    const { client } = open(bridge, { reconnectBaseMs: 1 })
    await settle()
    expect(client.getState()).toBe('auth-failed')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(bridge.sockets).toHaveLength(1)
  })

  it('a request during backoff waits for the timer instead of dialing right away', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const bridge = new FakeBridge()
    const client = new NexusBridgeClient({
      url: 'wss://mac.tail.ts.net',
      token: 'tok',
      identity: async () => identity,
      createSocket: bridge.factory,
      random: () => 0.5,
      reconnectBaseMs: 1_000
    })
    client.start()
    await settle()
    expect(client.getState()).toBe('connected')
    bridge.last.handlers.onClose(1006, '')
    expect(client.getState()).toBe('reconnecting')

    const pending = client.request('status', {}, { timeoutMs: 5_000 })
    await settle()
    expect(bridge.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(999)
    await settle()
    expect(bridge.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(bridge.sockets).toHaveLength(2)
    await expect(pending).resolves.toMatchObject({ running: true })
    client.close()
  })

  it('a second reconnect schedule replaces the first timer (one dial per backoff)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const bridge = new FakeBridge()
    const client = new NexusBridgeClient({
      url: 'wss://mac.tail.ts.net',
      token: 'tok',
      identity: async () => identity,
      createSocket: bridge.factory,
      random: () => 0.5,
      reconnectBaseMs: 1_000
    })
    client.start()
    await settle()
    bridge.last.handlers.onClose(1006, '')
    // Segundo agendamento (attempt 2 → 2 s) enquanto o de 1 s ainda está armado.
    const internals = client as unknown as { scheduleReconnect: () => void }
    internals.scheduleReconnect()
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(bridge.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(bridge.sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(bridge.sockets).toHaveLength(2)
    client.close()
  })

  it('a foreground nudge skips the remaining backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const bridge = new FakeBridge()
    const { client } = open(bridge, { reconnectBaseMs: 30_000 })
    await settle()
    bridge.last.handlers.onClose(1006, '')
    client.notifyForeground('app-resume')
    await settle()
    expect(bridge.sockets).toHaveLength(2)
    expect(client.getState()).toBe('connected')
    client.close()
  })
})
