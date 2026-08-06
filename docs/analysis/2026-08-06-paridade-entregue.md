# Paridade entregue — ledger da campanha

**Período:** 2026-08-05 → 2026-08-06 · **Lane:** pane-271 (investigação) · **Registro durável**

**Medido, não estimado:** 119 commits · 255 arquivos · **+21.975 / −1.604** linhas ·
**39 arquivos de teste novos**. Baseline da contagem: `b14c8b21..HEAD`.

Marcação das evidências do lado Overclock:
**OBSERVADO** (lido em disco/processo vivo) · **ATESTADO** (contrato injetado/schema de tool)
· **INFERIDO** · **ILEGÍVEL** (bytenode ou servidor — nunca afirmamos ter lido).

---

## 1. Ledger mecanismo a mecanismo

| # | Mecanismo | Overclock | Nexus ANTES | Nexus AGORA | Commits | Status |
|---|---|---|---|---|---|---|
| 1 | **Início de execução (cerimônia)** | Tarefa no argv do spawn: o pane nasce executando **[OBSERVADO no argv vivo]** | Spawn → esperar TUI → escrever prompt | Tarefa no argv do `claude` | `10347b0c` | **PARIDADE** |
| 2 | **Worktree** | Não existe: worker roda no workspace **[OBSERVADO]** | Worktree obrigatória por missão — provisionar ou morrer | `same_checkout` é conclusão de 1ª classe; worktree isolada vira **opt-in** | `84110780` `24b55bd4` `5c0208b9` `68925a2a` `f451652b` `13079964` | **PARIDADE + capacidade preservada** |
| 3 | **Gate de aprovação** | Não bloqueia o 1º resultado; calibração é escolha, não gate **[OBSERVADO]** | `awaiting_approval` estacionava a missão, às vezes invisível | Zero prompts no caminho da missão; autorização vira **registro** | `9e432cf0` `2e24cee3` `1990ad1a` `f847fa41` | **PARIDADE** |
| 4 | **Garantia de handoff** | Stop-hook fecha por você (`[auto]`, `closedBy:'deliver-hook'`) **[OBSERVADO verbatim]** | Nada: worker mudo matava a missão em silêncio | Cobrança app-side + hook por evento | `4ded5947` `b9739896` `5ac0fd58` | **EXCEDE** (nosso alcança todo CLI; o hook deles é preso ao Claude Code) |
| 5 | **Sobrevivência/wake do orquestrador** | Handoff é DIGITADO no input do delegador **[OBSERVADO]** | Ejeção pro assistente; missão retomada perdia os panes | Retomar volta aos panes; encerramento preserva panes | `24f98406` `336945f7` `efe44703` `5833077a` `172d5b7b` | **PARIDADE** |
| 6 | **Stall** | `stalled (no output >20min, no handoff)` — **falso positivo conhecido** **[OBSERVADO em strings]** | Silêncio num canal só era tratado como morte | Vivacidade = **atividade**, não silêncio de canal | `827273b5` | **EXCEDE** (evitamos o falso positivo deles) |
| 7 | **Reaping / TTL** | `reapZombies` existe mas **~130 filhos `<defunct>` vivos**; janitor por lease recusa kill sem `startKey` **[OBSERVADO]** | Quit podia pendurar; órfãos | Quit com teto inarredável, falha vira registro, varredura de órfãos | `6dd48830` | **EXCEDE** |
| 8 | **Fonte do paralelismo** | **DECLARADO** na recipe/squad (`spine[].role`, "1 worker por tela") **[ATESTADO]** | Inferência frágil; 1 raiz na prática | Templates abrem em leque **e** partição por área do repo vivo | `977b04c7` `10d0bd6a` `81d11f4c` `905dc6bb` `2db7f82d` | **PARIDADE + inferência que eles não têm** |
| 9 | **Decomposição do plano** | 3 andares: orq → 3 chefes fixos → ≤5 folhas por chefe **[OBSERVADO]** | Onda plana, teto 8/missão, uma incógnita afundava o plano todo | Amolecimento por story; teto 8 continua mais generoso que os ≤5/chefe | `977b04c7` `347f0b7b` `5ebcd127` | **DIVERGÊNCIA DELIBERADA** (árvore dormente até `áreas ≥ 2` **e** `unidades > 8`) |
| 10 | **Substrato de hook / forma por evento** | `stop` **desacoplado + fail-open**; `pretool` **síncrono + fail-closed** **[OBSERVADO nos dois .mjs]** | Um só formato, síncrono e fail-closed — por isso não instalávamos no HOME real (`0fe423aa`) | Forma **por evento**: stop desacoplado/fail-open, pretool intacto | `5ac0fd58` | **PARIDADE** |
| 11 | **Disciplina de papel** | Imposta no **launcher**: `--disallowedTools` remove Read/Bash/pane_list do piloto **[OBSERVADO no argv]** | Pedida no prompt (e portanto negociável) | Disciplina de papel é **config de launch**, não pedido | `a2e24bc2` + teste `role-tool-discipline.test.ts` | **PARIDADE** |
| 12 | **Formato de delegação** | Brief por ponteiro (C-036): arquivo + write-back `## Resultado` no mesmo arquivo **[OBSERVADO — formato real extraído]** | Briefing inteiro no contexto do worker | Brief por ponteiro, formato do Overclock **com o nosso ganho** | `271d20d6` | **PARIDADE +** |
| 13 | **Doutrina de modelo/effort** | rote→barato, normal→equilibrado, define-contrato→profundo; **default DOWN** **[ATESTADO]**; `oc-cataloger` fixado em haiku **[OBSERVADO]** | Sem doutrina explícita | Doutrina registrada; **default não mexido sem medir** (parte do tempo era espera de CI real) | `a5f09096` (doutrina) | **PARIDADE de doutrina; medição pendente** |
| 14 | **Filosofia de degradação** | *"DEGRADE BY TIER, never error… always ship the tier the current keys allow"* **[OBSERVADO]** | Bloqueio por capacidade ausente | **D1 vira lei**: guarda de build reprova bloqueio sem tier degradado declarado | `535eac0c` | **PARIDADE executável** (a nossa é cobrada por teste; a deles é prosa no prompt) |
| 15 | **Endereçamento de pane** | `paneId` opaco (`pane-271`) **[OBSERVADO]** | Idem | Número humano ⌘1-9 + **nome durável por pane** no header | `c04f157d` `254ddab4` `74d4d103` | **EXCEDE** |
| 16 | **Pipeline de voz** | Chat/Code em dois endpoints; fallback local whisper.cpp com mensagem acionável **[OBSERVADO em strings]** | Ditado morria no pane governado; Space roubava digitação; saída em PT | Lane do operador; discriminador toque×hold; modo de saída EN/PT com seletor | `61f91fb1` `954b1ae3` `ca488d18` `d23ae49c` `4a399665` | **PARIDADE** (cadeia Groq→OpenAI→whisper.cpp local já era nossa: `stt-service.ts:16`) |
| 17 | **Catálogo / plugins** | Catálogo + marketplace server-side (`/api/v1/catalog/*`) **[ILEGÍVEL — servidor]** | Catálogo e forge-registry próprios | **Ingestão de plugins de agente** (spec agent-plugins.org: descobre, valida, relata) + busca ranqueada por necessidade | `c3dd61d1` `57214879` | **EXCEDE** (padrão aberto; eles são fechados) |
| 18 | **Fechamento de pane entregue** | `autoCloseOnHandoff` no spawn **[ATESTADO]** | Pane entregue segurava vaga | `autoCloseOnHandoff` declarado no spawn + `pane_close` por escopo | `cb5a3169` | **PARIDADE** |

