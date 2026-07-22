# NEXUS-UI-BUGS-001 — Handoff de achados (consult, read-only — nada codado)

> Missão `mission-81aa95d1-8d6f-46f4-b923-488dcaa147bb`, lane=consult (maxWorkers:0).
> Contrato dessa lane é **investigação só-leitura** — nenhum código foi alterado.
> Este arquivo existe para outra sessão (execução/PREVC normal) codar os fixes.
> Todos os achados abaixo têm arquivo + linha confirmados por leitura direta do código
> nesta sessão (2026-07-18), não por suposição.

---

## 1. [BUG REAL, causa raiz confirmada] Perda de login em sessão com 2 contas Claude

**Sintoma reportado pelo usuário** (múltiplas vezes, inclusive ao vivo durante esta
sessão): sessão do Nexus estava logada, funcionando, e no meio do trabalho pede
`/login` de novo com:
```
Please run /login · API Error: 401 OAuth access token has expired. Re-authenticate to continue.
Please run /login · API Error: 401 Invalid authentication credentials
Remote Control failed · Session creation failed — see debug log
```
Usuário usa **2 contas Claude** (`admin@volarehost.com.br` e uma segunda conta
`retorno` / `retornoja@gmail.com`, confirmada no banco local durante a investigação).

**Causa raiz (REVISADA após segunda passada de verificação — dois mecanismos):**

**Mecanismo A — o principal (troca de conta sobrescreve o Keychain nativo com
snapshot morto):**
- O blob OAuth de cada conta é capturado no vault **uma única vez**, no momento do
  "salvar sessão ativa" (`addActiveSessionAccount`, `account-store.ts:818-885`, que lê
  o Keychain nativo via `readActiveClaudeCredential`).
- O CLI Claude real rotaciona o refresh_token sozinho na entrada
  `Claude Code-credentials` do Keychain (`claude-credential.ts:17-37`). O snapshot no
  vault do Nexus **não acompanha** essa rotação: ao contrário dos providers file-backed
  (Codex/Grok), que têm read-back (`readBackFresherAuth`, `account-store.ts:311-316`,
  comentário *"Persist CLI-refreshed tokens before materialize"*), **o Claude não tem
  nenhum read-back equivalente**. Essa assimetria é o buraco.
- Quando o usuário clica **"Usar"** em outra conta do vault, `activateAccount`
  (`account-store.ts:945-959`) chama `ensureSubscriptionActive` →
  `writeActiveClaudeCredential(blob)` (`account-store.ts:277-283` +
  `claude-credential.ts:40-63`), que **sobrescreve a entrada nativa do Keychain com o
  snapshot do vault**. Se o snapshot está velho (e ele sempre acaba ficando, pelo ponto
  anterior), a sessão nativa do CLI que estava funcionando é **clobberada com
  credencial morta no meio do trabalho** → o CLI da sessão viva perde o login e pede
  `/login` de novo. É exatamente o "perdeu login no meio da sessão fazendo serviço".
- O time já esbarrou nisso antes: `provider-config-store.ts:423-427` tem o comentário
  *"restoring an old OAuth snapshot can overwrite the CLI's current native session and
  trigger an endless login loop"* — e o fix daquela vez foi excluir o Claude do caminho
  implícito de conta ativa. Mas o caminho **explícito** (`activateAccount`, botão
  "Usar" / troca de conta) continua fazendo a sobrescrita sem re-sincronizar antes.

**Mecanismo B — secundário (sweeper rotaciona refresh_token por fora):**
- Contas **secundárias** do vault são renovadas por um sweeper de 15 min
  (`startClaudeSubscriptionFreshness`, `account-store.ts:547-559` →
  `refreshClaudeOauthBlob`, `src/main/quota/claude-oauth-refresh.ts:77-123`), que
  rotaciona o refresh_token no provider. A conta nativa é pulada de propósito
  (linhas 517-524).
- Além disso, `subscriptionAuthEnv` (`account-store.ts:345-376`) injeta
  `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` no env dos panes pinados — se o CLI do pane usar
  esse refresh token para rotacionar, o vault também não fica sabendo (sem read-back).
- Resultado: **três atores** podem rotacionar a mesma linhagem (CLI nativo, sweeper,
  CLI de pane pinado), cada um guardando o resultado num lugar diferente. Quem perder a
  corrida fica com refresh_token consumido → `401 Invalid authentication credentials`.

