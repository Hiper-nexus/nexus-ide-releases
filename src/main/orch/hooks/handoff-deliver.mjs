#!/bin/sh
':' //# ; exec process.execPath "$0" "$@"
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
const gateDir = "~/.nexus/hooks"
const paneId = process.env.NEXUS_PANE_ID || ''
const CALLER = process.env.NEXUS_CALLER_PANE_ID || ''
// Pane sem identidade ou sem chamador não reporta a ninguém (pane livre do humano, ou CLI
// rodando fora do Overclock com o hook herdado do arquivo compartilhado).
if (!paneId || !CALLER || CALLER === paneId) process.exit(0)
const FALLBACK = "worker terminou a ação sem chamar handoff_submit — fechamento mecânico pelo Stop hook, sem relato do modelo."
// Fim de SESSÃO (não fim de turno) — grok manda um Stop extra observe-only aqui.
const SESSION_END_REASONS = ['channel_closed', 'shutdown']
// F-341: prefixo do envelope de canal. Serve pra DOIS papéis: montar a entrega e reconhecer,
// na entrada, que este turno começou com uma entrega de outro pane (F-342, anti-eco).
// O rótulo que a TUI desenha é o valor de source= (medido no bundle 2.1.220: wrapChannelMessage
// monta '<channel source="<e>"' e é esse valor que aparece antes do ':'). Então source = o PANE,
// e a marca do Overclock migra pra via= — assim o chefe lê 'pane_504: resposta' em vez do
// genérico 'overclock: resposta' (pedido do Laschuk ao vivo 2026-07-26). Nomes de atributo têm
// que casar ^[a-zA-Z_][a-zA-Z0-9_]*$ (regex dSd do bundle) — 'via' casa.
// A detecção de eco aceita as DUAS formas: via= (nova) e source="overclock" (entregas legadas
// ainda no transcript de panes vivos).
const WAKE_RE = /^\s*<channel\s+[^>]*(?:via="overclock"|source="overclock")/
const pendingMarker = join(gateDir, 'handoff-pending-' + paneId)
const roundIsFromHuman = () => {
  try {
    return readFileSync(join(gateDir, 'input-origin-' + paneId), 'utf8').trim() === 'human'
  } catch (e) { return false }
}
/** Texto de uma mensagem: string crua, ou array de partes com {type:'text'}. */
const partsToText = (content) => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join(' ')
  }
  return ''
}
/** Texto da resposta: o payload de codex/gemini/grok/opencode já traz o campo pronto. */
const payloadText = (input) => {
  const raw = input.last_assistant_message
    ?? input.lastAssistantMessage
    ?? input.prompt_response
    ?? input.promptResponse
    ?? ''
  return typeof raw === 'string' ? raw : ''
}
/**
 * Varre um transcript jsonl de trás pra frente e devolve
 *   { assistant: última fala do assistente, user: entrada que ABRIU este turno }.
 * Tolerante de propósito: cada CLI escreve um shape diferente (claude usa
 * {type,message:{role,content}}; codex/grok têm os seus). Reconhece papel por
 * ev.type / ev.role / ev.message.role e texto por content|text|message.content.
 *
 * ANTIGRAVITY (agy 1.1.7) é o único que NÃO cabe no reconhecimento genérico, por isso ganha um
 * ramo próprio na frente do laço. Shape medido no transcript real
 * (~/.gemini/antigravity-cli/brain/<conv>/.system_generated/logs/transcript.jsonl, 2026-07-26):
 * step_index + created_at + status + source ('MODEL' | 'USER_EXPLICIT' | 'SYSTEM') + type
 * ('PLANNER_RESPONSE' | 'USER_INPUT' | 'CONVERSATION_HISTORY' | 'CHECKPOINT') + content.
 * O papel vem de 'source' (campo que nenhum outro CLI escreve; o ramo ainda exige SCREAMING_SNAKE
 * pra não capturar shape alheio) — sem isso, 'PLANNER_RESPONSE' não casa /assistant|agent/ e
 * 'USER_INPUT' casa /user/ ANTES, fechando o turno com a resposta vazia (ida direta pro fallback).
 */