---

## 2. Ledger das mortes — cada falha vivida, mapeada ao conserto

| Morte vivida | Causa-raiz nomeada | Conserto | Verificação |
|---|---|---|---|
| Missão não começa | Worktree obrigatória; provisionamento falha ⇒ parede | `84110780` worktree opt-in | teste + gate |
| Aprovação re-perguntada em loop | Aprovação vigente não cobria janela pending nem drift de conta/effort | `664b534f` `706e7261` `cd621293` `c9634478` | teste |
| Missão estacionada em `awaiting_approval`, invisível | Estado terminal sem apresentação | `2e24cee3` `9e432cf0` | teste (`44dd2ad3` fixa o que ainda pergunta) |
| Revisor de contexto nunca subia | Leitor `readOnly` disputava slot exclusivo de escrita | `347f0b7b` | teste |
| Parada em `handoff_ready` | Conclusão exigia forma que o caminho simples não produz | `24b55bd4` `5c0208b9` | teste + E2E |
| Entrega recusada por `same_checkout` | Escopo de escrita do worker não reconhecia o receipt | `68925a2a` `474e2fb4` `f451652b` `13079964` | E2E (`0930a7a7`) |
| Worker codava e sumia sem handoff | Nenhuma cobrança de handoff | `4ded5947` `b9739896` | teste + sonda de stall |
| Falso positivo de stall | Vivacidade medida por silêncio de UM canal | `827273b5` | teste |
| Ditado nunca chegava no pane | Pane governado não aceitava a lane de ditado | `61f91fb1` | **probe obrigatória do smoke empacotado** (`47eb2db1`) |
| Um toque no Space roubava a digitação | Sem discriminador toque×hold | `954b1ae3` `ca488d18` | probe do gate (`5244f133`, `7b52d7eb`) + prova de relógio real (`03bdd8d3`) |
| Ditado saía em PT em vez de EN | Sem modo de saída | `d23ae49c` | teste |
| Ejeção da visão de panes | Retomar/encerrar levava ao assistente | `24f98406` `336945f7` `efe44703` `172d5b7b` `5833077a` | teste |
| Pane do orq preto | Repintura via replay do main | `9bdc4716` `02f41b13` | teste |
| Mojibake no empacotado | Locale UTF-8 perdido no child PTY (`LC_ALL/LC_CTYPE=C`) | `96b1be19` `16a77ad3` | smoke empacotado |
| Só 2 panes | Escada de concorrência não honesta com o hardware | `5ebcd127` `347f0b7b` | teste |
| Tetos silenciosos | Veredito dizia fase, não "N de M" nem o teto restante | `574139c5` `0531a95e` | teste |
| Paradas silenciosas | Missão parada não dizia por quê | `e35fb1a8` `97542ec9` | teste |
| App não fechava | Quit sem teto; órfãos | `6dd48830` | teste |

