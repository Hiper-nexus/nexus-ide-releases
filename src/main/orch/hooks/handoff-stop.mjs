#!/bin/sh
':' //# ; exec process.execPath "$0" "$@"
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
const gateDir = "~/.nexus/hooks"
const paneId = process.env.NEXUS_PANE_ID
// Sem identidade de pane → nada a fazer; exit 0 pra que um shell mal configurado nunca entre em loop.
if (!paneId) process.exit(0)
const counter = join(gateDir, 'handoff-stopcount-' + paneId)
// handoff-pending-<id> é escrito PELO SIDECAR (chefe delegateOnly com workers em aberto): ele está
// legitimamente ocioso esperando os handoffs dos workers — não é fim de tarefa, não fecha nada.
const pendingMarker = join(gateDir, 'handoff-pending-' + paneId)
// C-194 (auto-pergunta, decisão Laschuk 2026-07-26): resposta LONGA sem submit não gera mais
// lembrete visível ("Stop hook error" reprovado). O neto guarda a ÍNTEGRA neste arquivo e faz
// uma pergunta NATURAL no próprio pane ("condense em uma linha"); a resposta curta do turno
// seguinte fecha verbatim pelo caminho mecânico, levando a íntegra daqui como fullText.
const condenseFile = join(gateDir, 'handoff-condense-' + paneId + '.txt')
const AUTO_MARK = '[auto]'
const CALLER = process.env.NEXUS_CALLER_PANE_ID || ''
/**
 * F-339 — a rodada que está encerrando veio do SISTEMA (tarefa delegada) ou do TECLADO do
 * humano? O pane do worker segue vivo depois da tarefa e o humano conversa com ele pela janela;
 * essas respostas o chefe nunca pediu. O sidecar publica a origem da última entrada em
 * `input-origin-<paneId>` (fronteira do humanDraftGate: IPC pty:write = humano; pane_write /
 * agent_invoke = sistema — inputOrigin.ts).
 *
 * FAIL-OPEN deliberado: arquivo ausente (ex.: prompt de nascimento via argv, C-189) ou valor
 * desconhecido ⇒ SISTEMA ⇒ entrega. Falso positivo = uma mensagem a mais pro chefe; falso
 * negativo = resultado perdido — o bug que este mecanismo conserta.
 */
const roundIsFromHuman = () => {
  try {
    return readFileSync(join(gateDir, 'input-origin-' + paneId), 'utf8').trim() === 'human'
  } catch (e) { return false }
}
/**
 * F-352 — ONDE FOI PARAR O exit 2. Antes, o pai fazia a rede e podia gritar na hora. Agora quem
 * fala com o MCP é o NETO, desacoplado: ele não tem stdin/stdout ligado ao CLI, logo não tem como
 * bloquear turno nenhum. Perder a falha visível é ruim; prender o turno é pior — então a falha
 * fica DIFERIDA por um turno: o neto grava o motivo em 'handoff-fail-<paneId>' e o PRÓXIMO Stop
 * (pai, custo = um existsSync, zero rede) grita o nag e sai 2, exatamente como antes.
 * Trade-off aceito e explícito: se o pane nunca mais parar, a falha só existe no registro. O caso
 * comum (worker segue vivo e para de novo) mantém a falha visível na tela.
 */