**Evidência no banco local** (SQLite `nexus.db`, lido durante a investigação): a conta
`admin@volarehost.com.br` estava com `last_error = "Error: 401"` e cooldown de 15 min
(o cooldown de kind `auth` do `limit-detector.ts:169`) minutos depois de a segunda
conta (`retorno` / `retornoja@gmail.com`, criada 18:28) ter sido salva/ativada — o
padrão exato previsto pelo Mecanismo A.

**Por que "já corrigimos isso várias vezes e volta"**: cada correção manual
(reconectar a conta) só grava um snapshot fresco; o snapshot volta a apodrecer na
próxima rotação do CLI real, e a próxima troca de conta re-instala credencial morta.

**Fix recomendado (não implementado):**
1. **Read-back para Claude (espelhar o padrão file-backed):** antes de QUALQUER uso do
   blob do vault (em `activateAccount`/`ensureSubscriptionActive`, no sweeper e em
   `subscriptionAuthEnv`), se `activeClaudeEmail()` bate com o e-mail da conta,
   re-capturar o Keychain nativo (`readActiveClaudeCredential`) para dentro do vault —
   o equivalente Claude do `readBackFresherAuth`.
2. **Na troca de conta (`activateAccount`):** ANTES de sobrescrever o Keychain com a
   conta B, sincronizar o blob da conta que está saindo (a que bate com
   `activeClaudeEmail()`) a partir do Keychain nativo. Só então escrever a conta B.
3. Considerar NÃO injetar `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` nos panes (só o access
   token), deixando a renovação de secundárias exclusivamente com o sweeper — elimina
   o terceiro ator da corrida de rotação.

**Arquivos envolvidos:**
- `src/main/persistence/account-store.ts` (277-323, 345-376, 474-559, 818-885, 945-959)
- `src/main/adapters/claude-credential.ts` (arquivo inteiro, 77 linhas)
- `src/main/quota/claude-oauth-refresh.ts` (arquivo inteiro, 124 linhas)
- `src/main/persistence/provider-config-store.ts:423-427` (comentário do fix anterior
  incompleto — contexto histórico)

**Evidência ao vivo desta sessão**: durante esta própria investigação, o usuário
reportou nova perda de login em outra sessão do Nexus rodando em paralelo
("perdeu login no meio da sessão fazendo serviço e pediu de novo") — consistente
com o mecanismo acima, não um caso isolado.

---

## 2. [BUG REAL, causa raiz confirmada] "omp instala mas UI continua mostrando não instalado"

**Sintoma**: usuário clica "Instalar omp automaticamente", o diálogo nativo confirma
`brew install can1357/tap/omp`, a instalação roda e termina, mas o painel OMP·RPC
continua mostrando `binário "omp" não encontrado no PATH`.

**Causa raiz:**
- `resolveOmpBin()` em `src/main/adapters/omp-rpc-service.ts:199-246` faz **um único**
  `which omp` (linha ~207) contra `process.env.PATH` do processo, sem fallback.
- Todo o resto dos adapters (claude/codex/gemini/kimi/grok/opencode/agy) usa
  `isBinInstalled()` em `src/main/adapters/adapter-registry.ts:142-167`, que **tem
  fallback resiliente**: se o `which` rápido falhar, ele **re-resolve o PATH do shell de
  login ao vivo** (`resolveLoginShellPath()`) e tenta de novo com esse PATH atualizado.
- `path-resolver.ts` (`resolveUserPath()`) roda **uma vez, no bootstrap** do app, e é
  idempotente (`if (resolved) return;`, linha 75). Se o `brew install` acabou de colocar
  `omp` num diretório que não estava no PATH resolvido no boot (ex.: primeira instalação
  do Homebrew nesta máquina, ou tap novo), o `resolveOmpBin` do omp fica preso no PATH
  velho, enquanto o resto dos adapters teria pego o caminho novo pelo fallback de
  `isBinInstalled`.

**Fix recomendado (não implementado):**
Fazer `resolveOmpBin` reusar a mesma lógica de `isBinInstalled`/`resolveRunnerPath`
(re-resolver login-shell PATH ao vivo quando o `which` rápido falha), em vez de um
`which` único e sem retry.

**Arquivos envolvidos:**
- `src/main/adapters/omp-rpc-service.ts:199-246` (`resolveOmpBin`)
- `src/main/adapters/adapter-registry.ts:142-167` (`isBinInstalled`, padrão a copiar)
- `src/main/persistence/provider-config-store.ts:806-817` (`resolveRunnerPath`, outro
  padrão equivalente já usado no fluxo de instalação)