---

## 3. Onde o Nexus EXCEDE (a parte que ele nunca viu)

**Superfície:** **146 tools** enumeradas pela lane 248 (contagem independente minha:
139–149 conforme o padrão de definição usado) contra **~35** do Overclock **[ATESTADO
pelo orquestrador da própria sessão dele]**. Não é volume vazio — são capacidades sem
equivalente do outro lado:

- `nexus_code_map_*` (4) — **blast radius**. O Overclock não tem nada disso.
- `nexus_lsp_*` (4) — navegação semântica real.
- **11 tools de git** de 1ª classe. Eles delegam pro shell.
- `nexus_context_*` (9) — contexto governado com draft/review/commit. Máquina inteira ausente lá.
- `nexus_design_system_*` (8), `nexus_memory_*` (3), `nexus_worktree_*` + fila de merge,
  `nexus_sensor_run`, `nexus_security_audit`, `nexus_validation_run`, `nexus_remote_*` (4).
- `nexus_handoff_ack` — reconhecimento explícito, além de submit/list.
- `nexus_agent_invoke` — nós **invocamos**; lá só se lista.
- `nexus_browser_*` (10) contra `navigate`/`open_browser`.

**Multi-CLI real.** Vinculação por membro (CLI+modelo por assento) contra a squad deles,
cujo gate é `allowedCLIs=claude` **[OBSERVADO na query do MCP do piloto]** — monocultura
declarada na config.

**Doutrina local/offline.** Os prompts dos chefes deles vêm de
`app.overclock.sh/api/v1/agent/plan`, **atrás de assinatura**, com falha nomeada
`plan_required`/`server_unreachable` **[OBSERVADO em strings]**: sem rede ou sem assinatura,
a hierarquia inteira não sobe. O nosso caminho de missão é local.

**Enforcement que alcança todo CLI.** O hook deles é preso ao Claude Code; nossa cobrança
app-side (`b9739896`, `4ded5947`) vale para qualquer CLI do roster.

---

## 4. O que deliberadamente NÃO copiamos

| Não copiado | Evidência | Por quê |
|---|---|---|
| `width_cap` contando pane morto | **[ATESTADO]** — recusou a própria recuperação | Teto que impede recuperação é pior que teto nenhum |
| Fantasmas de TTL exigindo purge+resume | **[ATESTADO]** | Estado morto que exige ritual manual |
| Avisos falsos de morte | `stalled (no output >20min)` **[OBSERVADO]** | Worker pensando não é worker morto — nossa vivacidade é por atividade (`827273b5`) |
| Entregas engolidas | `handoff.wake_undelivered` **[OBSERVADO]** | Entrega perdida é a falha mais cara do sistema |
| Camada de task matando cadeias de processo filho | vivido: 2 kills na campanha 0.27.0 (`1ea913db`) | Documentado como risco, não replicado |
| Monocultura de claude na squad | `allowedCLIs=claude` **[OBSERVADO]** | Multi-CLI é ativo nosso |
| Piloto sem `pane_list` | **[OBSERVADO]** — mas **é desenho, não defeito** | Correção: o anti-polling mecânico foi **copiado** (`a2e24bc2`); o que não copiamos é a cegueira total |
| Cérebro server-side | `/api/v1/{agent/plan, squad/decide, jarvis/route}` **[OBSERVADO]** | Dependência de rede no caminho da missão |

