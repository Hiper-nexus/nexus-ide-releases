// F-1035 — percorre o app mobile (export web) contra a Remote Bridge real e tira
// um screenshot por estado, em viewport de celular (390x844, DPR 3).
//
// NÃO é teste de aparelho: é o alvo web do mesmo código (React Native Web), no
// Chrome headless. Prova layout e o protocolo de ponta a ponta; WebSocket nativo,
// Keychain, câmera, notificações e Tailscale ficam de fora (docs/MOBILE-VISUAL.md).
import fs from 'node:fs'
import path from 'node:path'
import { startBridgeFixture, type BridgeFixture } from './bridge-fixture'
import { launchChrome, type CdpPage } from './cdp'

const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }

type Step = { name: string; file?: string; ok: boolean; detail?: string; layout?: LayoutAudit }
type LayoutAudit = { horizontalOverflow: boolean; offscreen: string[] }

type Target = { label?: string; text?: string | RegExp; role?: string; selector?: string }

function targetJs(target: Target): string {
  const text =
    target.text instanceof RegExp
      ? `{ re: ${JSON.stringify(target.text.source)}, flags: ${JSON.stringify(target.text.flags)} }`
      : JSON.stringify(target.text ?? null)
  return `(() => {
    const label = ${JSON.stringify(target.label ?? null)};
    const text = ${text};
    const role = ${JSON.stringify(target.role ?? null)};
    const selector = ${JSON.stringify(target.selector ?? null)};
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const matchesText = (value) => {
      if (text === null) return true;
      const v = (value || '').trim();
      return typeof text === 'string' ? v === text : new RegExp(text.re, text.flags).test(v);
    };
    let pool = Array.from(document.querySelectorAll(selector ?? (label !== null ? '[aria-label]' : role !== null ? '[role]' : 'body *')));
    if (label !== null) pool = pool.filter((el) => el.getAttribute('aria-label') === label);
    if (role !== null) pool = pool.filter((el) => el.getAttribute('role') === role);
    pool = pool.filter((el) => visible(el) && (selector !== null || matchesText(el.innerText)));
    // O menor elemento que casa (o texto em si, não o container).
    pool.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
    const el = pool[0];
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`
}

class Driver {
  readonly steps: Step[] = []
  readonly consoleErrors: string[] = []