const failMarker = join(gateDir, 'handoff-fail-' + paneId)
const recordFailure = (why) => {
  try { writeFileSync(failMarker, String(why)) } catch (e) {}
}
// PAI: nag diferido. Cap de 2 seguidas (contador) pra nunca virar loop; e o Stop que o exit 2
// provoca volta com stop_hook_active=true, que o pai atende com exit 0 (ver o parentGuard).
const nagIfPreviousFailed = () => {
  let why = ''
  try { why = readFileSync(failMarker, 'utf8') } catch (e) { return }
  try { unlinkSync(failMarker) } catch (e) {}
  let n = 0
  try { n = parseInt(readFileSync(counter, 'utf8'), 10) || 0 } catch (e) {}
  if (n >= 2) return
  try { writeFileSync(counter, String(n + 1)) } catch (e) {}
  process.stderr.write('AUTO-HANDOFF FALHOU (' + why + '). O orquestrador está BLOQUEADO esperando e o fechamento mecânico não foi possível. Chame nexus_handoff_submit AGORA: status done/blocked/error + 1-3 frases de resumo.')
  process.exit(2)
}
/**
 * UMA leitura do transcript devolve tudo que os markers carregavam:
 *   text  — a última fala do assistente. F-355: isto virou FALLBACK do texto; a fonte primária
 *           da RESPOSTA é payloadText(input) (o payload do Stop já traz o texto pronto).
 *   tool  — a tool relevante mais recente DESTE turno ('handoff_submit' | 'clarify' | 'Workflow'),
 *           varrendo de trás pra frente até a última mensagem HUMANA (tool_result não é humano);
 *   fromWake — o turno começou por entrega de outro pane (anti-eco do F-342).
 * As GUARDAS (tool/fromWake) continuam vindo daqui: o payload não as carrega.
 */
const readTurn = (input) => {
  const p = input.transcript_path || input.transcriptPath || ''
  const out = { text: '', tool: '', fromWake: false }
  let lines = []
  try { if (p) lines = readFileSync(p, 'utf8').split('\n') } catch (e) {}
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = String(lines[i] || '').trim()
    if (!line) continue
    let ev
    try { ev = JSON.parse(line) } catch (e) { continue }
    if (!ev) continue
    const content = ev.message && ev.message.content
    if (ev.type === 'assistant') {
      if (typeof content === 'string') { if (!out.text) out.text = content }
      else if (Array.isArray(content)) {
        for (const c of content) {
          if (!c) continue
          if (!out.tool && c.type === 'tool_use' && typeof c.name === 'string') {
            if (/handoff_submit$/.test(c.name)) out.tool = 'handoff_submit'
            else if (/nexus_clarify$/.test(c.name)) out.tool = 'clarify'
            else if (c.name === 'Workflow') out.tool = 'Workflow'
          }
        }
        if (!out.text) {
          const t = content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join(' ')
          if (String(t).trim()) out.text = t
        }
      }
      continue
    }
    if (ev.type === 'user') {
      // Resultado de tool volta como entrada 'user' — NÃO é a fala do humano; segue varrendo.
      const isToolResult = Array.isArray(content) && content.length > 0 && content.every((c) => c && c.type === 'tool_result')
      if (isToolResult || ev.isMeta) continue
      // F-342: ECO EM CADEIA. O que INICIOU este turno foi a entrega de outro pane
      // (envelope de canal do Overclock)? Então esta resposta é reação a um wake, não
      // resultado de tarefa delegada — NÃO repassar pra cima. Sem esta guarda, cada pane
      // reenvia ao seu chamador o que acabou de receber: medido 2026-07-25 (h-9c do
      // worker às 22:34:28, h-9e do chefe às 22:34:33 com o MESMO conteúdo), e o chefe
      // ainda gastava um turno extra dizendo "já recebido".
      const startedByWake = (typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join(' ')
        : '')
      // C-171: o rótulo virou o PANE (source=pane_NNN) e a marca do Overclock foi pra via=;
      // aceita as duas formas pra não perder o anti-eco de entregas legadas no transcript.
      if (/^\s*<channel\s+[^>]*(?:via="overclock"|source="overclock")/.test(String(startedByWake))) out.fromWake = true
      break // fronteira do turno: daqui pra trás é história, não este encerramento
    }
  }
  // C-171: o texto sai INTEIRO daqui (uma linha, sem teto). Quem aplica o teto da ENTREGA é
  // buildBody abaixo — e quando trunca, AVISA e guarda o íntegro em arquivo. Truncar aqui,
  // mudo, em 300 chars fazia o chefe gastar um turno pedindo o resto (medido 2026-07-26).
  out.text = String(out.text).replace(/\s+/g, ' ').trim()
  return out
}
/**
 * F-355 — A FONTE DA RESPOSTA É O PAYLOAD, não o transcript.
 *
 * O payload do Stop do Claude Code (2.1.220) traz 'last_assistant_message' — o texto da última
 * resposta, montado EM MEMÓRIA antes de qualquer flush em disco. É exatamente o mesmo campo que
 * os hooks dos outros CLIs já consomem (payloadText do handoff-deliver.mjs, mais abaixo neste
 * arquivo); o claude era o único que ainda dependia do .jsonl, e essa assimetria era o bug.
 *
 * Por que o transcript NUNCA foi fonte confiável aqui: medido em 15/15 turnos, a entrada
 * type:'assistant' AINDA NÃO EXISTIA no .jsonl no instante do disparo do Stop (chegava até ~83ms
 * depois). Ler no disparo dá fallback genérico SEMPRE. O campo do payload é imune à corrida
 * porque não passa por disco.
 *
 * Campo OPCIONAL: turno que fecha sem texto (só tool_use) não o traz. Aí, e só aí, cai no
 * transcript — com a espera curta do 'main' (ver lá).
 */
