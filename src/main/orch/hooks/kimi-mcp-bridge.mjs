#!/usr/bin/env node
/**
 * kimi-mcp-bridge.mjs — ponte stdio ⇄ HTTP do MCP do Overclock para o kimi-code.
 *
 * PROBLEMA QUE RESOLVE (raiz, não sintoma):
 * O kimi-code 0.29+ removeu a flag `--mcp-config` do legado; a config de MCP só vem de ARQUIVO,
 * e o arquivo user-global mora em `<KIMI_CODE_HOME>/mcp.json`. Como a URL do MCP carrega o
 * `callerPaneId` DAQUELE pane, o F-320 isolou o mcp.json dando a cada pane um KIMI_CODE_HOME
 * próprio. Só que KIMI_CODE_HOME é tudo-ou-nada: ele governa `getDataDir()` inteiro — mcp.json,
 * credenciais, sessões, cache. Dano colateral medido (2026-07-25): `kimi login` dentro de um pane
 * grava a credencial no home DAQUELE pane (o symlink para a conta é destruído no rename), então
 * o login não valia no terminal, não valia em outro workspace, e cada pane novo pedia login de
 * novo. E o KIMI_CODE_HOME ficava "gasto" isolando pane, indisponível para o papel que deveria
 * ter: isolar CONTA (como CODEX_HOME/GROK_HOME fazem).
 *
 * A SAÍDA: o schema de MCP do kimi aceita transporte `stdio` com `command`/`args`/`env`/`cwd`
 * (McpServerStdioConfigSchema, confirmado no binário 0.29.1). Servidor stdio é processo FILHO do
 * kimi daquele pane, logo HERDA o env do pane. Então:
 *   - `<KIMI_CODE_HOME>/mcp.json` volta a ser UM arquivo compartilhado (aponta para este bridge);
 *   - a identidade do pane chega por env (`NEXUS_PANE_ID`), não pelo arquivo;
 *   - KIMI_CODE_HOME fica livre para virar a alavanca de conta.
 * Resultado: 1 login vale em qualquer workspace, N panes kimi por workspace sem colisão, e
 * multi-conta pelo mesmo mecanismo de codex/grok.
 *
 * CONTRATO: fala JSON-RPC do MCP por stdin/stdout (framing por linha, um objeto por linha) e
 * repassa para o host HTTP streamable do sidecar, mantendo o `mcp-session-id`. Sem dependências.
 *
 * ENV consumido (injetado no spawn do pane):
 *   NEXUS_PANE_ID       (obrigatório na prática — sem ele o host não sabe quem chamou)
 *   NEXUS_MCP_PORT      (default 53700 — a porta real vem do sidecar; dev crava 63700)
 *   NEXUS_MCP_BASE_URL  (override completo; vence porta)
 *   OVERCLOCK_PANE_MODEL / _PROVIDER_ID / _WORKSPACE / _MISSION_ID / _CWD (defaults do pane)
 */

const PORT = process.env.NEXUS_MCP_PORT || '53700'
const BASE = process.env.NEXUS_MCP_BASE_URL || `http://127.0.0.1:${PORT}`

/** Monta a URL do endpoint kimi com os defaults deste pane na query (mesmo contrato do buildMcpStreamUrl). */
function endpointUrl() {
  const url = new URL(`${BASE.replace(/\/$/, '')}/mcp/kimi`)
  const q = url.searchParams
  const put = (k, v) => { if (typeof v === 'string' && v.length > 0) q.set(k, v) }
  put('callerPaneId', process.env.NEXUS_PANE_ID)
  put('model', process.env.OVERCLOCK_PANE_MODEL)
  put('providerId', process.env.OVERCLOCK_PANE_PROVIDER_ID)
  put('workspacePath', process.env.OVERCLOCK_PANE_WORKSPACE)
  put('missionId', process.env.OVERCLOCK_PANE_MISSION_ID)
  put('cwd', process.env.OVERCLOCK_PANE_CWD)
  return url.toString()
}

const URL_MCP = endpointUrl()
let sessionId = null

/** stderr é o único canal de log seguro: stdout é o transporte JSON-RPC. */
const logErr = (msg) => { try { process.stderr.write(`[kimi-mcp-bridge] ${msg}\n`) } catch { /* noop */ } }

/** Extrai objetos JSON de uma resposta que pode vir JSON puro OU SSE (`data: {...}`). */
function parseBody(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try { return [JSON.parse(trimmed)] } catch { return [] }
  }
  const out = []
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try { out.push(JSON.parse(payload)) } catch { /* frame parcial — ignora */ }
  }
  return out
}

function write(obj) {
  try { process.stdout.write(`${JSON.stringify(obj)}\n`) } catch { /* stdout fechado */ }
}

