# Por que a missão demorava 2–3× um pane só (21/10/2026)

Relato do operador: uma landing page feita num **pane único** sai em ~1 h; a
mesma coisa **como missão** leva 2–3 h. Na tela ele vê o Nexus "fazendo
testes, voltando, fazendo testes, voltando", recusando e **recomeçando tudo
do zero**, e reclamando que **não fez o teste visual** — tendo navegador e Jev
dentro do Nexus.

O que segue é o que o código diz, com arquivo e linha. Separei o que é
**medido** do que é **estimado** e do que ficou **não verificado**.

## As seis causas, em ordem de custo

### 1. A suíte inteira reexecutada sobre código idêntico (MEDIDO)

`mission-code-completion-production.ts` guardava o resultado das verificações
mecânicas com TTL de 5 min, e `pruneStates` o descartava **mesmo com o
candidato inalterado**. A chave do cache (`checkKey`) já fixa o candidato
exato: assinatura da missão, escopos, base, cobertura, `fingerprint`,
`headSha` e caminhos exigidos. Qualquer byte que mude troca a chave.

Enquanto isso, o juiz independente é um pane frontier com duas idas ao modelo
e poll de 30 s (`mission-code-review-runtime.ts`): em campo passa dos 5 min.
Toda tentativa seguinte refazia:

| verificação | custo MEDIDO aqui (21/10) | teto no código |
|---|---|---|
| typecheck do projeto inteiro | **4,4 s** | 120 s (`mechanical-sensors.ts:29`) |
| `npm audit` | **0,75 s** | 45 s (`mechanical-sensors.ts:30`) |
| portão de regressão **com E2E** | depende do projeto; a fatia orch+shared desta suíte leva **208 s** | 120 s por execução (`regression-gate.ts:2020`) |

**Atenção aos números:** 120 s e 45 s são TIMEOUT, não custo — medi os dois
nesta máquina e eles são ordens de magnitude menores. O termo dominante é a
SUÍTE, não o typecheck. No caminho da conclusão typecheck e audit ainda são
serializados (`civilian-auto-review.ts:422`), mas o que pesa é a suíte com E2E
sendo refeita inteira. Isto é o "faz teste, volta, faz teste" que o operador
vê: não é teimosia do modelo, é o motor jogando trabalho válido fora.

**Corrigido:** o resultado é preservado enquanto um juiz comprovadamente lê
aquele mesmo `fingerprint`, com teto de 45 min para um candidato abandonado
ainda envelhecer. A invariante antiga continua — acerto de cache nunca renova
o prazo.

### 2. O trabalho recomeçava do zero a cada devolução (MEDIDO)

`shouldArmAutoCloseOnHandoff` arma **todo** worker de missão, e o `success`
fechava o pane "logo" (`tools-handoff.ts`), antes de o Maestro ler a entrega.
Quando o veredito vinha e era `rework`, não havia mais pane: a nota caía numa
encarnação nova e, sem conversa retomável, num pane novo com o **brief
original** (`resume.mode: 'fresh-in-worktree'`). O worker refazia o que já
tinha feito.

Pior: a evidência visual é chaveada por `session_id` +
`worker_incarnation_id` + `assignment_id` (`visual-handoff-gate.ts`). Encarnação
nova ⇒ a captura anterior **não vale mais** ⇒ o teste visual era refeito a
cada rodada. É o "monte de teste visual inútil".

**Corrigido:** o `success` do writer de missão espera o aceite. `accepted`
fecha na hora; `rework` encontra o pane morno, que já sabe o que tentou — e
a captura dele continua válida. Prazo da rede de segurança: 3 min (um pane
custa ~1 GB, F-572).

### 3. A mesma entrega visual era cobrada duas vezes (MEDIDO)

O portão visual exige uma captura do navegador do Nexus e, sem ela, rebaixa
`success` para `partial`. Logo **antes** dele, a revisão Jev pedia "test
results, typecheck/build output, command output or a commit reference" — com
saída para revisão, auditoria e planejamento, **nenhuma para trabalho
visual** (`jev-handoff-review.ts:80-94`) — e devolvia o handoff por "sem
evidência de verificação". Numa landing page não existe teste de unidade que
prove aparência: as duas cobranças não podiam ser satisfeitas juntas.