  constructor(
    private readonly page: CdpPage,
    private readonly outDir: string
  ) {
    page.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error' && params.type !== 'warning') return
      const args = (params.args as Array<{ value?: unknown; description?: string }>) ?? []
      this.consoleErrors.push(
        `${params.type}: ${args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' ')}`.slice(0, 400)
      )
    })
    page.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails as { exception?: { description?: string }; text?: string }
      this.consoleErrors.push(`exception: ${details.exception?.description ?? details.text}`.slice(0, 400))
    })
  }

  async goto(url: string): Promise<void> {
    await this.page.send('Page.navigate', { url })
    await this.waitFor('document.readyState === "complete" && !!document.querySelector("#root > *")', 'app montado', 30_000)
  }

  async waitFor(expression: string, what: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        if (await this.page.evaluate<boolean>(`Boolean(${expression})`)) return
      } catch {
        // navegação em curso
      }
      if (Date.now() > deadline) throw new Error(`timeout esperando: ${what}`)
      await sleep(150)
    }
  }

  async waitForText(text: string | RegExp, timeoutMs = 15_000): Promise<void> {
    const probe = typeof text === 'string'
      ? `document.body.innerText.includes(${JSON.stringify(text)})`
      : `new RegExp(${JSON.stringify(text.source)}, ${JSON.stringify(text.flags)}).test(document.body.innerText)`
    await this.waitFor(probe, `texto ${String(text)}`, timeoutMs)
  }

  path(): Promise<string> {
    return this.page.evaluate<string>('location.pathname + location.search')
  }

  bodyText(): Promise<string> {
    return this.page.evaluate<string>('document.body.innerText')
  }

  async click(target: Target, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let point: { x: number; y: number } | null = null
    while (!point) {
      point = await this.page.evaluate<{ x: number; y: number } | null>(targetJs(target))
      if (point) break
      if (Date.now() > deadline) throw new Error(`não achei para clicar: ${JSON.stringify({ ...target, text: String(target.text ?? '') })}`)
      await sleep(150)
    }
    await sleep(120) // depois do scrollIntoView
    point = (await this.page.evaluate<{ x: number; y: number } | null>(targetJs(target))) ?? point
    const base = { x: point.x, y: point.y, button: 'left', clickCount: 1, pointerType: 'mouse' }
    await this.page.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none' })
    await this.page.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
    await sleep(40)
    await this.page.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
    await sleep(250)
  }

  async type(text: string): Promise<void> {
    await this.page.send('Input.insertText', { text })
    await sleep(150)
  }

  /** Página mais larga que o viewport e elementos com texto que saem da tela. */
  async audit(): Promise<LayoutAudit> {
    return this.page.evaluate<LayoutAudit>(`(() => {
      const w = window.innerWidth;
      const offscreen = [];
      for (const el of document.querySelectorAll('#root *')) {
        if (el.children.length > 0 || !el.innerText || !el.innerText.trim()) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > w + 1 || r.left < -1) offscreen.push(el.innerText.trim().slice(0, 60) + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
        if (offscreen.length >= 12) break;
      }
      return { horizontalOverflow: document.documentElement.scrollWidth > w + 1, offscreen };
    })()`)
  }

  async shot(name: string, detail?: string): Promise<void> {
    await sleep(400) // animações de entrada (BottomDrawer, fade)
    const { data } = await this.page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
    const file = `${name}.png`
    fs.writeFileSync(path.join(this.outDir, file), Buffer.from(data, 'base64'))
    this.steps.push({ name, file, ok: true, detail, layout: await this.audit() })
    console.log(`  ✓ ${file}${detail ? ` — ${detail}` : ''}`)
  }

  check(name: string, ok: boolean, detail: string): void {
    this.steps.push({ name, ok, detail })
    console.log(`  ${ok ? '✓' : '✗'} ${name} — ${detail}`)
    if (!ok) throw new Error(`verificação falhou: ${name} — ${detail}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function flow(d: Driver, fixture: BridgeFixture): Promise<void> {
  const desk = fixture.desktop
  // 1) App aberto, sem host.
  await d.goto(fixture.appUrl)
  await sleep(1_500)
  await d.shot('01-inicio-sem-host', 'app recém-aberto, nenhum host salvo')

  // 2) Tela de pareamento (no web não há câmera: só "colar código").
  await d.goto(`${fixture.appUrl}pair-scan`)
  await d.waitForText(/colar/i, 20_000)
  await d.shot('02-parear', 'pair-scan no alvo web (sem câmera)')
  await d.click({ text: /^(Colar código|Colar código de pareamento)$/ })
  await d.waitFor('document.querySelector("input")', 'campo do código')
  const pairingUrl = fixture.pairingUrl()
  await d.click({ selector: 'input' })
  await d.type(pairingUrl)
  await d.shot('03-colar-link', `link colado: ${pairingUrl.replace(/code=.*/, 'code=…')}`)
  await d.click({ text: 'Parear desktop' })

  // 3) Pareado: o app salva o host e sai do pair-scan (onboarding ou host).
  await d.waitFor('!location.pathname.includes("pair-scan")', 'sair do pair-scan após parear', 30_000)
  await sleep(1_000)
  d.check('codigo-gasto', !fixture.pairingCodeOutstanding(), 'a bridge consumiu o código de uso único')
  await d.shot('04-apos-parear', `rota após parear: ${await d.path()}`)
  // Onboarding do primeiro pareamento: host Nexus não tem UI de chat (F-1037), então
  // só a pergunta de notificações aparece; pula.
  if ((await d.path()).includes('mobile-onboarding')) {
    const onboarding = await d.bodyText()
    d.check('onboarding-sem-chat-ui', !/UI de chat|Chat UI/.test(onboarding), 'host Nexus: sem "Usar UI de chat"')
    await d.click({ label: 'Pular notificações por enquanto' })
    await d.waitFor('!location.pathname.includes("mobile-onboarding")', 'fim do onboarding', 15_000)
  }
  await d.goto(fixture.appUrl)
  await d.waitForText('Nexus · 127', 20_000)
  await d.waitForText('Conectado · Desktop Nexus', 20_000)
  await d.shot('05-inicio-com-host', 'host Nexus salvo aparece na lista')
  const home = await d.bodyText()
  d.check(
    'inicio-host-nexus-em-pt-br',
    !/Worktree|Direct|LAN|Welcome|Orca/.test(home),
    'card do host Nexus sem worktree/caminho e Início sem "Orca" ou inglês'
  )
  d.check(
    'inicio-sem-atalhos-do-orca',
    !/Tarefas|Novo workspace|GitHub/.test(home),
    'só host Nexus: sem Tarefas nem Novo workspace'
  )

  // 4) Host: missões e panes pelo snapshot; aprovação chega pelo push ao vivo.
  await d.click({ text: /^Nexus · 127/ })
  await d.waitForText(/missões/i, 20_000)
  await d.waitForText('Codex · revisão do diff', 20_000)
  await d.shot('06-host-conectado', 'missões + panes, sem aprovação ainda')
  const approval = fixture.openApproval()
  await d.waitForText(/aprovação pendente/i, 20_000)
  await d.shot('07-host-aprovacao', 'push approvals.changed → card de aprovação')

  // 5) Pane: saída ao vivo e um comando completo até o PTY simulado.
  await d.click({ label: 'Abrir pane Claude · x8 · porta o transporte' })
  await d.waitForText('porte o cliente da bridge', 20_000)
  await d.shot('08-pane-saida', 'pane.read inicial pelo stream')
  await d.click({ label: 'Comando para o pane' })
  await d.type('git status')
  await d.shot('09-pane-digitando', 'comando digitado antes de enviar')
  await d.click({ label: 'Enviar comando' })
  await d.waitForText('On branch main', 20_000)
  d.check(
    'comando-chegou-ao-pty',
    desk.writes.some(([session, data]) => session === 'sess-app' && data === 'git status\n'),
    `writes no PTY simulado: ${JSON.stringify(desk.writes)}`
  )
  d.check('sem-confirmacao-no-desktop', desk.confirmations.length === 0, 'git status é rotina: nenhum diálogo')
  await d.shot('10-pane-apos-comando', 'saída empurrada pelo pane.stream.data')

  // 6) Aprovação respondida pelo app: decisão vai ao broker, nunca tecla no PTY.
  await d.click({ label: 'Voltar para a lista' })
  await d.waitForText(/aprovação pendente/i, 10_000)
  const writesBefore = desk.writes.length
  await d.click({ text: 'Permitir' })
  const decision = await withTimeout(approval.decision, 15_000, 'decisão no broker')
  d.check('broker-recebeu-accept', decision === 'accept', `decisão no broker: ${decision}`)
  d.check('aprovacao-sem-tecla-no-pty', desk.writes.length === writesBefore, 'nenhuma escrita extra no PTY')
  await d.waitFor('!/aprovação pendente/i.test(document.body.innerText)', 'card some após responder', 15_000)
  await d.shot('11-host-aprovacao-respondida', 'card sumiu após o accept')

  // 7) Alterações (git status + diff) e Arquivos (lista + leitura), só leitura.
  await d.click({ label: 'Abrir pane Claude · x8 · porta o transporte' })
  await d.click({ label: 'Abrir alterações do Git deste pane' })
  await d.waitForText('README.md', 20_000)
  await d.shot('12-alteracoes', 'git status do checkout do pane')
  await d.click({ label: 'Ver diff de README.md' })
  await d.waitForText('linha dois', 20_000)
  await d.shot('13-diff', 'diff de README.md')
  await d.click({ label: 'Ver diff de src/transport/bridge-client.ts' }).catch(async () => {
    await d.click({ label: 'Voltar para as alterações' })
    await d.click({ label: 'Ver diff de src/transport/bridge-client.ts' })
  })
  await d.waitForText('timeoutMs', 20_000)
  await d.shot('14-diff-codigo', 'diff de código com linhas longas')
  await d.click({ role: 'tab', text: 'Arquivos' })
  await d.waitForText('notes.txt', 20_000)
  await d.shot('15-arquivos', 'raiz do checkout (sem .git e sem .env)')
  d.check('segredo-fora-da-lista', !(await d.bodyText()).includes('.env'), '.env não aparece em Arquivos')
  await d.click({ label: 'Ler README.md' })
  await d.waitForText('linha dois, agora com', 20_000)
  await d.shot('16-arquivo', 'leitura de README.md')

  // 8) Revogação no desktop: o app vai para "Parear de novo", sem loop.
  fixture.revoke()
  await d.waitForText('Parear de novo', 20_000)
  await sleep(500)
  await d.shot('17-revogado', 'credencial revogada ao vivo pelo desktop')
  d.check(
    'revogado-sem-conteudo-antigo',
    !(await d.bodyText()).includes('linha dois'),
    'arquivo/diff do pane some no auth-failed (F-1037)'
  )
  await d.click({ text: 'Parear de novo' })
  await d.waitForText(/colar/i, 20_000)
  await d.shot('18-parear-de-novo', 'volta ao pareamento')
}

export async function runVisual(opts: { webRoot: string; outDir: string }): Promise<boolean> {
  fs.mkdirSync(opts.outDir, { recursive: true })
  for (const file of fs.readdirSync(opts.outDir)) {
    if (file.endsWith('.png') || file === 'report.json') fs.rmSync(path.join(opts.outDir, file))
  }
  const fixture = await startBridgeFixture({ webRoot: opts.webRoot })
  console.log(`bridge real em wss://127.0.0.1:${fixture.bridgePort} · app em ${fixture.appUrl}`)
  const browser = await launchChrome()
  const d = new Driver(browser.page, opts.outDir)
  let failure: string | null = null
  try {
    await browser.page.send('Page.enable')
    await browser.page.send('Runtime.enable')
    await browser.page.send('Emulation.setDeviceMetricsOverride', VIEWPORT)
    await flow(d, fixture)
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error)
    console.error(`✗ ${failure}`)
    await d.shot('99-falha', failure.split('\n')[0]).catch(() => undefined)
  } finally {
    fs.writeFileSync(
      path.join(opts.outDir, 'report.json'),
      `${JSON.stringify(
        {
          note: 'Alvo web (React Native Web) no Chrome headless contra a Remote Bridge real; não é teste em aparelho.',
          viewport: VIEWPORT,
          ok: failure === null,
          failure,
          steps: d.steps,
          desktop: {
            writes: fixture.desktop.writes,
            resizes: fixture.desktop.resizes,
            confirmations: fixture.desktop.confirmations
          },
          consoleErrors: d.consoleErrors
        },
        null,
        2
      )}\n`
    )
    browser.close()
    fixture.stop()
  }
  return failure === null
}