/** Ids das REQUISIÇÕES contidas em `msg` (objeto único ou batch JSON-RPC). Notificação não entra. */
function requestIds(msg) {
  const list = Array.isArray(msg) ? msg : [msg]
  const ids = []
  for (const m of list) {
    if (!m || typeof m !== 'object') continue
    if (typeof m.method !== 'string') continue
    if (m.id === undefined || m.id === null) continue
    ids.push(m.id)
  }
  return ids
}

const isResponse = (obj) => obj !== null && typeof obj === 'object'
  && (Object.hasOwn(obj, 'result') || Object.hasOwn(obj, 'error'))
  && obj.id !== undefined && obj.id !== null

async function forward(msg) {
  // CASAMENTO POR ID (F-32x): a resposta que sai no stdout é a resposta DESTA requisição.
  // O contrato do streamable HTTP é 1 POST → 1 stream com as respostas DAQUELE POST, mas o
  // bridge não pode CONFIAR nisso: um id que não foi pedido aqui não pode ser escrito (cruzaria
  // com outra chamada em voo), e o mesmo id não pode ser escrito duas vezes (o cliente casaria a
  // resposta errada). Requisição sem resposta vira erro JSON-RPC explícito — nunca hang calado.
  const pending = new Set(requestIds(msg))
  const answered = new Set()
  const fail = (message) => {
    for (const id of pending) {
      if (answered.has(id)) continue
      answered.add(id)
      write({ jsonrpc: '2.0', id, error: { code: -32603, message } })
    }
  }
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (sessionId) headers['mcp-session-id'] = sessionId
  let res
  try {
    res = await fetch(URL_MCP, { method: 'POST', headers, body: JSON.stringify(msg) })
  } catch (err) {
    // Host fora do ar: responde erro JSON-RPC em vez de morrer calado (o CLI mostraria
    // "MCP server failed" sem motivo). Notificação (sem id) não pode ser respondida.
    fail(`Overclock MCP unreachable: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const sid = res.headers.get('mcp-session-id')
  if (sid && !sessionId) sessionId = sid
  const text = await res.text()
  if (!res.ok) {
    fail(`Overclock MCP HTTP ${res.status}`)
    return
  }
  for (const obj of parseBody(text)) {
    if (isResponse(obj)) {
      if (!pending.has(obj.id)) { logErr(`resposta com id inesperado descartada (id=${String(obj.id)})`); continue }
      if (answered.has(obj.id)) { logErr(`resposta duplicada descartada (id=${String(obj.id)})`); continue }
      answered.add(obj.id)
      write(obj)
      continue
    }
    // Notificação / requisição vinda do servidor (progress, sampling…): passa direto.
    write(obj)
  }
  fail('Overclock MCP: no response for this request')
}

// ORDEM SÓ NO HANDSHAKE; DEPOIS, CONCORRÊNCIA.
// A fila era serial para TODA mensagem — e isso é head-of-line blocking: um `pane_spawn` real
// leva segundos, então 3 spawns em paralelo viravam 3 POSTs em fila (medido: +400ms cada no host
// fake, vários segundos no host real) e qualquer read atrás deles esperava a fila inteira — o
// cliente estoura o timeout dos últimos e o usuário vê "abriu 1, os outros não". O MCP só exige
// ordem no handshake (`initialize` → `notifications/initialized`, e nada pode sair antes do
// mcp-session-id existir). Então: handshake serial num gate, e todo o resto sai concorrente
// DEPOIS do gate. O casamento por id acima é o que torna a concorrência segura.
let gate = Promise.resolve()
const inFlight = new Set()
const track = (p) => {
  inFlight.add(p)
  return p.finally(() => inFlight.delete(p))
}
const isHandshake = (msg) => !Array.isArray(msg) && msg !== null && typeof msg === 'object'
  && (msg.method === 'initialize' || msg.method === 'notifications/initialized')
const enqueue = (msg) => {
  if (isHandshake(msg)) {
    gate = track(gate.then(() => forward(msg)).catch((err) => logErr(String(err))))
    return
  }
  // Espera o handshake (senão o POST sai sem mcp-session-id e o host devolve 400), mas NÃO
  // encadeia o gate: chamadas pós-handshake correm em paralelo entre si.
  void track(gate.then(() => forward(msg)).catch((err) => logErr(String(err))))
}

// Framing por linha. `stdin` pode entregar linha partida entre chunks — buffer até o \n.
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { logErr(`linha não-JSON ignorada (${line.length} chars)`); continue }
    enqueue(msg)
  }
})
// stdin fechou: drena o que está em voo (inclusive o que uma resposta possa ter enfileirado)
// antes de sair, para não cortar uma resposta no meio.
process.stdin.on('end', () => {
  const drain = () => {
    if (inFlight.size === 0) { process.exit(0); return }
    Promise.allSettled([...inFlight]).then(drain)
  }
  drain()
})

if (!process.env.NEXUS_PANE_ID) {
  logErr('NEXUS_PANE_ID ausente — o host não vai resolver o pane chamador (handoff/scope degradam)')
}
