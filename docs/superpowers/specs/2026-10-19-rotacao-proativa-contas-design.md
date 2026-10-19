# Rotação proativa de contas por folga medida

**Data:** 19/10/2026
**Origem:** relato de cliente — 7 contas AGY, a cota da primeira acaba e a missão para.
**Estado:** desenho revisado (passou por revisão independente), aguardando o operador.

---

## 1. Intenção e o porquê

Um cliente roda 7 contas AGY (Antigravity/Gemini). Somadas, deveriam dar cerca
de 7× de autonomia. Na prática dão 1×: quando a cota da primeira acaba, o pane
**para** — não troca, não avisa, não morre com erro. Fica parado.

Nas palavras do operador:

> "ao trocar de conta o trabalho continue de onde ele está, nada deve mudar,
> talvez um feedback visual de momento ali, só isto. O importante é a missão
> só parar quando terminar."

> "acaba uma, usa a outra, e assim sucessivamente — acaba o limite de uma, usa
> a próxima, e sempre consultar e rotear para as que têm mais limites
> disponíveis."

---

## 2. Estado atual (medido no código)

### 2.1 Toda troca de conta é reativa
As quatro chamadas de `performSwitch` em `src/main/orch/failover.ts` (2340,
2585, 3781, 4018) nascem de um `LimitHit`: texto no PTY, erro de auth, ou
confirmação da API. **Nada olha a cota medida e age.**

### 2.2 A cota é lida, mas não é consumida para decidir
`startMissionQuotaPoll` (F-1483) relê a frota a cada 5 min com missão viva. O
snapshot só alimenta comparações *depois* que o limite bate.

### 2.3 O corte é 100%, não 98%
`chooseAccount` (`src/main/persistence/account-select.ts:88`) só move o pane
quando `isHeadroomExhausted` → `available <= 1e-6`
(`src/main/quota/account-headroom.ts:112`). "Quase no fim" não existe.

### 2.4 Para AGY não há sequer detecção reativa
`src/shared/limit-signal-patterns.ts` não tem **nenhuma** entrada AGY/Gemini.
Os genéricos exigem moldura de erro HTTP. CLI que emudece não gera `LimitHit`.
**Esta é a causa direta do "só para".**

### 2.5 O BLOQUEIO CENTRAL: a cota do AGY só é medível na conta ativa

> Correção de uma versão anterior deste documento, que afirmava o contrário.
> O erro foi achado na revisão independente e confirmado no código.

`agy-bridge.ts:5-8`:
> *"O Google recusa a sonda direta: `retrieveUserQuota*` no cloudcode-pa
> responde 403 'no valid license' para conta pessoal, porque a API julga QUEM
> pede — e o Nexus não pode assinar como Antigravity."*

As duas sondas que **funcionam** estão atrás de `if (!accountId)` em
`src/main/quota/provider-live-usage.ts:492-504`:
- `fetchAgyBridgeUsage` — pergunta ao language server local;
- `fetchAgyCliUsageWindows` — `agy --print /quota`.

Ambas medem **a identidade que o processo está usando**, com o comentário
explícito: *"a leitura é da conta que o processo está logado, não atribuível a
uma conta vault."* Com `accountId` sobra só o endpoint direto, que toma 403.

`resolveGeminiOauthCreds(accountId)` lê o **blob** de cada conta — isso
funciona. Virar **número de cota** é que não.

**Consequência:** para contas AGY pessoais, "consultar as 7 e rotear para a de
maior folga" **não é construível hoje** sem medição nova. Isto reescreve o §7.

### 2.6 Outros dois bloqueios físicos
1. **Proxy transparente por requisição está fora.** `agy-windows-keyring.ts:8`:
   *"o cliente OAuth do Antigravity não tem segredo utilizável fora da CLI"*.
2. **Conversa nativa não atravessa contas.** `failover-continuity.ts:3`:
   *"cross-account resume cannot reuse provider session ids (account-owned)"*.
   `src/shared/cross-account-resume.ts` só libera `claude`. Para AGY, troca de
   conta num pane vivo é sempre sessão nova com contexto reidratado.

   **Contrato honesto:** "nada muda" literal é impossível no pane já rodando. O
   alcançável é *"a missão não para"*. Na borda de tarefa (camada 1) a troca é
   de fato invisível.

### 2.7 Riscos descartados na investigação
- **Slot do keyring não sequestra pane vivo.** `agy-keyring-activation.ts:15`
  (F-677): *"cada processo AGY lê a vaga ao iniciar; panes já abertos seguem
  com a conta com que nasceram."*