const scanTranscript = (input) => {
  const p = input.transcript_path || input.transcriptPath || ''
  const out = { assistant: '', user: '' }
  if (!p) return out
  let lines = []
  try { lines = readFileSync(p, 'utf8').split('\n') } catch (e) { return out }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = String(lines[i] || '').trim()
    if (!line) continue
    let ev
    try { ev = JSON.parse(line) } catch (e) { continue }
    if (!ev) continue
    // Ramo ANTIGRAVITY (ver docstring): papel por 'source', nunca por 'type'.
    const agSource = typeof ev.source === 'string' && /^[A-Z][A-Z_]*$/.test(ev.source) ? ev.source : ''
    if (agSource) {
      const agType = String(ev.type || '')
      const agText = typeof ev.content === 'string' ? ev.content : ''
      if (agSource === 'MODEL') {
        // Só PLANNER_RESPONSE é fala pro usuário — os outros passos MODEL são tool call/plano.
        if (!out.assistant && agType === 'PLANNER_RESPONSE' && agText) out.assistant = agText
        continue
      }
      if (agSource.indexOf('USER') === 0) {
        if (agType !== 'USER_INPUT') continue
        // O agy embrulha o pedido em <USER_REQUEST>…</USER_REQUEST>. O anti-eco compara o INÍCIO
        // do texto com o envelope de canal, então o embrulho tem que sair — senão todo turno
        // parece iniciado por humano e o eco nunca é detectado.
        out.user = agText.replace(/^\s*<USER_REQUEST>\s*/, '').replace(/<\/USER_REQUEST>\s*$/, '')
        break // fronteira do turno
      }
      continue // SYSTEM (CONVERSATION_HISTORY/CHECKPOINT) não é fala de ninguém
    }
    const msg = ev.message && typeof ev.message === 'object' ? ev.message : null
    const role = String((msg && msg.role) || ev.role || ev.type || '')
    const content = msg ? msg.content : (ev.content !== undefined ? ev.content : ev.text)
    // Resultado de tool volta como entrada de usuário — NÃO é a fala de quem abriu o turno.
    const isToolResult = Array.isArray(content) && content.length > 0
      && content.every((c) => c && c.type === 'tool_result')
    if (/assistant|agent/i.test(role)) {
      if (!out.assistant) out.assistant = partsToText(content)
      continue
    }
    if (/user|human/i.test(role)) {
      if (isToolResult || ev.isMeta) continue
      out.user = partsToText(content)
      break // fronteira do turno: daqui pra trás é história
    }
  }
  return out
}
/**
 * F-342 — anti-eco em cadeia: o que INICIOU este turno foi a entrega de OUTRO pane?
 * Cobertura por CLI (medido 2026-07-26):
 *   · gemini  — payload do AfterAgent traz 'prompt' (o pedido do turno): sinal DIRETO;
 *   · opencode— o plugin extrai a última fala do usuário pelo SDK e injeta em 'prompt';
 *   · codex/grok — o payload NÃO traz a entrada, só 'transcript_path'/'transcriptPath':
 *     usa a varredura tolerante acima. LIMITAÇÃO CONHECIDA: se o transcript não existir
 *     (ainda não flushado) ou vier num shape que a varredura não reconhece, o sinal é
 *     ausente ⇒ trata como tarefa e ENTREGA. Fail-open deliberado, mesma escolha do
 *     F-339: eco a mais é ruído; resultado perdido é o bug que este mecanismo conserta.
 */
