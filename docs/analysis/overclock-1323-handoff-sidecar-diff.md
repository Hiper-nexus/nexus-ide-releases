# Overclock 1.3.18 → 1.3.23 — Diff comportamental do harness de handoff e do sidecar

Data: 2026-09-15. Escopo: hooks de handoff (handoff-stop, handoff-deliver, soft-status),
kimi-mcp-bridge, gates per-pane, arms-mcp, prompts de squad e o sidecar (protocolo MCP,
materialização de hooks, marcadores). Documento irmão de
`overclock-1323-delta-inventario.md` (inventário geral) e `overclock-1323-harness.md`
(matriz task→modelo/effort/skill). Notas de trabalho por etapa:
`overclock-1323-extract/NOTAS-A.md` … `NOTAS-G.md`.

## 1. Método e evidência

**Mudança estrutural desta versão:** os 5 `.mjs` top-level do sidecar
(`handoff-stop.mjs`, `handoff-deliver.mjs`, `kimi-mcp-bridge.mjs`, `overclock-doctor.mjs`,
`soft-status.mjs`) **sumiram do bundle** (filelist diff em
`overclock-1323-extract/filelist-diff-vs-1318.txt`). As fontes agora vivem **embutidas como
strings dentro do `index.jsc`** (4.592.448 bytes, sha256
`4aa0f6f8a7f943fa800c8e88e4a126a41ca94b6777ffd1b79771889039c8bf00`) e são materializadas em
runtime pelo sidecar.

**Extração (confirmado em código):** varredura do jsc por runs de string u8 (latin1) e u16le,
concatenação em ordem de offset por faixa (scripts `/tmp/oc1323-bigstrings.py` e
`/tmp/oc1323-reassemble.py`). Offsets das fontes: handoff-stop @2758927, handoff-deliver
@2826396, soft-status @2873834, overclock-handoff.js (plugin opencode) @2884011,
kimi-mcp-bridge @4506837, gate-shim @2732461, skill-gate @2736041, resource-gate @2747535,
workflow-deny @2754882, dangerous-cmd-gate @2487156, release-gate @2495942. Reagrupados:
handoff-stop (33.863 B, 3 GAPs), handoff-deliver (23.736 B, 4 GAPs) — contra 34.874 B e
23.281 B dos originais 1.3.18, ou seja, cobertura ~completa.

**Artefatos de leitura (não são mudanças de comportamento):** em-dashes/flechas (`—`, `⇒`,
`→`) viram espaços duplos; literais guardados fora de linha aparecem como lixo
(`const gateDir = 9#.ÞÉ|1#`); constantes numéricas out-of-line (`const LIMIT = ` — o valor
280 é confirmado pelo texto das mensagens); divisórias `───` viram `%%%%`. Todo trecho
citado abaixo como "depois" teve esses artefatos filtrados; quando uma lacuna impede
afirmar, está marcado **[lacuna]**.

**Veredito por item:** "confirmado em código" = diff direto contra o arquivo 1.3.18 do
extract; "só strings" = nome/texto visível no jsc sem corpo legível.

---

## 2. handoff-stop.mjs (hook Stop + UserPromptSubmit do Claude)

Diff: 518 linhas (`/tmp/diff-stop.txt`), esmagadora maioria artefato de leitura.
**3 mudanças reais, confirmadas em código.**

### 2.1 NOVO — HUMAN QUESTION GATE (F-546 / F-557) para orquestrador de squad

No ramo `UserPromptSubmit` do pai, ANTES do ensino de tarefa delegada:

```js
// DEPOIS (1.3.23) — bloco novo:
if ((head.hook_event_name || head.hookEventName) === 'UserPromptSubmit') {
  const squadRole = process.env.OVERCLOCK_SQUAD_ROLE || ''
  if (squadRole === 'orchestrator' && (!CALLER || CALLER === paneId)) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
      additionalContext: '[Overclock] HUMAN QUESTION GATE (F-546 / F-557): any question to the user
      MUST use native AskUserQuestion (one question, suggestions as options) AND overclock_clarify
      (registers F-215 awaiting). Never ask in loose chat text  that pause is unprotected and
      duplicates the native selector. After the tools, END YOUR TURN (F-215).' } }))
  }
  if (CALLER && CALLER !== paneId && !roundIsFromHuman()) { /* …ensino C-194.1 inalterado… */ }
  process.exit(0)
}
```