### 2.8 O que já existe e serve de fundação
| Peça | Onde |
|---|---|
| `compareAccountHeadroom`, `bindingHeadroomWindow` | `src/main/quota/account-headroom.ts` |
| `switchRendererOrchestratorAccount` | `src/main/orch/failover-orchestrator-respawn.ts:119` |
| `buildContinuityPack` (F-999) | `src/shared/failover-handoff.ts` |
| `fullWindowsReopenAt` (quando a janela reabre) | `account-headroom.ts` |
| `QUOTA_HIGH_USAGE_THRESHOLD` (0.8) | `src/main/orch/limit-refutation.ts` |

---

## 3. Objetivos
1. Conta que cruza o limiar para de receber trabalho novo; o próximo worker
   nasce na próxima conta da fila.
2. Pane longo que esgota no meio continua: troca a quente com pacote de
   continuidade e aviso visual.
3. Genérico: vale para qualquer CLI multi-conta. Onde a medição por conta
   existe (Claude, Codex, Grok), a escolha usa folga medida; onde não existe
   (AGY pessoal), usa a fila.
4. AGY ganha detecção de limite, inclusive quando emudece.
5. A missão só para quando terminar, ou quando todas as contas esgotarem.

## 4. Não-objetivos
- Proxy HTTP transparente (§2.6.1). Conversa nativa entre contas (§2.6.2).
- Pool de concorrência: o operador pediu série.
- ~~Trocar de CLI por limite~~ — **deixou de ser não-objetivo em 19/10.** É o
  estado terminal da cadeia e **já está construído** (F-775 item 2, ver §7.4).
- Mexer no `license_agent_limit`.

## 5. Anti-objetivos
1. **Trocar por engano** (doutrina F-249). Decisão só por leitura medida e
   fresca, nunca por texto de terminal.
2. **Queimar a última fatia.** Limiar cedo demais = pagar 7 contas e usar 7×95%.
3. **Cascata.** Uma leitura ruim que drena as 7 em sequência.
4. **Mentir no recibo.** `switched: true` só depois do religamento real (F-995).
5. **Interromper quem está no meio de algo** quando dava para esperar a borda.
6. **Inventar trabalho.** Injetar pacote de continuidade em pane que já
   terminou.

---

## 6. Restrições
- `account-select.ts` e `account-headroom.ts` são puros. A camada que lê estado
  vive acima, como `currentParallelHelperBudget` já faz.
- Windows: trocas entre contas diferentes serializam com
  `AGY_KEYRING_SETTLE_MS` (6 s).
- `switchRendererOrchestratorAccount` é do Main.
- Nada de token/fingerprint/e-mail em recibo, trace ou log. `maskAccountLabel`.
- Toda decisão sai no trace `account-failover`, com motivo.
- `quota-service` só tem `refresh()`/`snapshot()` **da frota**, TTL 60 s por
  linha, `QUOTA_PROBE_CONCURRENCY` = 6, e várias sondas abrem um processo de
  CLI por conta.

---

## 7. Desenho

### 7.0 Estratégia de medição (consequência do §2.5)

A seleção passa a ter **dois modos**, escolhidos por capacidade do adapter:

**Modo A — folga medida** (Claude, Codex, Grok: a cota por conta é legível).
A conta é escolhida por `compareAccountHeadroom`, como o desenho original.

**Modo B — fila ordenada** (AGY pessoal: só a conta ativa é medível).
A conta ATIVA é medida de verdade (bridge / `agy --print /quota`) — é ela que
dispara a drenagem. A PRÓXIMA sai de uma ordem, não de uma comparação: a
primeira da fila que não está em cooldown nem com janela cheia conhecida.

**Por que isso basta:** numa drenagem em série, "a de maior folga" é
trivialmente "a que ainda não foi usada". Comparar irmãs só importa num modelo
de equilíbrio, que não é o que o operador pediu. O modo B entrega o objetivo 1
sem construir medição nova — e é, não por acaso, o que o 9router faz.

O modo é derivado da capacidade do adapter, nunca configurado à mão.

**Confirmado pelo operador em 19/10:** as 7 contas do cliente são pessoais /
gratuitas do Antigravity. **O AGY roda no modo B.**

### 7.0.1 Escopo: construímos o roteador, não a política de contas

Decisão do operador (19/10): *"o que temos que criar é o roteador; quais contas
o cliente usa é responsabilidade dele, não nossa."*