**Corrigido:** o portão visual roda antes da revisão e a captura verificada
pelo Main conta como evidência. A rubrica passa a nomear a captura observada
como prova válida de entrega visual.

### 4. A doutrina só ensinava a devolver, e a prova não cabia na aparência (MEDIDO)

Nas três portas (kickoff, instruções permanentes, lembrete de turno) a prova
exigida era literalmente "rode o teste que prova a correção", e o único gesto
de ACK ensinado era `verdict:"rework"`. **O aceite nunca era ensinado.** Então
o laço tinha uma saída só, e ela custa outra rodada inteira do worker.

**Corrigido:** o Maestro continua RODANDO o teste que prova a correção — isso
é regra do operador de 02/10 ("verifica, não confia") e a primeira versão deste
fix a tinha enfraquecido para "exija a prova que cabe", o que permitiria aceitar
a palavra do worker sem ninguém executar nada (apontado na revisão do PR 159).
O que mudou é só a exceção de APARÊNCIA, onde esse teste não existe: ali a prova
é a captura do navegador. E as três portas passam a mandar aceitar com
`nexus_handoff_ack accepted`, devolvendo só com defeito concreto.

### 5. Um turno de abertura desperdiçado (MEDIDO)

O kickoff passava `firstWaveDispatched: true` fixo
(`mission-fast-lane.ts:1030`), mas `planFirstWaveSeats` só abre panes com
história selada não-meta. Um objetivo de uma linha não gera nenhuma. O Maestro
recebia como passo 1 "não duplique a first-wave: colete seus handoffs" e
gastava o turno de abertura num `nexus_handoff_list` vazio.

**Corrigido:** o kickoff diz a verdade; sem plano selado, manda delegar.

### 6. A cerimônia não enxerga o tipo de trabalho (MEDIDO, NÃO corrigido)

Há **um** eixo de escala na cerimônia inteira, e ele é de lane:
`mission-code-completion.ts:145` — `lane !== 'standard'` pula tudo. Landing
page, ajuste de CSS e refatoração de pagamentos são todos `standard` e pagam
cerimônia **byte a byte idêntica**.

O classificador existe e é de produção — `classifyWorkKind`
(`src/shared/mission-work-kind.ts:54`: `bug|feature|doc|visual|ops|unknown`) —
e está **desligado de todos os portões**. Seus consumidores são roteamento,
design e o portão visual; nenhum portão de conclusão o importa. O cabeçalho
dele já diz o problema em voz alta.

Pior, no caminho do "+ Pane" (o caso dominante) não há triagem nenhuma:
`operator-hand-mission.ts` sempre compila `standard`, sem `routingAdvice`
(`renderer-mission-authority.ts:980`).

E `mechanicalProjectRequirements` (`mechanical-sensors.ts:97-131`) decide por
**presença de arquivo no projeto**, não pelo diff: um `tsconfig.json` na raiz
exige typecheck, um lockfile exige audit, um `vitest.config.ts` exige testes —
independente do que mudou. O argumento `files` só aparece em posição `||`:
pode **somar** exigência, nunca tirar. Não há caminho subtrativo.

**Por que não corrigi agora:** é mudança de semântica num portão de
qualidade, e o operador quer "um serviço bem feito". Depois da causa 1, o
custo repetido já não se paga a cada tentativa, então a urgência caiu. A
recomendação está na seção final.

## O que a revisão do PR impediu

Sete achados da revisão automática viraram correção ou recusa fundamentada.
Dois merecem registro porque eram eu enfraquecendo regra documentada do
operador para resolver o caso visual:

- **"O Maestro RODA o teste"** (regra de 02/10) tinha virado "exija a prova que
  cabe". Isto é doutrina, não portão mecânico: sem rede embaixo, permitiria
  integrar mudança de comportamento com a palavra do worker. Restaurado, com a
  exceção de aparência preservada.
- **O texto da rubrica `has_verification` do Jev** não pode mudar sem reavaliar
  nas 105 entregas do HiperGO, e esse corpus não está no repositório. Revertido:
  o fix visual é um FATO determinístico (`facts.hasVisualEvidence`), que não
  depende de probabilidade nenhuma.

