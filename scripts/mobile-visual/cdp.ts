// F-1035 — Chrome headless pelo DevTools Protocol, como scripts/spikes/cdp-shot.mjs:
// `ws` cru, sem Playwright/Puppeteer. Perfil temporário (--user-data-dir), chaveiro
// simulado (--use-mock-keychain): nunca toca o Chrome/Keychain do operador.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter((candidate): candidate is string => Boolean(candidate))

export type CdpPage = {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>
  on(method: string, listener: (params: Record<string, unknown>) => void): void
  evaluate<T>(expression: string): Promise<T>
  close(): void
}

export type Browser = { page: CdpPage; close(): void }

export async function launchChrome(): Promise<Browser> {
  const chrome = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate))
  if (!chrome) throw new Error('Chrome não encontrado (defina CHROME_PATH)')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mobile-visual-chrome-'))
  const child: ChildProcess = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      // Só o harness: certificado autoassinado do proxy local em 127.0.0.1.
      '--ignore-certificate-errors',
      '--use-mock-keychain',
      '--password-store=basic',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--hide-scrollbars',
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  const browserWs = await new Promise<string>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('Chrome não abriu o DevTools em 20s')), 20_000)
    child.stderr?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve(match[1]!)
      }
    })
    child.once('exit', (code) => reject(new Error(`Chrome saiu (${code}) antes do DevTools`)))
  })
  const port = new URL(browserWs).port
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
    type: string
    webSocketDebuggerUrl: string
  }>
  const target = targets.find((entry) => entry.type === 'page')
  if (!target) throw new Error('nenhuma aba no Chrome headless')
  const page = await connectPage(target.webSocketDebuggerUrl)
  return {
    page,
    close() {
      page.close()
      child.kill('SIGTERM')
      setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500)
    }
  }
}

async function connectPage(url: string): Promise<CdpPage> {
  const socket = new WebSocket(url, { maxPayload: 512 * 1024 * 1024 })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  let seq = 0
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>()
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as {
      id?: number
      result?: unknown
      error?: { message: string }
      method?: string
      params?: Record<string, unknown>
    }
    if (message.id !== undefined) {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) waiter?.reject(new Error(message.error.message))
      else waiter?.resolve(message.result)
      return
    }
    for (const listener of listeners.get(message.method ?? '') ?? []) listener(message.params ?? {})
  })
  const send = <T>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  return {
    send,
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener])
    },
    async evaluate<T>(expression: string) {
      const result = await send<{
        result: { value?: T }
        exceptionDetails?: { text: string; exception?: { description?: string } }
      }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      }
      return result.result.value as T
    },
    close() {
      socket.close()
    }
  }
}