Consequências, que valem como regra de projeto:
- A **ordem da fila** é a ordem de cadastro do cliente. Não inventamos política
  de prioridade (resolve a antiga pergunta 5).
- O roteador tem de estar correto **seja qual for a mistura de contas e
  modelos** do cliente. Nada no desenho pode depender de saber que ele só usa
  Gemini, ou que tem exatamente 7 contas.
- Isto **reverte** a recomendação da §10.1 da versão anterior (ver §10.1).

### 7.1 Camada 1 — Drenagem na borda de tarefa *(a principal, a invisível)*
Conta **em drenagem** = folga medida abaixo do limiar, ainda não zero.
- `chooseAccount` distingue *drenando* de *esgotada*. Drenando perde para
  qualquer candidata acima do limiar. Todas drenando → a de maior folga (modo
  A) ou a primeira da fila (modo B).
- Panes vivos na conta drenando **não são tocados** — terminam a unidade atual
  usando a fatia que resta (anti-objetivo 5.2 e 5.5).
- Vale para os caminhos de spawn que passam por `pickAvailableForFailover`.

### 7.2 Camada 2 — Troca a quente *(a rede de segurança)*
Vigia no `delegation-supervisor`: conta que **esgota** com pane vivo **e
trabalho pendente** dispara `switchRendererOrchestratorAccount` →
`rebindPaneAccount` + `requestMissionPaneRecovery`. Mesmo pane, sessão nova,
pacote de continuidade, toast.

### 7.3 Camada 3 — AGY enxerga o próprio limite
1. Padrões de texto AGY/Gemini em `limit-signal-patterns.ts`, com a string
   exata medida da CLI real (§9.1 — pendente).
2. **O caso do silêncio** (o relatado): pane AGY ocioso **com trabalho
   pendente** cuja medição da conta ativa mostra esgotada. A prova é a medição,
   não o terminal — não viola o F-249.

### 7.4 Estado terminal: todas as contas esgotadas → outra CLI *(já existe)*

Decisão do operador (19/10): *"aí muda para outra LLM."*

**Isto já está construído.** `src/main/orch/failover-cli-switch.test.ts:1`
descreve o F-775 item 2:

> *"quando TODAS as contas da CLI esgotam, o trabalho continua em OUTRA CLI
> elegível, sozinho — no pane do operador ('+ Pane') no lugar, com aviso; na
> tarefa de missão por um pane novo na rota do spawn. A CLI vem do roteador, a
> esgotada não volta antes de liberar e cada tarefa troca no máximo 3 vezes."*

E `performSwitch` já encadeia: escolhe a irmã (`pickAvailableForFailover` com
`rejectExhausted: true`, linha 1809), tenta alternativas quando o prepare falha
(linha 1880), e quando `next` fica `null` cai no caminho de troca de CLI
(`cliSwitchPack`, linha 955; `cli-switch-requested`, linha 1074).

**Não há nada a construir aqui.** O AGY simplesmente nunca chega a este estado
hoje, porque nada mede a cota dele nem declara esgotamento (§2.4, §2.5). As
camadas 1 a 3 existem para que a cadeia *alcance* o terminal que já existe.

Isto elimina o agendador de despertar, a revivência de pane e a semântica de
missão nova que a versão anterior estimava em dias de trabalho.

---

## 8. Decisões que eu tomei (chamadas do autor, não do operador)

Levantadas na revisão independente e resolvidas aqui para não travar o
operador. Qualquer uma pode ser revertida por ele.

1. **Série com stickiness, não equilíbrio.** "Acaba uma, usa a outra, e assim
   sucessivamente" é drenar em série. A conta que assume vira a nova ativa, para
   que spawns consecutivos não façam ping-pong entre irmãs (e, no Windows, não
   paguem 6 s de settle por spawn). **Nota de código:** `activeByAdapter` hoje
   só é escrito por `addAccount`, `addSubscriptionAccount`, refresh de
   assinatura e ativação pelo operador (`account-store.ts:1448, 1708, 1741,
   2374`); `performSwitch` não o toca. A rotação passa a escrevê-lo — são 6
   consumidores a revisar, mais o significado da coluna "ativa" na UI.
2. **Drenar exige `source: 'provider-api'` e leitura fresca.** Exigido pelo
   anti-objetivo 5.1. **Custo:** `HeadroomInput.windows` é hoje
   `Pick<QuotaWindow, 'label'|'usedRatio'>` e **descarta `source`**, embora
   `QuotaWindow.source` exista (`quota-types.ts:44`); e `updatedAt` existe no
   `HeadroomInput` mas nenhuma função pura o lê. Levar `source` e idade para
   dentro do núcleo puro é parte do trabalho. Simétrico e obrigatório: leitura
   velha de uma irmã **não** conta como folga para tirar o pane da ativa
   (anti-objetivo 5.3).