---

## 5. O que resta, honestamente

| Item | Dono | Estado |
|---|---|---|
| **Delta de UI de voz** | pane-271 | **Bloqueado** — falta captura do Overclock com a voz em uso; o JS é bytenode e as strings só têm plumbing |
| Árvore de tiers (andar intermediário) | pane-248 | **Dormente por decisão** — dispara só com `áreas ≥ 2` **e** `unidades > 8` |
| Medição de modelo/effort no turno 1 | — | Não medido; explicitamente **não mexer em default sem medir** |
| Tempos de spawn→handoff | — | **Não obtível** (ver §6) |
| Ingestão de plugins: consumo de 3º ponta a ponta | — | Base landada em `c3dd61d1`; falta o primeiro plugin real |

---

## 6. O método — para a profundidade ser legível

**O que produziu evidência:**
1. **Introspecção do motor vivo** — o orquestrador do Overclock consultado em sessão sobre
   recipes, squads e doutrina de modelo (marcado ATESTADO em todo o ledger).
2. **Extração verbatim dos dois hooks `.mjs`** — `handoff-deliver.mjs` (430 linhas) e
   `handoff-stop.mjs` (34KB), mais `soft-status.mjs`, `release-gate-pane-*.mjs`,
   `workflow-deny-pane-*.mjs`. 12 mecanismos evidenciados linha a linha.
3. **O prompt do piloto em texto puro** — `system-prompt-pane-105.txt`, 128 linhas,
   6 blocos, extraído integral. É a doutrina na forma mais pura.
4. **argv dos processos vivos** — provou que a disciplina de papel é launch config
   (`--disallowedTools`), não prosa.
5. **CSV de catálogo com 1.192 itens** — `2026-08-06-overclock-catalogo-1192.csv`.
6. **Enumeração da superfície de tools** dos dois lados.
7. **`strings` do bytecode do sidecar** — 48.877 linhas: revelou `roster_violation`,
   `width_cap`, `plan_required`, `handoff.wake_undelivered`, `stalled (>20min)`,
   kill-safety por lease, e o vocabulário de config de voz.
8. **`.overclock-app` do workspace** — onde vivem `briefs/`, `progress/pane-N.md`,
   `panes.json` com argv, e o `token_usage` vivo (101k linhas com custo por mensagem).

**O que NÃO foi obtível — e por isso nunca afirmamos ter lido:**
- **Fonte do app**: bytenode. O JS compilado é ilegível; só strings.
- **Prompts dos chefes**: server-side, atrás de assinatura. Não existem em disco.
- **Tempos de spawn→handoff**: `messages.db` do HOME é **legado** (`messages` e `tasks` com
  0 linhas; `activity_log_v2` com 1 linha de 2026-07-01). Não há trilha em disco.
  Única medição real que consegui foi **do lado de dentro**, num pane só: T0→prompt = 34s,
  T0→primeiro token = 53,8s. Os "3-7s" seguem **não medidos** — e continuamos dizendo isso
  em vez de inventar número.

---

## Apêndice — correções que a varredura fez ao que acreditávamos

| Acreditávamos | Real | Efeito |
|---|---|---|
| App Electron | **Tauri** (Rust 24MB) + sidecar Node; bytenode só no core JS | Referência viva pro nosso spike |
| Não existe `briefs/` | Existe — no `.overclock-app` **do workspace** | Destravou `271d20d6` |
| Piloto sem `pane_list` é defeito | É desenho: anti-polling imposto no launcher | Virou item copiado (`a2e24bc2`) |
| Prompts dos chefes estariam em disco | Cloud + assinatura | Port exige desenho próprio |
| `messages.db` vazio ⇒ sem telemetria | O do HOME é legado; **o do workspace está vivo** (20MB) | Trilha de custo existe e é medível |