Na 1.3.18 esse ramo tinha apenas o ensino de tarefa delegada (o texto condicional
"resposta curta = NENHUMA tool…"), que segue byte-equivalente. Comportamento novo: o pane
orquestrador de squad recebe, a cada entrada de prompt, uma instrução invisível exigindo que
toda pergunta ao humano passe pelo seletor nativo + registro F-215 — nunca texto solto no chat.
`OVERCLOCK_SQUAD_ROLE` é env nova (grep=0 em todos os artefatos 1.3.18).

### 2.2 Autenticação bearer no rpc()

```js
// ANTES (1.3.18):
const rpc = async (url, sid, body, timeoutMs) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (sid) headers['mcp-session-id'] = sid

// DEPOIS (1.3.23):
const rpc = async (url, sid, body, timeoutMs) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const bearer = process.env.OVERCLOCK_MCP_BEARER_TOKEN || ''
  if (bearer) headers.authorization = 'Bearer ' + bearer
  if (sid) headers['mcp-session-id'] = sid
```

O token efêmero do sidecar agora é exigido também no canal hook→MCP (antes só o WS_TOKEN do
boot protegia o lado cliente). Mesma mudança no deliver e no bridge (§3.5, §5.1).

### 2.3 Materialização pelo sidecar (forma de instalação)

```
// ANTES (arquivo materializado na 1.3.18):
#!/bin/sh
':' //# ; exec '/Applications/Overclock.app/Contents/Resources/sidecar/bin/node' "$0" "$@"
const gateDir = "/Users/cleofasrocha/.overclock-app"

// DEPOIS (fonte embutida 1.3.23):
#!/usr/bin/env node
const gateDir = <expressão out-of-line — OVERCLOCK_GATE_DIR || fallback; ver §3.1>
```

O shebang polyglot com o node cravado morreu porque quem spawna o hook agora é o sidecar com
seu próprio node; o caminho cravado do gateDir virou env + fallback (motivação no F-626, §3.1).

**Inalterado (confirmado linha a linha):** readTurn (guards tool/fromWake), payloadText
(F-355, `last_assistant_message` como fonte primária), buildBody com LIMIT=280 e aviso de
tamanho + ponteiro `handoff_list({panes:[…], full:true})`, fluxo de condensação C-194
(auto-pergunta via pane_write, 60s, re-checagem h-hr), dedup por handoff_submit no transcript
(poll 1s, teto ~83ms medido), guards clarify (F-215) / Workflow em voo / fromWake (F-342) /
roundIsFromHuman (F-339), neto desacoplado F-352 (`OVERCLOCK_STOP_CHILD`, payload
`deliver-payload-<pane>-<pid>.json`), nagIfPreviousFailed, e o bloco morto `if (false && …)`
que documenta o envelope de canal. Detalhe: `nudgeMarker` é usado sem definição visível em
AMBAS as versões (mesmo texto, mesmo ponto) — não é delta; anomalia pré-existente que o
try/catch transforma em no-op silencioso.

---

## 3. handoff-deliver.mjs (hook gêmeo para gemini/opencode/codex/grok/agy)

Diff: 428 linhas (`/tmp/diff-deliver.txt`). **5 mudanças reais, confirmadas em código.**

### 3.1 F-626 — a instância DONA do pane manda no diretório de gates

```js
// ANTES:
const gateDir = "/Users/cleofasrocha/.overclock-app"

// DEPOIS:
// F-626: a instância DONA do pane manda  o env do processo vence o caminho cravado na
// escrita. Um hooks.json compartilhado (mesmo workspace aberto em dev e prod, ou o global
// envenenado) faria o pane de PRODUÇÃO gravar marcadores/entrega no pane-files.dev da
// instância errada. Fallback = o valor cravado (gemini sanitiza o env).
const gateDir = process.env.OVERCLOCK_GATE_DIR || <valor cravado>
```