3. **A camada 2 exige prova de trabalho pendente.** Pane ocioso porque
   *terminou* nunca recebe pacote de continuidade (anti-objetivo 5.6). Sem
   isso, a camada 3.2 inventaria trabalho em pane concluído.
4. **O teto de trocas conta só a camada 2.** A drenagem da camada 1 é barata e
   sem perda; limitá-la quebraria o objetivo 5 (7 contas = 7 drenagens). Teto
   por pane, não por missão.
5. **Limiar: 89%** (escolha do operador, 19/10), constante com override por env
   na v1, sem tela em Ajustes.
   **Por que 89% não desperdiça 11% × 7 contas:** a drenagem é *preferência,
   não banimento*. Enquanto houver irmã acima do limiar, o trabalho novo vai
   para ela; quando TODAS estiverem drenando, a regra volta a escolher entre
   elas (a primeira da fila, no modo B) e o resto da janela é consumido numa
   segunda volta do carrossel. O custo de 89% não é cota perdida — são mais
   trocas, e cada troca na borda de tarefa é invisível e de graça. Em troca, a
   camada 1 quase sempre ganha da camada 2, que é o que o operador pediu.
5b. **Constante com override por env na v1.** Sem tela em Ajustes.
   Preferência de verdade (schema + IPC + UI + recibo dizendo de onde veio o
   valor) fica para depois de medir que o valor padrão serve.
6. **Sonda direcionada por conta/adapter** em vez de acelerar o `refresh()` da
   frota. Fleet refresh a cada 1 min com 7 contas AGY abriria processos de CLI
   demais — o comentário de `QUOTA_PROBE_CONCURRENCY`
   (`quota-service.ts:79-86`) registra que isso travava máquina com 20–100
   contas. No modo B só a conta ativa precisa de cadência rápida, o que torna a
   sonda direcionada barata.

7. **A drenagem é dimensionada pela rota, com recuo conservador.** O AGY
   devolve bucket por grupo de modelo — `agy-bridge.ts:265` registra
   "Gemini × (5h|semanal), Claude/GPT × (5h|semanal)" — e `headroomReadings`
   colapsa por `kind` ficando com o mais apertado. Sem correção, um bucket de
   terceiros cheio drenaria uma conta que serve perfeitamente um pane Gemini.
   Pela §7.0.1 não podemos assumir a mistura do cliente, então a decisão de
   drenagem considera os buckets que o modelo do pane consome; **sem
   mapeamento modelo→bucket confiável, cai no pior bucket** (comportamento de
   hoje, conservador: no máximo drena cedo, nunca tarde). Precedente de
   dimensão: o `scope` dos cooldowns (`tier:opus`) em `isAccountBlockedForScope`.
   Isto é um filtro opcional na entrada das funções puras, não um eixo novo em
   todos os chamadores.
8. **Sem reserva de conta para o Maestro na v1.** O risco levantado na revisão é
   real (os workers levam a mais livre, então o Maestro tende a ficar sem cota
   primeiro, e é o pane mais caro de trocar), mas é otimização especulativa
   antes de haver medição. O roteador trata todo pane igual. Revisitar se o
   campo mostrar o Maestro sendo trocado com frequência.
9. **Conta fixada continua cedendo só ao esgotamento, não à drenagem.** Um pin é
   uma escolha explícita do operador; drenagem é inferência. O comportamento de
   hoje (`provider-config-store.ts:1713`, F-995: só limite CONFIRMADO move um
   pin) fica como está. O Maestro
   (`pickMissionOrchestratorAccountId`, linha 1810) **passa** a respeitar a
   drenagem no respawn, porque ali já não há conversa a preservar.

### 8.1 Deixado a quem implementar
- Onde mora o estado "drenando" (derivado do snapshot ou materializado), desde
  que o núcleo puro continue puro.
- Texto e forma do toast (seguir a copy de failover + `maskAccountLabel`).
- Vigia próprio ou dentro do `delegation-supervisor` (o laço de 15 s serve).
- Desempate entre contas empatadas: manter `createdAt`.

---

## 9. Riscos e medições pendentes
1. **A string de limite do AGY é desconhecida.** Ninguém colheu a tela de um
   AGY esgotado. A camada 3.1 **não deve ser escrita de suposição**. A camada
   3.2 não depende dela e cobre o caso relatado sozinha.