Também apareceram dois defeitos meus de leitura — `verified: true` numa tarefa
não visual não é captura observada, e `readOnly` não é "não escreve"
(`isolatedWriter` vence o rótulo, F-1318) — e um de alcance: ao levar o
`success` para o caminho de espera, tornei comum um defeito latente do ramo de
`rework`, que limpava a rede de segurança da sessão sem conferir o handoff.

## Correção que NÃO fiz, e por quê

- **Portão de regressão no fim de cada turno do Maestro.** Dois
  levantamentos independentes apontaram até 60 s por turno
  (`hook-regression-endpoint.ts:40`), porque o Maestro adotado do "+ Pane"
  casa em `isOperatorHandContext`. Mas existe teste explícito fixando esse
  comportamento ("operador promovido a orquestrador … continua com o portão
  no Stop") e o motor já tem atribuição por delta próprio (F-1224/F-1237).
  **60 s é teto, não custo medido.** Sem traço de missão real, mexer ali seria
  chute contra uma invariante testada.
- **`[NEXUS_COMPLETION_REFUSED]` abrindo fan-out a cada recusa.** Verifiquei:
  `civilian-delivery-completion.ts` filtra `kind === 'waiting'` antes de
  chegar lá. Só bloqueio real vira prompt. Não é defeito.

## Medições de apoio

- Prompt do worker para "landing page do Navalha Go" (116 caracteres de
  tarefa): **12 829 caracteres** entregues — 110× de sobrecarga. Cartas:
  engenharia 3 552, ponytail 2 501, mais design, verificação visual,
  autonomia e telemetria.
- Doutrina base: 2 036/2 048 bytes. Doutrina permanente: 1 497/1 500
  caracteres. Os dois tetos são testados; o espaço das linhas novas saiu de
  frases redundantes das vizinhas.

## Simulação do orçamento (o "teste e vê o tempo" que o operador pediu)

`src/main/orch/mission-ceremony-budget.test.ts` dirige as FUNÇÕES REAIS de
decisão do motor numa linha do tempo com relógio falso e conta os eventos
caros. Não é cronômetro de ponta a ponta — não há LLM real aqui —, e é por isso
que os custos por evento são os medidos acima, não tetos.

**O que é medido e o que é derivado**, para o número não ser lido como
cronômetro de missão real:

| entrada | origem |
|---|---|
| typecheck 4,4 s, `npm audit` 0,75 s | **medidos** nesta máquina |
| suíte: 208 s / 766 arquivos ⇒ 0,27 s por arquivo | **medido** |
| 286 arquivos de teste impactados por um diff de 22 | **medido** chamando o portão de regressão REAL contra o diff deste PR |
| suíte impactada ≈ 77 s | **derivado** (286 × 0,27 s) — executar os 286 sob o portão exigia a raiz de dependências do sandbox, que esta máquina não tem |
| turno de LLM ≈ 60 s | **assumido** (faixa observada em campo: 30–90 s) |

A medição do portão real também confirmou a duplicação: ele rodou duas vezes
sobre o MESMO diff, porque a chave de cache do handoff (`fast`) e a da
conclusão (`with-e2e`) são distintas.

**Honestidade sobre o que o operador pediu:** ele pediu para cronometrar uma
landing page num pane só contra a mesma pela missão. Isso exige duas execuções
com LLM real, de horas, e não foi feito — o que existe aqui é contagem de
eventos pelas funções reais mais custos por evento, a maioria medidos. A
contagem de eventos não depende do projeto; o relógio depende, e numa landing
page pequena a suíte impactada é muito menor que os 286 arquivos deste repo.

Com um juiz frontier lendo o candidato por 8 min (acima do TTL de 5 min):

| | antes | depois |
|---|---|---|
| execuções da suíte mecânica | 2× | 1× |
| rodadas de worker por entrega | 2 | 1 |
| turnos de coordenação desperdiçados | 1 | 0 |
| custo modelado por unidade de entrega | 5,2 min | 2,1 min (**−60%**) |

O valor do arquivo é ser catraca: quem reintroduzir o descarte da verificação
válida, o fecho no submit ou a dupla cobrança da entrega visual faz os números
piorarem e o teste reprovar.

## Estimado, não medido

As rodadas economizadas por entrega, somando as causas 2, 3 e 4: a sequência
que o operador descreve ("duas, três, quatro, cinco vezes") sai de quatro
portões em série que **rearmam por handoff**, dois deles sem limite nenhum.
Cada rodada evitada é um turno de worker mais um de Maestro. Não há traço de
missão real nesta análise: os números acima são constantes de código e
contagens estruturais, não cronômetro.

## Achado de lado: o `check` obrigatório está vermelho na main

Levantado em 22/10 ao tentar mergear o PR 159, e vale por si.

O run do CI no commit `145d7cb23` — a release **0.76.373 publicada**, e o ponto
de partida daquela branch — falhou com **14 testes**. A branch do PR mostra 16,
e os arquivos coincidem:

| família | arquivos |
|---|---|
| F-764, tetos de tempo | `markdown-blocks` (mediu 282 ms contra limite de 200), `ComposerTiptapEditor` (481 contra 300), `memory-links`, `pty-tap-text-budget` |
| F-908, sonda de cwd via `ps` | `process-cwds`, `worktree-runtime-registry` (6), `tools-panes-isolated-writer` |
| ambiente | `native-heavy-agy-plugin` (node real), `heavy-command-permit` (serialização) |

Os dois que aparecem só na branch do PR (`pty-tap-text-budget`,
`terminal-host`) estão em caminhos que ele não toca e passam em macOS,
254/254 — são a mesma flutuação de tempo das outras.

**Consequência prática.** Com `required_status_checks: ['check']` vermelho por
ambiente, nenhum PR entra pela proteção da main. As releases 0.76.374 a
0.76.381 saíram em 21/10 com esse gate vermelho, por tags apontando para
commits FORA da main — ou seja, quem decide o embarque é o
`release:candidate` local, não este CI.

**Decidir uma das duas**, porque hoje a proteção não protege e só impede
merge: dar aos testes de tempo do F-764 e à sonda do F-908 um caminho de pulo
honesto no runner compartilhado (como `skipIfCwdProbeDeniedBySandbox` já faz
sob o Seatbelt), ou tirar `check` da lista de obrigatórios enquanto ele não
for confiável.

## Recomendação para a próxima rodada

1. Ligar `classifyWorkKind` em `mission-code-completion.ts:145` como perfil de
   cerimônia, com o formato que `routeForRisk`/`reviewerPolicy`
   (`contract-compiler.ts:254-300`) já provou no caminho PREVC — hoje
   inalcançável pela Via Rápida.
2. Dar caminho subtrativo a `mechanicalProjectRequirements`: diff sem entrada
   compilada não exige typecheck do projeto inteiro; diff sem manifesto de
   dependência não exige audit.
3. Unificar a chave de cache do portão de regressão (`'fast'` vs
   `'with-e2e'`, `regression-gate.ts:2486`) para a suíte não rodar duas vezes
   na mesma missão.
4. Orçamento de devolução **por missão**, não por sessão física:
   `JEV_REVIEW_MAX_BOUNCES` e `REGRESSION_GATE_BOUNCES_PER_SESSION` são
   apagados em toda resolução, e um respawn de rework cria sessão nova — então
   "no máximo 1" não limita missão nenhuma. O portão visual não tem contador.
5. Medir com traço real antes de mexer no portão de Stop do Maestro.
6. **Medir o custo real do `waitForIdle` no spawn.** `ensureNativeArgvPromptAccepted`
   (`tool-util.ts:1429`) espera a primeira janela de silêncio do PTY do worker
   (teto `AGENT_BOOT_TIMEOUT_MS`, 120 s) ANTES do atalho que lê o recibo nativo
   (`:1448`). Ou seja: a chamada de delegação do Maestro fica presa ao boot
   daquele worker. Com o Codex, que serializa chamadas MCP
   (`supports_parallel_tool_calls` falso por padrão), "abra 4 helpers" vira
   quatro esperas em série. No caminho típico a janela de silêncio cai no
   intervalo até o primeiro token e custa poucos segundos; o caso ruim é o
   worker que transmite desde o boot. **Não mexi**: é o caminho de prova do
   spawn (F-723 depende desses recibos) e 120 s é teto, não medição. Instrumentar
   `pane-spawn-timing` numa missão real responde se vale.