Mesma mudança no soft-status (§4.1) e no gate-shim (§6.1). Vetor corrigido: hooks.json
compartilhado entre instâncias (dev/prod) executando o hook da instância errada.

### 3.2 F-536 — Codex Stop exige JSON no stdout; stdin consumido antes de qualquer saída

```js
// ANTES:
if (!paneId || !CALLER || CALLER === paneId) process.exit(0)   // top-level, antes do stdin

// DEPOIS:
// F-536: Codex Stop exige JSON no stdout. Síncrono ANTES de qualquer early-return 
// pane livre (sem caller) também precisa responder, senão o runner marca FAILED.
try { writeFileSync(1, '{"continue":true}\n') } catch (e) {}
// … e dentro de main():
// F-536: guarda do caller DEPOIS de consumir o stdin (o runner do Codex se ressente
// de processo que sai antes de fechar o stdin). Pane livre / sem identidade = no-op.
if (!paneId || !CALLER || CALLER === paneId) return
```

E no pai (trecho reagrupado, cabeçalho visível): "a ÚNICA guarda do pai é 'sem caller → sai
depois do stdin, sem relançar neto'". Três sintomas tratados: saída sem JSON = hook FAILED;
saída antes do fim do stdin = runner se ressente; neto relançado para pane livre = desperdício.

### 3.3 F-555 — endpoint MCP vira LISTA com fallback (env herdada pode ser mentira)

```js
// ANTES: const resolveEndpoint = () => { …um único base… return base + '/mcp' + query }

// DEPOIS:
// F-555: a env herdada pode ser MENTIRA (launch pin 63700/53700 depois de EADDRINUSE
// fallback  o arquivo de porta tem o bind real, a env fica na porta morta). Devolve
// uma LISTA: tenta a primária (env vence, F-010) e cai no arquivo se o init falhar.
const resolveEndpoints = () => {
  const direct = process.env.OVERCLOCK_MCP_URL || ''
  if (direct) return [direct]
  // … monta candidatos deduplicados: OVERCLOCK_MCP_BASE_URL, origin do mcp-pane-<id>.json,
  //     env OVERCLOCK_MCP_PORT, arquivo de porta da instância …
  return out
}
// no main():
for (let i = 0; i < urls.length; i++) {
  try {
    // 1.5s na primeira tentativa quando há fallback: env morta não pode comer 8s.
    const init = await rpc(urls[i], '', { …initialize… },
      (i === 0 && urls.length > 1) ? 1500 : 8000)
    if (!init.sid) continue
    await rpc(urls[i], init.sid, { …notifications/initialized… })
    sid = init.sid; url = urls[i]; break
  } catch (e) { /* tenta o próximo candidato (F-555) */ }
}
if (!sid || !url) return
```

### 3.4 F-555 — dedup por status TERMINAL estrito (vigia ≠ fechamento do modelo)

```js
// ANTES:
if (latestStatus && latestStatus !== 'pending') {
  // Modelo já fechou. Escada de consulta: anexa a íntegra quando longa…

// DEPOIS:
// F-555: abandoned/stalled/dead/closed_by_caller/closed_by_human NÃO são fechamento do modelo
// são o vigia. Stop com resposta real ainda fecha (senão o chefe fica só com o abandono).
if (latestStatus === 'done' || latestStatus === 'blocked' || latestStatus === 'error') {
```

Antes, qualquer status não-pending (incluindo os escritos pelo vigia de abandono) fazia o hook
tratar a ficha como fechada pelo modelo e sair sem submeter — o chefe ficava só com o
"abandoned". Agora só done/blocked/error suprimem o fechamento mecânico.

### 3.5 Bearer token no rpc()

Idêntico ao §2.2 (`OVERCLOCK_MCP_BEARER_TOKEN` → `authorization: Bearer …`).

**Inalterado:** scanTranscript multi-dialeto (incl. ramo agy `source === 'MODEL'` /
`PLANNER_RESPONSE` e unwrap de `<USER_REQUEST>`), WAKE_RE aceitando `via="overclock"` e
`source="overclock"`, claim `deliver-seen-<pane>-<hash>`, condensação com guarda de
re-disparo do codex (payload igual à íntegra = mantém marker), auto-pergunta 60s +
askDelivered (h-hk) + re-checagem de ficha (h-hr), sufixo `[resumo — íntegra de N chars no
registro]`, fullText 60k.