- `src/main/path-resolver.ts` (contexto: por que o PATH do boot pode ficar stale)

---

## 3. [RESOLVIDO] "Close Window" da página OAuth não fecha a aba

**Sintoma**: após login OAuth (ex.: `omp auth-broker login`), a página abre no
navegador padrão do sistema com "Authentication Successful" + botão "Close Window";
clicar não fecha a aba.

**Achado original**: a página é renderizada pelo subprocesso externo
(`omp auth-broker login`), não pelo Nexus; todo browser bloqueia `window.close()`
numa aba que não foi aberta via `window.open()` de script.

**Fix (implementado)**: o fluxo não depende mais do navegador do sistema. Ao
receber `awaiting-auth`, o main abre uma **janela in-app endurecida**
(`src/main/adapters/omp-auth-window.ts`: sessão efêmera, sandbox, sem popups,
navegação https/loopback-only) que **fecha sozinha** quando o fluxo termina
(`done` com delay de 1,5 s para a página de sucesso ser perceptível; `error`/
cancel imediato). O botão do painel virou "Reabrir janela de autorização"
(com fallback para o navegador do sistema se a janela falhar). Testes:
`omp-auth-window.test.ts` + `omp-auth-ipc.test.ts`.

---

## 4. [NÃO É BUG] Aba "Skills" mostrando "Nenhuma skill nos caminhos do catálogo"

**Achado**: `skillsDirs()` em `src/main/product-wave-ipc.ts:121-127` é **propositalmente
escopado por projeto** — só olha `<projeto>/.claude/skills` e `<projeto>/.nexus/skills`,
nunca `$HOME` (comentário no código: *"never $HOME (cross-project leak)"*). O projeto
`nexus-ide` aberto não tem nenhuma dessas duas pastas, então o painel está correto ao
mostrar vazio. Ele não lista as skills globais de `~/.claude/skills` por design de
isolamento entre projetos — não é regressão. Se o time quiser skills globais visíveis
aqui, é uma mudança de produto deliberada, não um bug a corrigir.

Não achei o mesmo padrão de vazio indevido nas outras abas do drawer lateral (Browser,
Editor, Git, Memória, Missão, Handoff, Busca) dentro do tempo desta consulta.

---

## 5. [BUG REAL, confirmado em CSS] Badge do sino de notificações cortando o ícone

**Sintoma**: contador de notificações (ex.: "3") aparece sobrepondo/cortando o ícone
do sino em vez de ficar num cantinho pequeno.

**Causa raiz**: `.agent-notif__bell` (`src/renderer/styles/base.css:1871-1897`) é um
botão de só `28×26px`; `.agent-notif__count` (linha 1899) usa
`top:-5px; right:-4px` com `min-width:14px; height:14px` — não há espaço suficiente
pra esse badge ficar fora da área do ícone num botão tão pequeno, então ele cobre parte
do sino.

**Fix recomendado (não implementado)**: ajustar `top`/`right` para valores mais
negativos (ex.: `top:-7px; right:-6px`) ou aumentar levemente o `padding`/`width` do
botão `.agent-notif__bell` para dar folga ao badge.

**Arquivo**: `src/renderer/styles/base.css:1871-1914`.

---

## 6. [NÃO CONFIRMADO — precisa de repro ao vivo] Botões cortando na toolbar do pane

**Sintoma (2 prints do usuário)**: ícones/botões da toolbar do pane (`#id`, badge de
custo, chip de estado) parecem cortados/sobrepostos em largura estreita.

**Investigação parcial**: `PaneToolbar.tsx` já tem lógica de densidade responsiva
(`full` / `icons` / `compact`, via `ResizeObserver`, linhas 162-175) que deveria
esconder progressivamente `scroll-end`, `hibernate`, `restart` no menu "⋯" antes de
cortar algo. Não consegui isolar, só por leitura estática, qual badge exatamente
("#6-dígitos" do pane-id, `toolbar__state`, ou `CostBadge`) está sendo cortado nos
prints — precisa inspecionar o DOM ao vivo (largura real do pane no momento do print)
para apontar a causa exata antes de propor fix. **Não tratar como resolvido.**

**Arquivo de partida**: `src/renderer/components/PaneToolbar.tsx` (toda a lógica de
`density`/`overflow`, linhas 162-330).

---

## 7. Confirmado: painel de contas/cotas mostra a conta certa (não é bug)