const payloadText = (input) => {
  const raw = input.last_assistant_message ?? input.lastAssistantMessage
  return typeof raw === 'string' && raw.trim() ? raw : ''
}
/**
 * 1.2.3 vitória 2 — ORDEM DE DECISÃO da entrega (substitui o corte mecânico do C-171):
 *   1) a resposta JÁ cabe em LIMIT chars → viaja INTEIRA — a informação REAL, sem preferir
 *      nenhum resumo sobre o conteúdo de verdade quando ele já é pequeno;
 *   2) não cabe → viaja a VERDADE ('concluiu — resposta longa, N chars'), NUNCA um corte
 *      mecânico fingindo resumo — o '[…TRUNCADO…]' de antes entregava os primeiros LIMIT chars
 *      como se fossem a resposta completa, o que é pior que dizer claramente que cortou.
 * No caso (2) o texto ÍNTEGRO continua indo pro arquivo por pane (nome determinístico,
 * sobrescrito — não acumula) — só para de VIAJAR NA MENSAGEM; o chefe faz UM Read quando
 * precisar. MESMA regra do handoff-deliver.mjs (os outros CLIs).
 */
const LIMIT = 280
const writeFullFile = (full) => {
  const fullFile = join(gateDir, 'handoff-full-' + paneId + '.txt')
  try { writeFileSync(fullFile, String(full)); return fullFile } catch (e) { return '' }
}
const buildBody = (full) => {
  const flat = String(full || '').replace(/\s+/g, ' ').trim()
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
/** URL do MCP local + os defaults DESTE pane (callerPaneId etc. vêm do mcp-pane-<id>.json). */
const resolveEndpoint = () => {
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
/** Resposta pode vir JSON puro OU SSE (`data: {...}`) — mesmo contrato do kimi bridge. */
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
/**
 * NETO (desacoplado). Aqui pode gastar tempo: o CLI já fechou o turno.
 *
 * As guardas do PAI (stop_hook_active, handoff-pending) são re-checadas aqui como defesa em
 * profundidade — o custo é zero e o neto também é o caminho usado pelos testes de comportamento.
 */
const main = async (input) => {
  // Stop re-entrante (algum hook bloqueou o encerramento e o modelo continuou). C-194: se foi o
  // NOSSO lembrete de resposta longa (marker do pai), este é o retorno dele — consome o marker e
  // segue: condensou → dedup abaixo silencia; ignorou → o fallback corre (aviso de tamanho).
  // Qualquer OUTRO reentrante: já tratado na primeira passada.
  if (input.stop_hook_active === true || input.stopHookActive === true) {
    let nudged = false
    try { nudged = existsSync(nudgeMarker) } catch (e) {}
    if (!nudged) return
    try { unlinkSync(nudgeMarker) } catch (e) {}
  }
  // Chefe delegateOnly com workers em aberto: ocioso por contrato, não é fim de tarefa.
  try { if (existsSync(pendingMarker)) return } catch (e) {}
  // F-355 — DE ONDE VEM O TEXTO, E POR QUE EXISTE ESPERA AQUI (e só aqui).
  //
  // Fonte primária: payloadText(input). Nada a esperar — o campo veio junto com o evento.
  //
  // Caminho degradado (payload sem o campo): o transcript é a única fonte, e aí a corrida é REAL
  // — medida em 15/15 turnos, a linha type:'assistant' não existe no .jsonl no disparo do Stop
  // (chega até ~83ms depois). Ler uma vez e desistir = fallback genérico no lugar da resposta.
  // Por isso o poll curto abaixo.
  //
  // A DISTINÇÃO QUE O F-354 ERROU (não repita): 'não pode haver espera' vale pro PAI — o processo
  // que o CLI aguarda pra fechar o turno; dormir lá prende o worker e foi o que pôs o grok em
  // retry. Este 'main' roda no NETO desacoplado (renderDetachedBootstrap: detached+unref, stdio
  // ignorado, o pai já saiu). Aqui ninguém espera por nós — esperar é grátis pro usuário. O erro
  // do F-354 foi deduzir que desacoplar ADIAVA a leitura: não adia. O neto é lançado na hora, e
  // corre contra o mesmo flush.
  //
  // Critério de chegada: entrada type:'assistant' com TEXTO (ou com a tool do turno). Não vale
  // 'o arquivo tem linhas' — entradas system/user chegam antes e enganariam o poll.
  const waitForTranscriptTurn = async (first) => {
    let turn = first
    // Sem transcript_path não há o que esperar (nada vai aparecer) — vai direto pro fallback.
    if (!(input.transcript_path || input.transcriptPath)) return turn
    const deadline = Date.now() + 2000
    let delay = 10
    while (!turn.text && !turn.tool && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, delay))
      if (delay < 50) delay = Math.min(50, delay * 2)
      turn = readTurn(input)
    }
    return turn
  }
  const replyText = payloadText(input)
  // readTurn continua obrigatório mesmo com o payload em mãos: as guardas (clarify/Workflow,
  // anti-eco do F-342) só existem no transcript.
  let turn = readTurn(input)
  // Estourou o teto sem nada chegar → segue com o fallback textual. NUNCA fallback cego quando
  // havia texto disponível.
  if (!replyText) turn = await waitForTranscriptTurn(turn)
  // C-194.1: o dedup depende de VER o handoff_submit no transcript — e quando o worker fechou
  // sozinho, o tool_use aconteceu MILISSEGUNDOS antes do Stop (mesma corrida de flush do F-355,
  // agora nas tools; medido ao vivo 2026-07-26, pane-553: '[auto] Ok.' entregue em cima do
  // submit real). Aqui é o neto (ninguém espera): poll curto até a tool aparecer. Teto 1s —
  // a corrida medida é ≤~83ms (folga 12×), e com a CONDICIONAL o silêncio virou o caminho
  // COMUM da resposta curta: este teto é latência direta da entrega, não engordar à toa.
  if (!turn.tool) {
    const deadline = Date.now() + 1000
    let delay = 25
    while (!turn.tool && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, delay))
      if (delay < 100) delay = Math.min(100, delay * 2)
      turn = readTurn(input)
    }
  }
  // F-215: overclock_clarify = pausa legítima esperando resposta HUMANA. Não fecha, não entrega.
  // (O /goal do Claude Code é outro Stop hook, avaliado por LLM — o produto não sobrepõe; o agente
  // é ensinado HUMAN GATE BEATS /GOAL no prompt do orquestrador.)
  if (turn.tool === 'clarify') return
  // Workflow em voo: a tool devolve um id na hora e o pane espera a notificação do background —
  // NÃO está ocioso. Forçar o fechamento aqui já corrompeu saída (chefe escrevendo em concorrência
  // com o agente de síntese do Workflow).
  if (turn.tool === 'Workflow') return
  // ── C-194.1: este hook virou FALLBACK ─────────────────────────────────────────────────
  // Quem avisa o chefe é o WORKER, chamando handoff_submit no fim do próprio turno; a entrega
  // é consequência desse ato e acontece no sidecar (attachHandoffDelivery), num lugar só.
  // Este hook só age quando o worker NÃO avisou — e ele não entrega mais nada por conta própria
  // (o pane_write daqui saiu: com a entrega ligada no sidecar, a mesma resposta chegaria 2×).
  //
  // O worker já avisou neste turno? O transcript mostra a tool call → nada a submeter.
  // C-194 fase 2: sessionId/transcript NÃO são mais copiados aqui — viraram JOIN com a tabela
  // panes (handoff_list full:true › executor). O attach encolheu pra ÚNICA coisa que é do
  // vínculo mesmo: o fullText de resposta longa que o worker fechou sem passar.
  if (turn.tool === 'handoff_submit') {
    try {
      const rawFull = String(replyText || turn.text || '')
      if (rawFull.replace(/\s+/g, ' ').trim().length > LIMIT) {
        const attachUrl = resolveEndpoint()
        if (attachUrl) {
          const init = await rpc(attachUrl, '', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'overclock-attach', version: '1' } } })
          if (init.sid) {
            await rpc(attachUrl, init.sid, { jsonrpc: '2.0', method: 'notifications/initialized' })
            await rpc(attachUrl, init.sid, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'handoff_submit', arguments: {
              attach: true, paneId, summary: '-', status: 'done',
              fullText: rawFull.slice(0, 60000),
            } } })
          }
        }
      }
    } catch (e) { /* attach é enriquecimento best-effort — nunca falha o fechamento */ }
    try { unlinkSync(condenseFile) } catch (e) {}
    return
  }
  // F-342 + C-194.1: turno iniciado pela ENTREGA de outro pane (envelope de canal) é reação a um
  // wake, não resultado de tarefa delegada. Antes isto só bloqueava a entrega e o registro era
  // criado de qualquer forma; agora que a entrega SEGUE o submit, submeter é entregar — então o
  // eco em cadeia se evita não submetendo. (Sem isto: cada pane reenvia ao seu chamador o que
  // acabou de receber — medido 2026-07-25.)
  if (turn.fromWake) return
  // F-339 + C-194.1: o humano digitou neste pane → o turno é conversa dele, não entrega de
  // tarefa. Mesma razão: submeter agora significa acordar o chefe com algo que ele não pediu.
  if (roundIsFromHuman()) return
  // ── C-194: AUTO-PERGUNTA (decisão Laschuk 2026-07-26 — "ERRO não pode") ────────────────
  // Resposta LONGA (>LIMIT) sem submit: em vez de devolver o turno com decision:block (que a TUI
  // pinta como "Stop hook error"), o neto guarda a ÍNTEGRA e faz uma pergunta NATURAL no próprio
  // pane. A resposta curta do turno seguinte fecha verbatim pelo caminho mecânico normal, levando
  // a íntegra como fullText. Se o modelo responder longo DE NOVO (marker presente), desiste da
  // pergunta e fecha com o aviso de tamanho — nunca loop, nunca erro na tela.
  const rawReply = String(replyText || turn.text || '')
  const flatLen = rawReply.replace(/s+/g, ' ').trim().length
  let condenseStored = ''
  let condensePending = false
  try { condensePending = existsSync(condenseFile) } catch (e) {}
  if (condensePending) {
    try { condenseStored = readFileSync(condenseFile, 'utf8') } catch (e) {}
    try { unlinkSync(condenseFile) } catch (e) {}
  }
  if (!condensePending && flatLen > LIMIT) {
    try { writeFileSync(condenseFile, rawReply) } catch (e) {}
    try {
      const askUrl = resolveEndpoint()
      if (askUrl) {
        const init = await rpc(askUrl, '', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'overclock-condense', version: '1' } } })
        if (init.sid) {
          await rpc(askUrl, init.sid, { jsonrpc: '2.0', method: 'notifications/initialized' })
          // 60s, não 30s: o pane_write pro opencode mediu 33,6s (readiness+confirmação do TUI,
          // 2026-07-27, h-el) — o timeout de 30s abortava a pergunta JÁ ENTREGUE e o hook caía
          // no aviso de tamanho, descartando a condensação que chegava 5s depois.
          const askRes = await rpc(askUrl, init.sid, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pane_write', arguments: { paneId, text: 'Condense sua resposta anterior em 1 a 2 frases, na mesma língua da resposta — responda só o resumo, nada mais.' } } }, 60000)
          // h-hk (grok, 2026-07-28): pane_write pode COMPLETAR reportando falha de entrega
          // (ok:false — swallowed/parked; a pergunta nunca apareceu no pane). Sem checar, o
          // marker ficava e a ficha apodrecia até o abandono. Falha de entrega = mesma rota do
          // throw: cai no aviso de tamanho, nunca silêncio.
          if (askDelivered(askRes)) return
          // h-hr: o veredito também dá FALSO negativo (TUI repinta e a observação não vê o texto
          // entregue) — a condensação pode ter chegado e FECHADO a ficha enquanto o pane_write
          // re-colava. Fechar de novo = 2 wakes no chefe, o aviso soterrando o resumo. Re-consulta
          // o registro: ficha já não-pending = cala e sai.
          try {
            const chk = await rpc(askUrl, init.sid, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'handoff_list', arguments: { panes: [paneId] } } })
            const ans = chk.msgs.find((m) => m && m.id === 8)
            const txt = ans && ans.result && ans.result.content && ans.result.content[0] && ans.result.content[0].text || ''
            const jj = String(txt).indexOf('{')
            if (jj >= 0) {
              const p = JSON.parse(String(txt).slice(jj))
              const st = p && Array.isArray(p.handoffs) && p.handoffs[0] ? String(p.handoffs[0].status || '') : ''
              if (st && st !== 'pending') { try { unlinkSync(condenseFile) } catch (e2) {} ; return }
            }
          } catch (e) { /* re-checagem é best-effort — segue pro aviso de tamanho */ }
        }
      }
    } catch (e) { /* pergunta falhou → cai no fechamento com aviso de tamanho, nunca silêncio */ }
    try { unlinkSync(condenseFile) } catch (e) {}
  }
  // C-171: corpo da entrega (teto + aviso de truncamento) calculado UMA vez — o registro e a
  // entrega mandam exatamente o mesmo texto, então o chefe nunca vê versões diferentes.
  // C-194: pós-condensação, o corpo é a RESPOSTA da auto-pergunta, VERBATIM e sem régua de 280
  // ("1 a 2 frases" é forma, não contagem — h-ep, 2026-07-27: condensação honesta de 325 chars
  // virava aviso de tamanho). Aviso só quando o modelo repetiu a resposta longa original
  // (condensação falhou). A íntegra guardada viaja como fullText no registro (nunca na mensagem).
  const flatReply = rawReply.replace(/\s+/g, ' ').trim()
  // h-ih/h-ii (agy 2026-07-28): wake condensado SEM marca de que existe íntegra fez o chefe
  // MEDIR a condensação contra a meta de tamanho da tarefa ("ficou com 279 chars, expanda")
  // e re-despachar de graça. O sufixo diz o que o wake é: resumo com íntegra no registro.
  const built = (condenseStored && flatReply && flatReply !== condenseStored.replace(/\s+/g, ' ').trim())
    ? { body: flatReply + ' [resumo — íntegra de ' + condenseStored.replace(/\s+/g, ' ').trim().length + ' chars no registro]', fullFile: '' }
    : buildBody(replyText || turn.text || "worker terminou a ação sem chamar handoff_submit — fechamento mecânico pelo Stop hook, sem relato do modelo.")
  const url = resolveEndpoint()
  if (!url) return recordFailure('endpoint MCP não resolvido (sem NEXUS_MCP_PORT, sem mcp-pane-' + paneId + '.json, sem arquivo de porta)')
  let sid = ''
  let submitError = ''
  try {
    const init = await rpc(url, '', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'overclock-auto-handoff', version: '1' } } })
    sid = init.sid || ''
    if (!sid) return recordFailure('MCP não devolveu mcp-session-id')
    await rpc(url, sid, { jsonrpc: '2.0', method: 'notifications/initialized' })
    // Cinto redundante: a guarda de cima já retornou quando o MODELO chamou handoff_submit neste
    // turno. Mantida porque o custo é zero e o dano de duplicar registro é alto.
    if (turn.tool !== 'handoff_submit') {
      const transcript = input.transcript_path || input.transcriptPath || ''
      const call = await rpc(url, sid, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'handoff_submit',
          arguments: {
            paneId,
            status: 'done',
            // F-336 (fix 3): o fallback DIZ o que aconteceu e não sugere NENHUMA tool.
            summary: AUTO_MARK + ' ' + built.body,
            // `auto` marca a ORIGEM: fechamento mecânico, não relato do modelo. artifacts não-vazio
            // também é o que satisfaz o gate de evidência do handoff_submit (done sem prova vira
            // blocked) — o transcript É a evidência deste fechamento.
            artifacts: {
              auto: true,
              closedBy: 'stop-hook',
              sessionId: input.session_id || '',
              transcript,
              // C-171: só quando truncou — aponta o texto ÍNTEGRO citado no aviso da entrega.
              ...(built.fullFile ? { fullTextFile: built.fullFile } : {}),
            },
            ...(transcript ? { evidence: { evidenceFile: transcript } } : {}),
            ...(CALLER && CALLER !== paneId ? { to: CALLER } : {}),
            // C-194: íntegra da resposta longa NO REGISTRO (payload exato — cópia por código).
            // Pós-condensação, a íntegra é a resposta ORIGINAL guardada pela auto-pergunta.
            ...(condenseStored ? { fullText: condenseStored.slice(0, 60000) } : (built.fullFile ? { fullText: String(replyText || turn.text || '').slice(0, 60000) } : {})),
          },
        },
      })
      const answer = call.msgs.find((m) => m && m.id === 2)
      if (!answer) submitError = 'MCP não respondeu ao tools/call'
      else if (answer.error) submitError = 'MCP erro: ' + (answer.error.message || 'desconhecido')
    }
  } catch (e) {
    submitError = e && e.message ? e.message : String(e)
  }
  // ── ENTREGA: NÃO ACONTECE MAIS AQUI (C-194.1) ───────────────────────────────
  // O pane_write que existia neste ponto saiu. A entrega passou a ser consequência do SUBMIT,
  // no sidecar (core.ts › attachHandoffDelivery): um lugar só, servindo todos os CLIs, e assinada
  // pelo pane no envelope de canal. Manter os dois entregaria a mesma resposta duas vezes.
  // O bloco abaixo está desativado por uma condição sempre-falsa em vez de deletado porque o
  // COMENTÁRIO dele documenta o formato do envelope medido em campo (linha única, sem tag de
  // fechamento, atributos ^[a-zA-Z_][a-zA-Z0-9_]*$) — conhecimento caro, que o sidecar reusa.
  // A deleção final é da C-194.2, junto com o hook inteiro.
  if (false && CALLER && CALLER !== paneId && sid && !roundIsFromHuman() && !turn.fromWake) {
    // F-341: envelope de CHANNEL. O renderer do Claude Code decide a apresentação pelo PREFIXO do
    // conteúdo: mensagem que começa com <channel source="…"> é desenhada pelo componente de canal
    // (linha própria, seta de entrada, SEM o ❯ e sem balão de usuário) em vez de virar "o humano
    // digitou isso". Medido no bundle 2.1.220 (TOe/Wwr) e testado ao vivo — o modelo lê e age
    // normalmente. Antes, a entrega do worker aparecia como se o próprio usuário tivesse digitado.
    // Requisitos do formato: atributos casam ^[a-zA-Z_][a-zA-Z0-9_]*$ e o </channel> é obrigatório.
    // LINHA ÚNICA, sem tag de fechamento — medido ao vivo (2026-07-25, pane-473):
    //  · multi-linha NÃO submete: o Enter do pane_write vira quebra de linha e o texto fica
    //    PARADO no composer ("Press up to edit queued messages") — a entrega some;
    //  · com o cabeçalho na 1a linha o parser ja ativa o render de canal (seta + "overclock:");
    //    mandar a tag de fechamento faz ela aparecer LITERAL na tela como parte do conteudo.
    // O atributo worker= usa underscore (o parser exige ^[a-zA-Z_][a-zA-Z0-9_]*$ nos valores
    // que viram rótulo), então pane-472 → pane_472.
    // C-171: source= é o que a TUI desenha como rótulo (bundle 2.1.220, wrapChannelMessage), então
    // vai o PANE ali — 'pane_472: resposta' em vez do genérico 'overclock: resposta'. A marca do
    // Overclock fica em via= (nome de atributo casa ^[a-zA-Z_][a-zA-Z0-9_]*$, exigência do parser).
    const text = '<channel source="' + paneId.replace(/[^a-zA-Z0-9]/g, '_') + '" via="overclock">' + built.body
    // Timeout folgado: pane_write espera o TUI do destino aceitar input. Erro aqui NUNCA derruba
    // o hook — entrega é best-effort por design (o handoff segue consultável no handoff_list).
    try {
      await rpc(url, sid, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pane_write', arguments: { paneId: CALLER, text } } }, 30000)
    } catch (e) {}
  }
  if (submitError) recordFailure(submitError)
}
const CHILD = process.env.OVERCLOCK_STOP_CHILD === '1'
const runDetached = (raw) => {
  const payloadFile = join(gateDir, 'deliver-payload-' + paneId + '-' + process.pid + '.json')
  try { writeFileSync(payloadFile, raw) } catch (e) { return }
  try {
    const child = spawn(process.execPath, [process.argv[1], payloadFile], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, OVERCLOCK_STOP_CHILD: '1' },
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
    let head = {}
    try { head = JSON.parse(raw) } catch (e) {}
    // ── C-194.1: ensino INVISÍVEL na entrada da tarefa (UserPromptSubmit) ─────────────
    // O lembrete visível do Stop (decision:block → 'Stop hook error' na tela do worker, a cada
    // tarefa) foi REPROVADO pelo Laschuk (2026-07-26). O canal certo é o UserPromptSubmit:
    // dispara quando a TAREFA entra no pane, injeta contexto que só o modelo vê (zero pixels na
    // TUI), e o lembrete chega fresco no turno certo → o worker fecha sozinho. Só rodada de
    // SISTEMA (tarefa delegada); conversa digitada pelo humano no pane não recebe nada.
    if ((head.hook_event_name || head.hookEventName) === 'UserPromptSubmit') {
      if (CALLER && CALLER !== paneId && !roundIsFromHuman()) {
        // CONDICIONAL (decisão Laschuk 2026-07-26): resposta curta = NENHUMA tool — o worker só
        // responde e para; o fechamento mecânico do Stop entrega o payload VERBATIM (cópia por
        // código, não por obediência — o modelo re-gera e parafraseia até quando cabe, medido
        // 19:22). A tool fica pro único caso em que o resumo do modelo tem valor: resposta
        // longa (>280) ou blocked/error. Sem checklist numerada (19:21: virava receita
        // re-executada e duplicava a resposta).
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '[Overclock] Delegated task — the sender receives your report automatically. Answer normally in this pane, exactly ONCE (never into a file or artifacts unless the task asks). If your whole answer fits in 280 chars, just END your turn after answering — the system delivers it verbatim; do NOT call any tool and do NOT repeat the answer. ONLY when the answer does NOT fit in 280 chars (or you are blocked / hit an error), call nexus_handoff_submit({ summary: 1-2 sentences — your condensation of the answer (or the blocker), task language, fullText: your complete answer unchanged, status: "done" | "blocked" | "error" }) as your LAST action, then one short closing line; ToolSearch "select:nexus_handoff_submit" if the schema is missing.' } }))
      }
      process.exit(0)
    }
    if (head.stop_hook_active === true || head.stopHookActive === true) process.exit(0)
    try { if (existsSync(pendingMarker)) process.exit(0) } catch (e) {}
    runDetached(raw)
    nagIfPreviousFailed()
    // exit 0 AGORA: demorar aqui é o que punha o worker em retry no fim do turno.
    process.exit(0)
  })
}