---

## 4. soft-status.mjs

**2 mudanças reais, confirmadas em código.**

### 4.1 F-626 — gateDir via env

Mesmo comentário e mesma construção do deliver (§3.1).

### 4.2 F-536 — continue-json no Stop

```js
// DEPOIS (novo, após ler stdin, antes de qualquer exit):
// F-536: Stop do Codex exige JSON no stdout. Depois do stdin, antes de qualquer exit.
// Claude ignora {"continue":true} (é o default). Não toca PreToolUse/PermissionRequest.
if (event === 'Stop') { try { writeFileSync(1, '{"continue":true}\n') } catch (e) {} }
```

**Inalterado:** EVENT_ALIASES (grok snake_case / gemini BeforeAgent→UserPromptSubmit etc. →
vocabulário claude), ASK_TOOLS, WAITING_NOTIF_TYPES/WAITING_MSG_RE (sem "approval" solto,
F-249), marcadores `soft-waiting-`/`soft-session-`.

---

## 5. kimi-mcp-bridge.mjs (ponte stdio⇄HTTP para o kimi-code)

Diff direto contra o arquivo 1.3.18 (204 linhas reagrupadas). **2 mudanças reais.**

### 5.1 Bearer token

```js
// DEPOIS:
const TOKEN = process.env.OVERCLOCK_MCP_BEARER_TOKEN || ''
// … no forward():
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
if (TOKEN) headers.authorization = 'Bearer ' + TOKEN
```

### 5.2 OVKA-375 — perfil de exposição DECLARADO na query do /mcp/kimi

```js
// DEPOIS (novo em endpointUrl()):
// OVKA-375: perfil de exposição DECLARADO + quem spawnou + leaf/delegateOnly  o host é
// fail-closed (sinal ausente = worker); sem isto o kimi do humano nasceria com 7 tools.
put('toolProfile', process.env.OVERCLOCK_PANE_TOOL_PROFILE)
put('spawnedByPaneId', process.env.OVERCLOCK_PANE_SPAWNED_BY)
put('leaf', process.env.OVERCLOCK_PANE_LEAF)
put('delegateOnly', process.env.OVERCLOCK_PANE_DELEGATE_ONLY)
```

Na 1.3.18 o host inferia o perfil; agora o pane declara e o host é fail-closed (ausente =
perfil worker restrito). Consequência documentada no próprio comentário: o kimi do humano sem
essas envs nasceria com o perfil de 7 tools.

**Inalterado:** casamento por id, handshake serial + concorrência pós-gate, framing por linha,
drain no stdin end.

---

## 6. Gates per-pane embutidos (todos NOVOS como fontes standalone)

Nenhum desses nomes/corpos aparece em qualquer artefato da 1.3.18 (extract de 102 arquivos +
dossiê + runtime JSON) — grep=0 para `gate-shim`, `skill-gate`, `workflow-deny`,
`dangerous-cmd`, `release-gate`, `F-658`, `F-651`, `F-536`, `F-546`, `F-555`, `F-557`,
`F-626`. Ressalva: a 1.3.18 já tinha um "PreToolUse gate" de squad citado na descrição da tool
(runtime JSON, F-639); o que é novo é a arquitetura shim+templates embutidos e os gates
nomeados abaixo. Não temos mais o app 1.3.18 para provar ausência no jsc antigo — marcado
como "novo por evidência indireta".

### 6.1 gate-shim- (F-658 + F-626) — resolvedor durável, fail-closed