Investigado a partir do print "confere se a conta certa aparece" — só existe 1 conta
Claude com o e-mail `admin@volarehost.com.br` cadastrada no vault no momento da
checagem (mais tarde uma segunda, `retorno`/`retornoja@gmail.com`, foi adicionada).
O cooldown de "15min"/"10min" batia exatamente com `cooldown_until` gravado no SQLite
(`nexus.db`, tabela `accounts`) — é uma leitura real de esgotamento de cota, não erro de
UI. A única melhoria de UX legítima aqui: o painel de "Uso e cotas"
(`UsageQuotaSection.tsx`) não mostra o e-mail da conta, só o label ("Conta Claude"),
diferente do `AccountSwitcher.tsx` que mostra o e-mail como subtítulo — inconsistência
pequena, vale igualar exibindo o e-mail também nessa lista.

**Arquivo**: `src/renderer/components/settings/UsageQuotaSection.tsx:13-31`
(`EntryCard`) vs. `src/renderer/components/AccountSwitcher.tsx` (referência de como
mostrar o e-mail).

---

## Resumo de prioridade sugerida para quem for codar

| # | Item | Severidade | Esforço estimado |
|---|------|-----------|-------------------|
| 1 | Perda de login com 2 contas (refresh token stale) | **Alta** — reincidente, quebra fluxo de trabalho | Médio (sincronizar vault no momento da troca de conta nativa) |
| 2 | `omp` instala mas mostra "não instalado" | Média | Baixo (reusar `isBinInstalled`) |
| 5 | Badge do sino cortando ícone | Baixa (cosmético) | Trivial (CSS) |
| 7 | E-mail ausente no painel de cotas | Baixa (cosmético/UX) | Trivial |
| 6 | Toolbar do pane cortando botões | Desconhecida — precisa repro | Investigar antes de estimar |
| 3, 4 | Não são bugs | — | — |

---

## STATUS DA EXECUÇÃO (18/07/2026, sessão de recuperação da missão 721ddcc2)

| # | Item | Status | Onde |
|---|------|--------|------|
| 1 | Perda de login 2 contas | ✅ CORRIGIDO | commit `fb41d33` — `syncClaudeBlobFromKeychainIfNative` (read-back Keychain→vault antes de qualquer uso), `activateAccount` sincroniza a conta que sai antes de sobrescrever, conta nativa pinada spawna sem token env |
| 2 | omp "não instalado" | ✅ CORRIGIDO | commit `fb41d33` — `resolveOmpBin` re-resolve login-shell PATH ao vivo (mesmo fallback de `isBinInstalled`) |
| 5 | Badge do sino | ✅ CORRIGIDO | commit `fb41d33` — `top:0; right:-5px` (top negativo era recortado pelo overflow da zona de status) |
| 7 | E-mail no painel de cotas | ✅ CORRIGIDO | commit `fb41d33` — `EntryCard` recebe e exibe `email` |
| 6 | Toolbar cortando botões | ✅ CORRIGIDO | Repro em harness Playwright (CSS real + DOM real, 12 larguras 300-760px): `.toolbar__meta` (flex-grow) esmagava `.toolbar__actions` e o `overflow:hidden` cortava botões AO MEIO em todas as densidades ("Reiniciar" vazando 44px em 520px); chips rígidos (state/custo/devserver) cortados pela metade em 460-700px, faixa onde nenhuma container query acertava. Fix: actions vira `flex:0 0 auto` (density JS já poda conteúdo), meta ganha wrap+linha única clipada (`row-gap:160px; max-height:26px` — chip que não cabe some INTEIRO), threshold de `icons` sobe 520→580. Pós-fix: 12/12 larguras sem corte parcial. |

**Extras encontrados e corrigidos no decorrer (commit `c722766`):**
- Enter não enviado no boot do pane: `injectPrompt` agora re-envia CR uma vez se a
  sessão continuar idle 400ms após o primeiro submit (CLI come o 1º CR após menus
  de boot — mesmo padrão do idle-delivery).
- Roteamento ignorava o squad da missão (todo worker caía em
  `settings.defaultAdapterId`, "codex forçado"): o scheduler agora roteia dentro
  dos CLIs do squad quando ao menos um está instalado e prefere o modelo
  configurado pelo autor do squad.
- Gate da plan lane: comparação morta removida (typecheck limpo).
- `onBgTaskEvent` adicionado ao contrato `NexusApi` (typecheck do preload/renderer).

Validação: `tsc --noEmit` limpo; 106 testes das áreas tocadas verdes
(scheduler, gate, router, tool-util).