const startedByWake = (input, scanned) => {
  const direct = input.prompt ?? input.user_prompt ?? input.userPrompt ?? ''
  const text = (typeof direct === 'string' && direct) ? direct : scanned.user
  return WAKE_RE.test(String(text || ''))
}
/**
 * 1.2.3 vitória 2 — ORDEM DE DECISÃO da entrega (substitui o corte mecânico do C-171, MESMA
 * regra do handoff-stop.mjs do claude — se um lado mudar, o outro muda junto):
 *   1) a resposta JÁ cabe em LIMIT chars → viaja INTEIRA — a informação REAL, sem preferir
 *      nenhum resumo sobre o conteúdo de verdade quando ele já é pequeno;
 *   2) não cabe → viaja a VERDADE ('concluiu — resposta longa, N chars'), NUNCA um corte
 *      mecânico fingindo resumo — o '[…TRUNCADO…]' de antes entregava os primeiros LIMIT chars
 *      como se fossem a resposta completa (medido em campo 2026-07-26: o chefe gastava um turno
 *      pedindo o resto de qualquer forma).
 * No caso (2) o texto ÍNTEGRO continua indo pro arquivo por pane (nome determinístico,
 * sobrescrito — não acumula) — só para de VIAJAR NA MENSAGEM; o chefe faz UM Read quando
 * precisar.
 */
const LIMIT = 280
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim()
/** djb2 — só pra comparar corpo igual/diferente na dedup por turno; não é hash de segurança. */
const hash = (s) => {
  let h = 5381
  const t = String(s || '')
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0
  return h.toString(36)
}
/**
 * Corpo da entrega — ver a ordem de decisão no comentário acima de LIMIT. O texto ÍNTEGRO vai
 * pra um arquivo por pane (nome determinístico, sobrescrito — não acumula lixo em panesDir)
 * sempre que o corpo entregue NÃO é a resposta inteira, então o chefe faz UM Read em vez de um
 * turno de ida e volta.
 */
const writeFullFile = (full) => {
  const fullFile = join(gateDir, 'handoff-full-' + paneId + '.txt')
  try { writeFileSync(fullFile, String(full)); return fullFile } catch (e) { return '' }
}
const buildBody = (full) => {
  const flat = oneLine(full)
  if (flat.length <= LIMIT) return { body: flat, fullFile: '' }
  const fullFile = writeFullFile(full)
  // A VERDADE, curta de propósito (nada de path embutido — manteria a mensagem grande e
  // vazaria caminho local pro histórico do delegador): tamanho + PONTEIRO pra onde buscar o
  // íntegro, nunca o conteúdo cortado se fazendo passar por resumo.
  const notice = fullFile
    ? 'concluiu — resposta longa, ' + flat.length + ' chars. Íntegra no registro: handoff_list({panes:["' + paneId + '"], full:true}) — busque SÓ se o humano pedir o detalhe.'
    : 'concluiu — resposta longa, ' + flat.length + ' chars. Íntegra no registro: handoff_list({panes:["' + paneId + '"], full:true}) — busque só se o humano pedir.'
  return { body: notice, fullFile }
}
/**
 * Endpoint do MCP local. Ordem: OVERCLOCK_MCP_URL (gemini — env por-hook, a ÚNICA via com a env
 * sanitizada) → NEXUS_MCP_BASE_URL → mcp-pane-<id>.json → NEXUS_MCP_PORT → arquivo de
 * porta por instância (F-010).
 */