```js
#!/usr/bin/env node
// F-658: resolvedor durável do gate por-pane. Falha = NEGA (nunca passa batido).
const PREFIX = <out-of-line>   // ex.: "skill-gate-", "release-gate-", …
// F-626: a instância DONA do pane manda no diretório (um pane de produção pode acabar
// executando um shim escrito pelo dev). Sem o env, o próprio diretório do shim.
const DIR = process.env.OVERCLOCK_GATE_DIR || dirname(fileURLToPath(import.meta.url))
const deny = (why) => { process.stderr.write(why); process.exit(2) }
const paneId = process.env.OVERCLOCK_PANE_ID || ""
if (!paneId) deny("…OVERCLOCK_PANE_ID ausente… Negado por seguranca (fail-closed)…")
const target = join(DIR, PREFIX + paneId + ".mjs")
if (!existsSync(target)) deny("…o arquivo de trava deste pane (" + PREFIX + paneId +
  ".mjs) nao existe mais  provavelmente apagado por um boot de outra instancia do sidecar
  (F-658). Sem ele a politica do pane NAO pode ser aplicada… pane precisa ser respawnado.")
await import(pathToFileURL(target).href)
```

O hooks.json aponta para um shim estável; o shim resolve o gate real do pane e **nega** quando
não consegue (gate órfão de boot de outra instância = deny + instrução de respawn, nunca
"passa batido"). É a resposta ao problema clássico de boot racing apagar gates alheios.

### 6.2 skill-gate- (PreToolUse de squad)