2. **Verificar na máquina do cliente se as contas são pessoais ou licenciadas**
   (§10 q1). Define o modo (§7.0).
3. **Dois watchdogs já olham o mesmo pane:** F-242 (worker `working` parado 20
   min) e F-723 (`pane-start-watchdog`). A camada 2 precisa conviver com eles
   sem disparar em cima.

---

## 9.5 Arte prévia: o que os outros fazem (pesquisado em 19/10)

O operador pediu para checar 9router, Orca e T3 Code. **Nenhum dos três
resolve este problema.**

**9router (`decolua/9router`)** — gateway HTTP. "Auto round-robin or
priority-based routing" e "fallback to next account when one hits quota":
reativo, sem limiar proativo. **Não porta:** é proxy, troca a chave entre
requisições; não há sessão de CLI para preservar. **O que vale roubar:** a
ordem de prioridade explícita — que é exatamente o modo B do §7.0.

**Orca (`stablyai/orca`)** — tem multi-conta real (`src/main/claude-accounts/`,
`AccountsPane.tsx`) e medidores por provider (`src/main/rate-limits/`). **Mas a
troca é 100% manual:** `runtime-selection.ts` é encanamento de settings
(`activeClaudeManagedAccountId`); busca por
`auto.?switch|onRateLimit|whenExhausted|usedRatio|headroom` nos diretórios de
conta volta zero. A copy admite: *"quick switching **without moving chat
sessions**"*. Tem os medidores, não tem o gatilho.

**T3 Code (`pingdotgg/t3code`)** — tem `AntigravityProvider.ts`,
`antigravityUsageLimits.ts`, `ProviderUsageLimitsIngestion.ts`,
`ProviderInstanceRegistry.ts`. **Mas não rotaciona:** busca por `usedRatio`,
`switchAccount`, `accountRotation`, `fallbackAccount` → zero; `rotate|rotation|
"next account"|"account pool"` em `apps/server/src/provider` → zero. (O índice
funciona: `AntigravityProvider` devolve 5 arquivos.)

**Conclusão:** o Nexus já tem o melhor motor de decisão dos quatro
(`compareAccountHeadroom`, com as lições do F-995). Não há o que herdar no
cérebro; o que falta é o gatilho — e, para AGY, a medição (§2.5).

---

## 10. Perguntas — todas respondidas (19/10)

| # | Pergunta | Resposta |
|---|---|---|
| 1 | Contas pessoais ou licenciadas? | **Pessoais/gratuitas** → modo B, fila ordenada (§7.0) |
| 2 | Limiar | **89%** (§8.5) |
| 3 | Todas esgotadas: para ou espera? | **Muda para outra LLM** — já construído (§7.4) |
| 4 | Pin e Maestro cedem à drenagem? | Decisão delegada ao autor → §8.9 |
| 5 | Ordem das contas | Decisão delegada ao autor → ordem de cadastro (§7.0.1) |
| 10.1 | Dimensão por modelo | Resolvida → §8.7, recomendação invertida |

### 10.1 Dimensão por modelo — resolvida, com a recomendação invertida

A versão anterior recomendava ficar sem dimensão de rota, assumindo que o
cliente só usa modelos Gemini pelo AGY. **A decisão de escopo do §7.0.1
derruba essa premissa:** não é da nossa conta qual modelo ele usa, e o
roteador tem de estar certo de qualquer jeito.

Resolvido na decisão 8.7: drenagem dimensionada pelos buckets que o modelo do
pane consome, com recuo para o pior bucket quando o mapeamento não for
confiável.

---

## 11. Resumo do que se constrói

1. **Camada 1 — drenagem a 89%** na borda de tarefa, modo A ou B por capacidade
   do adapter (§7.0, §7.1). *O grosso do valor.*
2. **Camada 2 — troca a quente** com prova de trabalho pendente (§7.2).
3. **Camada 3 — AGY enxerga o limite**: o caso do silêncio (3.2) agora; o padrão
   de texto (3.1) quando alguém colher a string real.
4. **`source` + idade dentro do núcleo puro** (§8.2) — pré-requisito de 1 e 2.
5. **Sonda direcionada por conta/adapter** (§8.6) — barata no modo B.
6. **Drenagem dimensionada por rota** com recuo conservador (§8.7).

**Não se constrói:** troca de CLI no esgotamento total (§7.4, já existe),
agendador de despertar, proxy, resume nativo entre contas.