const resolveEndpoint = () => {
  const direct = process.env.OVERCLOCK_MCP_URL || ''
  if (direct) return direct
  let base = process.env.NEXUS_MCP_BASE_URL || ''
  let query = ''
  try {
    const cfg = JSON.parse(readFileSync(join(gateDir, 'mcp-pane-' + paneId + '.json'), 'utf8'))
    const raw = cfg && cfg.mcpServers && cfg.mcpServers.overclock && cfg.mcpServers.overclock.url
    if (typeof raw === 'string' && raw) {
      const u = new URL(raw)
      if (!base) base = u.origin
      query = u.search
    }
  } catch (e) {}
  if (!base && process.env.NEXUS_MCP_PORT) base = 'http://127.0.0.1:' + process.env.NEXUS_MCP_PORT
  if (!base) {
    try {
      const port = parseInt(String(readFileSync("/Users/cleofasrocha/.overclock-ssh/mcp-port", 'utf8')).trim(), 10)
      if (port > 0) base = 'http://127.0.0.1:' + port
    } catch (e) {}
  }
  if (!base) return ''
  if (!query) query = '?callerPaneId=' + encodeURIComponent(paneId)
  return base.replace(/\/$/, '') + '/mcp' + query
}
/** Resposta pode vir JSON puro OU SSE ('data: {...}') — mesmo contrato do handoff-stop. */
const parseBody = (text) => {
  const t = String(text).trim()
  if (t.startsWith('{')) { try { return [JSON.parse(t)] } catch (e) { return [] } }
  const out = []
  for (const line of t.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try { out.push(JSON.parse(payload)) } catch (e) {}
  }
  return out
}
const rpc = async (url, sid, body, timeoutMs) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (sid) headers['mcp-session-id'] = sid
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs || 8000) })
  const text = await res.text()
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return { sid: res.headers.get('mcp-session-id') || sid, msgs: parseBody(text) }
}
// h-hk: tool result carrega um JSON de payload — ok:false = entrega NÃO confirmada pelo pane_write.
const askDelivered = (res) => {
  try {
    for (const m of (res && res.msgs) || []) {
      const t = m && m.result && m.result.content && m.result.content[0] && m.result.content[0].text
      if (typeof t !== 'string') continue
      const j = t.indexOf('{')
      if (j >= 0 && JSON.parse(t.slice(j)).ok === false) return false
    }
  } catch (e) {}
  return true
}
const main = async (input) => {
  if (input.stop_hook_active === true || input.stopHookActive === true) return
  const reason = String(input.reason || '')
  if (SESSION_END_REASONS.indexOf(reason) !== -1) return
  try { if (existsSync(pendingMarker)) return } catch (e) {}
  if (roundIsFromHuman()) return
  const scanned = scanTranscript(input)
  // C-194.3 (v2): o anti-eco agora suprime o SUBMIT — com a entrega ligada ao submit no sidecar,
  // registrar É entregar; registrar o turno de eco reencenava a cadeia (F-342).
  if (startedByWake(input, scanned)) return
  const full = payloadText(input) || scanned.assistant || ''
  const flat = oneLine(full)
  const flatOriginal = flat
  // Dedup por IDENTIDADE DO TURNO (nunca heurística de tempo): dois disparos do MESMO turno agem
  // UMA vez ('session.idle' do opencode pisca 2x, grok manda Stop extra, codex tem Stop+SubagentStop).
  const turnKey = String(
    input.turn_id || input.turnId || input.session_id || input.sessionId
      || (input.conversationId ? input.conversationId + '#' + String(input.executionNum ?? '') : ''),
  )
  const deliveryKey = turnKey + '#' + hash(flat)
  const claimFile = join(gateDir, 'deliver-seen-' + paneId + '-' + hash(deliveryKey))
  try {
    writeFileSync(claimFile, deliveryKey, { flag: 'wx' })
  } catch (e) {
    return // outro disparo DESTE MESMO turno já está agindo
  }
  try {
    const prefix = 'deliver-seen-' + paneId + '-'
    for (const f of readdirSync(gateDir)) {
      if (f.indexOf(prefix) === 0 && join(gateDir, f) !== claimFile) {
        try { unlinkSync(join(gateDir, f)) } catch (e) {}
      }
    }
  } catch (e) {}
  const url = resolveEndpoint()
  if (!url) return
  let sid = ''
  try {
    const init = await rpc(url, '', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'overclock-handoff-deliver', version: '1' } } })
    sid = init.sid || ''
    if (!sid) return
    await rpc(url, sid, { jsonrpc: '2.0', method: 'notifications/initialized' })
  } catch (e) { return }
  // ── C-194.3: dedup pelo PROTOCOLO (CLI-agnóstico, sem ler transcript) ──────────────────
  // O modelo pode ter chamado handoff_submit sozinho (a doutrina ensina). Em vez de scraping do
  // formato de transcript de cada CLI, pergunta ao registro: a atividade deste pane ainda está
  // pending? pending → fechamento mecânico é nosso. Terminal → o modelo fechou; só ANEXA a
  // íntegra (fullText) quando a resposta era longa. Sem registro → fail-open (fecha, como sempre).
  let latestStatus = ''
  try {
    const listed = await rpc(url, sid, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'handoff_list', arguments: { panes: [paneId] } } })
    const answer = listed.msgs.find((m) => m && m.id === 4)
    const text = answer && answer.result && answer.result.content && answer.result.content[0] && answer.result.content[0].text || ''
    const j = String(text).indexOf('{')
    if (j >= 0) {
      const parsed = JSON.parse(String(text).slice(j))
      if (parsed && Array.isArray(parsed.handoffs) && parsed.handoffs[0]) latestStatus = String(parsed.handoffs[0].status || '')
    }
  } catch (e) { /* fail-open */ }
  const transcript = input.transcript_path || input.transcriptPath || ''
  if (latestStatus && latestStatus !== 'pending') {
    // Modelo já fechou. Escada de consulta: anexa a íntegra quando longa (sem novo submit, sem wake).
    if (flat.length > LIMIT) {
      try {
        await rpc(url, sid, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'handoff_submit', arguments: {
          attach: true, paneId, summary: '-', status: 'done', fullText: String(full).slice(0, 60000),
        } } })
      } catch (e) {}
    }
    try { unlinkSync(join(gateDir, 'handoff-condense-' + paneId + '.txt')) } catch (e) {}
    return
  }
  // ── C-194.3: CONDICIONAL POR TAMANHO + AUTO-PERGUNTA (mesma semântica do claude) ────────
  // Curta (≤LIMIT) → fecha verbatim, silêncio total. Longa, 1ª vez → guarda a íntegra e
  // PERGUNTA no próprio pane (conversa, nunca erro); a linha curta do turno seguinte fecha
  // verbatim levando a íntegra como fullText. Longa DE NOVO (marker presente) → aviso de
  // tamanho + fullText. A entrega é SEMPRE do sidecar (consequência do submit) — este hook
  // não escreve mais no pane do chamador (o envelope próprio saiu: entregava 2x).
  const condenseFile = join(gateDir, 'handoff-condense-' + paneId + '.txt')
  let condenseStored = ''
  let condensePending = false
  try { condensePending = existsSync(condenseFile) } catch (e) {}
  if (condensePending) {
    try { condenseStored = readFileSync(condenseFile, 'utf8') } catch (e) {}
    // C-194.3 (codex, medido): o CLI pode re-disparar o Stop do MESMO turno longo com
    // identidade diferente (o claim não segura). Payload IGUAL ao texto guardado = re-disparo,
    // não resposta da condensação — mantém o marker e segue esperando. Só payload DIFERENTE
    // conta como tentativa de condensar.
    if (oneLine(condenseStored) === flatOriginal) return
    try { unlinkSync(condenseFile) } catch (e) {}
  }
  if (!condensePending && flat.length > LIMIT) {
    try { writeFileSync(condenseFile, String(full)) } catch (e) {}
    try {
      // 60s, não 30s: pane_write pro opencode mediu 33,6s (h-el, 2026-07-27) — 30s abortava a
      // pergunta já entregue e fechava com aviso de tamanho, descartando a condensação.
      const askRes = await rpc(url, sid, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'pane_write', arguments: {
        paneId, text: 'Condense sua resposta anterior em 1 a 2 frases, na mesma língua da resposta — responda só o resumo, nada mais.',
      } } }, 60000)
      // h-hk (grok, 2026-07-28): pane_write pode COMPLETAR reportando ok:false (swallowed/parked
      // — a pergunta nunca apareceu no pane). Sem checar, o marker ficava e a ficha apodrecia
      // até o abandono. Falha de entrega = mesma rota do throw: aviso de tamanho, nunca silêncio.
      if (askDelivered(askRes)) return
      // h-hr (grok, mesma manhã): o veredito também dá FALSO negativo — o grok repinta a tela e
      // a observação não acha o texto entregue. A pergunta chegou, o worker condensou e FECHOU a
      // ficha enquanto o pane_write ainda re-colava; o fallback então fechava DE NOVO (aviso de
      // tamanho) e o chefe acordava 2x, com o aviso soterrando o resumo. Antes de fechar,
      // re-consulta o registro: ficha já não-pending = a condensação venceu — cala e sai.
      try {
        const chk = await rpc(url, sid, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'handoff_list', arguments: { panes: [paneId] } } })
        const ans = chk.msgs.find((m) => m && m.id === 8)
        const txt = ans && ans.result && ans.result.content && ans.result.content[0] && ans.result.content[0].text || ''
        const jj = String(txt).indexOf('{')
        if (jj >= 0) {
          const p = JSON.parse(String(txt).slice(jj))
          const st = p && Array.isArray(p.handoffs) && p.handoffs[0] ? String(p.handoffs[0].status || '') : ''
          if (st && st !== 'pending') { try { unlinkSync(condenseFile) } catch (e2) {} ; return }
        }
      } catch (e) { /* re-checagem é best-effort — segue pro aviso de tamanho */ }
    } catch (e) { /* pergunta falhou → cai no fechamento com aviso de tamanho */ }
    try { unlinkSync(condenseFile) } catch (e) {}
  }
  // C-194 (h-ep): a resposta da auto-pergunta é o resumo — verbatim, sem régua de 280 ("1 a 2
  // frases" é forma, não contagem). O guard acima já retornou quando o payload repetiu a íntegra
  // original, então condenseStored aqui = condensação real.
  // h-ih/h-ii: sufixo de referência no wake condensado (ver comentário no hook do claude).
  const built = condenseStored
    ? { body: flat + ' [resumo — íntegra de ' + oneLine(condenseStored).length + ' chars no registro]', fullFile: '' }
    : buildBody(full || FALLBACK)
  try {
    await rpc(url, sid, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'handoff_submit',
        arguments: {
          paneId,
          status: 'done',
          summary: '[auto] ' + built.body,
          artifacts: {
            auto: true,
            closedBy: 'deliver-hook',
            sessionId: input.session_id || input.sessionId || input.conversationId || '',
            transcript,
            ...(built.fullFile ? { fullTextFile: built.fullFile } : {}),
          },
          ...(transcript ? { evidence: { evidenceFile: transcript } } : {}),
          to: CALLER,
          // Íntegra no REGISTRO: pós-condensação é a resposta ORIGINAL guardada; senão, a longa atual.
          ...(condenseStored ? { fullText: condenseStored.slice(0, 60000) } : (built.fullFile ? { fullText: String(full).slice(0, 60000) } : {})),
        },
      },
    })
  } catch (e) {
    try { unlinkSync(claimFile) } catch (e2) {}
  }
}
// ENTREGA DESACOPLADA (F-352): o processo que o CLI espera não faz I/O de rede — grava o payload,
// relança a si mesmo desacoplado e sai em ms. Doutrina completa em renderDetachedBootstrap
// (spawnHelpers.ts), compartilhada com o handoff-stop.mjs do claude.
// Aqui NÃO existe guarda de pai: nestes CLIs o exit != 0 no Stop bloqueia/continua o turno, então
// o pai é sempre exit 0 e todas as guardas rodam no neto.
const CHILD = process.env.OVERCLOCK_DELIVER_CHILD === '1'
const runDetached = (raw) => {
  const payloadFile = join(gateDir, 'deliver-payload-' + paneId + '-' + process.pid + '.json')
  try { writeFileSync(payloadFile, raw) } catch (e) { return }
  try {
    const child = spawn(process.execPath, [process.argv[1], payloadFile], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, OVERCLOCK_DELIVER_CHILD: '1' },
    })
    child.unref()
  } catch (e) {
    try { unlinkSync(payloadFile) } catch (e2) {}
  }
}
if (CHILD) {
  // Neto: payload vem do arquivo (que é consumido na hora — nada acumula em panesDir).
  const payloadFile = process.argv[2] || ''
  let input = {}
  try { input = JSON.parse(readFileSync(payloadFile, 'utf8')) } catch (e) {}
  try { unlinkSync(payloadFile) } catch (e) {}
  main(input).catch(() => {}).then(() => process.exit(0))
} else {
  let raw = ''
  process.stdin.on('data', (d) => { raw += d })
  process.stdin.on('end', () => {
    runDetached(raw)
    // exit 0 AGORA: demorar aqui é o que punha o worker em retry no fim do turno.
    process.exit(0)
  })
}