Constantes parametrizadas por template: `ALLOWED_SKILLS`, `ALLOWED_TOOLS`, `DENIED_TOOLS`
(visibilidade: negação vence allowlist), **`DENIED_SKILLS` (F-651 — skills do modo agêntico
negadas em pane de squad: "Your squad and its skills were already composed for you. Do not
retry and do not report this as a blocker: deliver with what you have.")**,
`REQUIRED_SKILLS_FOR_MEDIA` + `MARKER_PREFIX` (media-contract: tool de geração negada se a
skill dona não foi carregada antes — marker `skill-loaded-<pane>-<base>`, F-639).

```js
const MEDIA_GEN_TOOLS = ["mcp__overclock__overclock_media_generate", "…_image_generate",
  "…_video_generate", "…_audio_generate"]
// Protocolo de handoff é INFRAESTRUTURA, não capacidade: SÓ estes são auto-allowed —
// NÃO o prefixo mcp__overclock__ inteiro (pane_spawn/pane_write/pane_close escapariam):
const ALWAYS_ALLOWED_TOOLS = ["ToolSearch", "mcp__overclock__handoff_submit", "mcp__overclock__handoff_list"]
// F-639: EVERY skill load leaves a marker (skill-loaded-<pane>-<base>)  the sidecar audits
// them at handoff so a deliverable whose bound skill was never invoked is flagged.
if (base) { try { writeFileSync(MARKER_PREFIX + base, "1") } catch (e) {} }
```

A justificativa no comentário é explícita: "Under --dangerously-skip-permissions this
PreToolUse gate is the ONLY hard enforcement, so the allowlist must be exact." O deny de tool
fora da whitelist manda o worker **declarar o bloqueio no handoff** (para a política ser
alargada) em vez de contornar em silêncio.

### 6.3 resource-gate- (PreResourceUse)

Bloqueia as duas rotas de bypass por Bash/Shell: (a) ler o key store
(`SECRET_MARKERS = ["service-keys.json", "service-keys"]` — F-214: específico, nunca o data
dir inteiro); (b) chamar host de provider direto (`api.replicate.com`, `queue.fal.run`,
`api.openai.com`, `generativelanguage.googleapis.com`, `api.elevenlabs.io`…). E F-216:
`EXTERNAL_PUBLISH_HOSTS = ["claude.ai/code/artifact", "claude.ai/public",
"artifacts.claude.ai"]` — publicação externa é irreversível; worker entrega LOCAL.

### 6.4 workflow-deny- — Workflow bloqueado para chefes de delegação

```js
if ((input.tool_name || '') === 'Workflow') {
  process.stderr.write('BLOCKED: Workflow tool is disabled for delegation chefes
    (delegateOnly+requireHandoff). Overclock requires visible pane delegation  invisible
    background agents violate the visible-delegation contract. Use pane_spawn({persona})…')
  process.exit(2)
}
```

Doutrina "delegação visível" aplicada por gate duro, não por prompt.

### 6.5 dangerous-cmd-gate- (PreToolUse, dangerousCommand.ts, OPT-IN)

~25 padrões destrutivos com descrição (amostra confirmada nas strings):
`rm -rf`/`rm --recursive`, "delete in root path", chmod 777/666/o+w/a+w (+recursivo),
`chown -R root`, `mkfs`, `dd if=`, `> /dev/sd*`, `DROP TABLE|DATABASE`,
`DELETE FROM` sem WHERE, `TRUNCATE`, `> /etc/`, `systemctl stop|disable|mask`,
`kill -9 -1`, `pkill -9`, fork bomb, `(bash|sh|zsh|ksh) -c`, `(python|perl|ruby|node) -e/-c`,
`curl|wget … | sh`, `xargs … rm`, `find -exec rm`, `find -delete`, `cp|mv|install … /etc/`,
`sed -i … /etc/`. `PERMANENT_ALLOWLIST` por chave; `BLOCK_MODE` (false = warn-only no stderr,
exit 0; true = exit 2). Normalização `NFKC` + strip de `\x00` antes de casar regex.

### 6.6 release-gate- (F-282, releaseCommand.ts, HARD BLOCK, sem allowlist)

```js
// "releases são ato HUMANO… cortar tag, pushar tag, rodar pnpm release/lancar:* ou mutar
//  gh release está fora do teu contrato… NÃO retente… reporte via handoff_submit que o
//  repo está pronto para o humano lançar."
```

Padrões: `git push … --tags/--follow-tags`, `git push … refs/tags/`, push de tag com versão
(`v?\d+\.\d+\.\d+`), `git tag` (exceto list/verify/delete), `pnpm|npm|yarn|bun (run )?release`,
`… lancar:*`, `scripts/(release|lancar).mjs`, `gh release create|edit|delete|delete-asset|
upload`, `gh api … releases` com método mutativo.

### 6.7 runDetached compartilhado — windowsHide

```js
// DEPOIS (template spawnHelpers; ANTES não tinha a flag):
const child = spawn(process.execPath, [process.argv[1], payloadFile], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,        // ← novo na 1.3.23
  env: { ...process.env, [childEnvVar]: '1' },
})
```

O template agora parametriza `childEnvVar` / `parentGuard` / `afterDetach` (uma fonte, N
hooks) — na 1.3.18 o runDetached estava duplicado em cada arquivo com o nome do env cravado.

---

## 7. arms-mcp — OVKA-283 (pin de instância por --descriptor)

Diff byte a byte: só `bin.js` (comentário de header), `bin.d.ts`, `discovery.js`,
`discovery.d.ts` mudaram; restante idêntico. Novo teste `descriptorPin.ovka283.test.js`.

```js
// DEPOIS (discovery.js, envForArgs):
// OVKA-283 — --descriptor <caminho> amarra o wrapper a UMA instancia, por construcao.
// Beta e producao convivem na mesma maquina… mas os dois wrappers procuravam o mesmo
// sidecar.json: o cliente externo registrava o comando que a Beta publicou e falava com a
// producao. O sidecar que PUBLICA o descritor e o unico que sabe quem ele e, entao ele
// publica o caminho junto com o comando (buildSidecarDescriptor). Deduzir a instancia aqui
// dentro seria uma segunda copia da heuristica de caminho — a origem do F-703.
const at = argv.indexOf('--descriptor')
const pinned = at >= 0 ? argv[at + 1] : undefined
if (pinned && pinned.trim())
    return { ...env, OVERCLOCK_ARMS_DESCRIPTOR: pinned.trim() }
```

Bug corrigido (F-703): comando publicado pelo Beta conectava na PRODUÇÃO quando ambas abertas.

---

## 8. Prompts de squad — OVKA-443 (reorganização de skills oc-*)

4 arquivos alterados (diff direto, confirmado):

1. **qa-swarm/agents/qa-swarm-reviewer.md** — nova seção "Base skill": a doutrina de revisão
   passa a ser `oc-conveyor` (escopo universal, "granted to every pane, OVKA-443"): auditoria
   adversarial, um finding localizado por linha, contagem por severidade, sem edições,
   findings no handoff, e modo opcional de registro `TASK/items/F-XXX.md`. "Brief your hunters
   to follow it; load it yourself only when the Skill tool exists in your pane (a delegator
   has it removed by policy)."
2. **qa-vision/agents/qa-reviewer-estatico.md** — mesmo movimento em pt-BR: invocar
   `oc-conveyor` + `qa-finding-protocol` no início da sessão.
3. **squad-former/agents/search-specialist.md** — `allowedSkills`:
   `overclock-research-cite` → `oc-scout` (rename confirmado: "ex-overclock-research-cite").
4. **arsenal/skills/oc-app-ui/SKILL.md** — 184 linhas → 19: vira alias DEPRECATED que manda
   carregar `oc-showcase` ("absorbed by oc-showcase (OVKA-443, 2026-09-09)… universal scope").

Todos os PLAYBOOKs byte-idênticos. As 10 skills oc-* novas e a migração das skills
`overclock-squad-*`/`overclock-skill-*` de `squad-former/skills/` para `arsenal/skills/`
estão em NOTAS-A.

---

## 9. Sidecar / protocolo / marcadores

### 9.1 Protocolo MCP agora é stateful (confirmado em runtime — NOTAS-D)

Boot standalone pela receita §8 do dossiê 1.3.18 **funcionou com uma adaptação**: depois do
`initialize`, todo POST exige o header `Mcp-Session-Id` da sessão (na 1.3.18 o probe batia
sem). Accept dual `application/json, text/event-stream` segue. Lista viva extraída:
`overclock-1323-extract/sidecar-tools-runtime.json` (18 tools em `/mcp/orchestrator`, 9 em
`/mcp/claude` no perfil worker). **cron registra de verdade** (`overclock_cron_list` →
`{ok:true,count:0,jobs:[]}`) — na 1.3.18 era um dos 8 fantasmas; memory segue morta.

### 9.2 Materialização de hooks pelo sidecar (só strings)

Manifesto visível no jsc: `handoff-stop.mjs`, `handoff-deliver.mjs`, `soft-status.mjs`,
`overclock-handoff.js` ("GERADO por packages/sidecar/src/spawnHelpers.ts (C-171) — não editar
à mão"), `hooks.json`, `overclock-handoff-deliver`, `overclock.json`, `codexHome`,
`statusMessage` ("Overclock soft status", "Overclock handoff delivery"), `timeoutSec`,
`eventLabel`. Para o codex, o sidecar escreve `config.toml` com
`[hooks.state."…"]` + `trusted_hash = "…"` e força `trust_level = "trusted"` (3 ocorrências +
regex de reescrita) — ou seja, ele mesmo assina/confia os hooks que instala, sem diálogo.
Arquivos do home do kimi tocados pela camada de sync: `mcp-tokens.json`, `updates.json`,
`trusted-hooks.json`, `tui.toml`, `device_id`, `session_index.jsonl`…

### 9.3 Varredura de marcadores absorvida pelo sidecar (só strings)

Lista de 15 prefixos de marcador varridos (região @3673437): `mcp-pane-`, `handoff-pending-`,
`handoff-marker-`, `handoff-stopcount-`, **`handoff-post-` (novo)**, **`handoff-stop-`
(prefixo novo, distinto de stopcount)**, **`clarify-marker-` (novo)**,
**`workflow-inflight-` (novo)**, `soft-waiting-`, `soft-session-`, `deliver-seen-`,
`handoff-full-`, `handoff-fail-`, `handoff-condense-`, `deliver-payload-`. Os 4 novos não
aparecem em nenhum hook legível — são criados/consumidos pelo core compilado; papel exato
**não confirmado** além do nome. Logs adjacentes: `[sidecar] F-280: pane … auth.json persisted
back to the account home`, `F-293: config/trust persisted…`, `OVKA-426: devolveu ao
~/.commandcode real`.

### 9.4 overclock-doctor.mjs — REMOVIDO

Saída do bundle e **0 referências em strings** no jsc: o doctor standalone não existe mais na
1.3.23. A função de varredura de marcadores órfãos aparentemente migrou para dentro do sidecar
(§9.3). Não confirmado se algum comando MCP/UI expõe diagnóstico equivalente.

---

## 10. Cruzamento com o NexusIDE (verificado em código deste repo)

| Mecanismo 1.3.23 | Nexus tem? | Evidência no Nexus |
|---|---|---|
| Bearer token hook→sidecar | **SIM** | `src/main/orch/hooks-gen.ts:47` (`authorization: 'Bearer ' + token`) |
| Neto detached no Stop (F-352) | SIM | `hooks-gen.ts:57-89` (NEXUS_HOOK_CHILD, tmp payload) |
| Gate PreToolUse fail-closed síncrono | SIM | `hooks-gen.ts:91-110` (exit 2 em qualquer falha) |
| allowedSkills `[]` = hard gate | SIM | `gate.ts:252-259`, `skill-mirror.ts:572` |
| F-536: `{"continue":true}` no stdout do Stop (Codex) | **NÃO** | `hooks-gen.ts:89` sai 0 em silêncio; nenhum `continue` escrito (grep=0 em src/main/orch). Mesmo sintoma que o Overclock corrigiu. Stdin é consumido (OK). |
| F-555: multi-endpoint com fallback + timeout curto no 1º | NÃO | bridge/hooks usam URL única por boot |
| F-555: dedup só em done/blocked/error (vigia ≠ fechamento) | verificar caso a caso | turn-end-handoff.ts não menciona `abandoned/stalled/closed_by` (grep=0) |
| F-626: OVERCLOCK_GATE_DIR (dono da instância vence caminho cravado) | NÃO | hooks nexus são por home efêmero, sem dir compartilhado — vetor menor, mas o padrão vale para dev/prod |
| HUMAN QUESTION GATE (F-546/F-557) no UserPromptSubmit do orquestrador | PARCIAL/AUSENTE | Nexus tem `nexus_clarify` (tools-domain.ts:1268) mas nenhum hook UserPromptSubmit injetando a regra "AskUserQuestion nativo + clarify, nunca texto solto" |
| F-639 marcador `skill-loaded-` + auditoria no handoff | NÃO | grep=0 em src/main/orch |
| F-651 DENIED_SKILLS (denylist vence allowlist) | PARCIAL | gate.ts tem ORCHESTRATOR_DENIED_TOOLS/NATIVE (linhas 125-133, 211, 246), não denylist de skills por squad |
| dangerous-cmd-gate per-pane com allowlist | PARCIAL | Nexus tem classificador destrutivo no mobile-companion-policy.ts (camada remote), não um PreToolUse gate de padrões por pane |
| release-gate (F-282) per-pane | NÃO encontrado | grep=0 |
| workflow-deny (Workflow bloqueado p/ chefes) | n/a | Nexus não expõe tool Workflow equivalente |
| windowsHide no neto detached | NÃO | `hooks-gen.ts:80-84` sem `windowsHide` (janela de console pisca no Windows) |
| OVKA-375 toolProfile/spawnedBy/leaf/delegateOnly declarado | PARCIAL | Nexus declara role no spawn do pane, mas o bridge kimi não passa perfil por query (não encontrado) |
| OVKA-283 --descriptor pin | NÃO | `bin/nexus-arms.mjs:33-63` resolve UM runtimeDescriptor() sem flag de pin |

---

## 11. Não confirmado / lacunas

- Papel exato dos marcadores novos `handoff-post-`, `handoff-stop-`, `clarify-marker-`,
  `workflow-inflight-` (só nomes na varredura; §9.3).
- Se a 1.3.18 já tinha algum dos gates da §6 embutido no jsc antigo (app 1.3.18 não está mais
  instalado; ausência provada só nos artefatos clonados).
- Se o overclock-doctor foi substituído por comando MCP/UI (§9.4).
- `LIMIT` e literais out-of-line (ex.: texto do FALLBACK) — valores não reagrupados, inferidos
  por contexto (280; mesmo texto da 1.3.18).
- Se o Nexus precisa do F-536 depende do runner do Codex usado pelos panes Nexus — o sintoma
  (hook Stop sem JSON no stdout = FAILED) é o que o Overclock mediu; não reproduzido no Nexus.
