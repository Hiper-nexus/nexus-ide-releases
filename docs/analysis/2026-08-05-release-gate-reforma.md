# Reforma do gate de release: rápido, atual e míope nunca mais

**Data:** 2026-08-05 · **Status:** spec pronto para implementação · **Origem:** ledger de hoje — o gate custou ~2h e pegou apenas dívidas dele mesmo, enquanto a **v0.25.1 shipou com ditado 100% morto ATRAVÉS deste gate**. Três frentes: velocidade, higiene de invariantes, cobertura voltada ao usuário.

Superfícies envolvidas: `scripts/release-candidate-gate.mjs` (27 KB), `scripts/verify-macos-release.mjs` (24 KB), `scripts/make-release.mjs` (15 KB), `scripts/publish-release.mjs` (48 KB), `scripts/e2e-real-mission-evidence.mjs` + `src/shared/real-mission-e2e-evidence.ts`.

---

## Frente 1 — VELOCIDADE (alvo: gate completo < 15min; fast lane < 5min)

Cinco alavancas, ranqueadas por minutos-ganhos/esforço:

| # | Alavanca | Como | Size | Min. ganhos | Rank |
|---|---|---|---|---|---|
| 1a | **Notarização Apple ∥ missão E2E** | Hoje é serial: notarizar → montar staging → rodar E2E. A missão E2E roda contra o .app extraído local e NÃO depende do ticket de notarização; só o publish depende. Disparar `notarytool submit --no-wait` assim que o artefato sela, rodar E2E em paralelo, `notarytool wait` + staple como barreira só antes do publish | **M** | **~10** | **1º** |
| 1e | **Fast lane de hotfix** | Critérios de qualificação EXPLÍCITOS e verificados por diff: (i) mudança só em `docs/**`, `**/*.test.*`, `scripts/spikes/**` ⇒ reusa gate verde anterior INTEIRO (só re-verifica assinatura); (ii) patch cirúrgico single-fix (1 módulo de produção + testes) sobre candidate verde ⇒ reusa a missão E2E anterior + roda apenas smoke empacotado + smokes user-facing (Frente 3). Qualificação automática: script que classifica `git diff --name-only <verde>..HEAD` contra as duas listas; qualquer path fora ⇒ gate completo. O waiver fica REGISTRADO no publish (mesmo padrão do skip declarado da 0.20.4) | **S/M** | ~40-90 no fluxo de hotfix | **2º** |
| 1c | **Expansão do reuse de candidate verde** | Base já landada: bf9a317c (`perf(release): reutilizar candidate verde local no publish`). Expandir: cache keyed por commit-hash do conteúdo empacotável (excluir docs/tests do hash), de modo que re-rodar release após commit não-empacotável reaproveite DMG+gate. Integra com 1e | **M** | ~15-30 quando aplica | **3º** |
| 1b | **verify-macos-release ∥ boot do E2E** | As checagens estáticas do DMG/ZIP (fuses, assinatura, hardlinks do staging, natives) não dependem da missão E2E; rodar num `Promise.all` com a extração+boot do app do gate. Atenção à trilha FORCE_COLOR (memória: `NO_COLOR=1` obrigatório p/ o match do @electron/fuses) | **S** | ~3-5 | **4º** |
| 1d | **Release em CI/runner dedicado** | Spec honesto dos bloqueadores reais desta máquina→CI: (i) credenciais notary (App Store Connect key) e signing identity no runner — keychain de CI com `security create-keychain` + import, unlock por sessão; (ii) **desafios de sessão GUI**: SecurityAgent/keychain exigem sessão Aqua — runner precisa ser máquina macOS logada (self-hosted) e NUNCA keychain de login trancado (memória 24/07: keychain trancado congela a main thread do app; vault off no processo e2e via `NEXUS_DEV_NO_VAULT`); (iii) o gate dirige app GUI real por CDP — precisa de display; (iv) Node 22.x exato (nexusRelease.node) e node_modules próprio (NUNCA o symlink compartilhado — memória: hooks mutam a árvore, asar sem natives). Entregável: runbook + workflow self-hosted; até lá, 1a-1c/1e já entregam a meta local | **L** | tira ~2h da máquina do dev | **5º** |
| 1f | **Isolamento do checkout de release** | O gate roda a partir de um **worktree/clone isolado** do commit candidato (`git worktree add <hold> <sha>`), nunca do working tree vivo do dev. Motivo comprovado HOJE (05/08): sessão paralela criou 4 specs untracked em `docs/analysis/` e o check de higiene da árvore do gate travou — colisão entre trabalho legítimo de outra sessão e a exigência de árvore limpa. Com checkout isolado, a higiene é verificada no worktree do release (sempre limpo por construção) e sessões paralelas ficam livres. Cuidados já mapeados na memória do projeto: node_modules do worktree via estratégia própria (nunca `npm install` no symlink compartilhado), `.dev-user-data` do worktree, ownership de worktrees órfãos (fix 5dd32231 e trilha de 30/07) | **M** | elimina classe inteira de falso-bloqueio; destrava paralelismo dev∥release | **3º-empate** |

Sequência recomendada: **1a → 1e → 1f → 1c → 1b**, com 1d como trilha paralela de infra.

---

## Frente 2 — HIGIENE DE INVARIANTES (contrato muda ⇒ invariante muda NO MESMO commit)

**Caso de hoje:** o bloco `chainHandoffIsExact` (`scripts/e2e-real-mission-evidence.mjs:954`, `src/shared/real-mission-e2e-evidence.ts:638`) ainda assertava a semântica de ack **pré-Wave Pack**; 67a7e8a7 (`feat(orch): Mission Wave Pack — N stories viram panes em paralelo`, 03/08) mudou o contrato e o gate ficou assertando a realidade v0.23 — **fricção pura, proteção zero** (o gate de hoje gastou tempo pegando exatamente essa dívida dele mesmo).

**Regra de governança:** todo commit que muda um CONTRATO de produto (semântica de ack/handoff, estados terminais de missão, shape de receipt, protocolo de pane) DEVE atualizar os invariantes do gate no MESMO commit.

**Enforcement em duas camadas (implementar ambas):**

1. **Meta-teste de mapeamento (mecanismo, não disciplina)** — novo `src/shared/real-mission-e2e-evidence.contract.test.ts`:
   - um manifesto `INVARIANT_CONTRACT_MAP` declara cada invariante do gate (ex.: `chainHandoffIsExact`) → lista dos módulos de contrato que ele observa (ex.: `src/main/orch/mission-scheduler-dispatch-transaction.ts`, `src/shared/failover-handoff.ts`) → um `contractVersion` (string curta bumpada à mão);
   - o teste calcula hash do conteúdo dos módulos mapeados e compara com o hash gravado no manifesto: **módulo de contrato mudou sem bump ⇒ teste falha na hora do commit** (roda no vitest normal, não só no gate), com mensagem apontando o invariante a revisar;
   - custo de manutenção: um bump de hash por mudança de contrato — exatamente o momento em que o autor deve olhar o invariante.
2. **Item de checklist de PR** (rede de segurança humana): "Mudei semântica de ack/handoff/estado terminal? ⇒ invariantes do gate atualizados neste PR (aponte o diff)".

Critério de aceite: reproduzir o cenário de hoje em teste — mudar a semântica de ack num módulo mapeado sem bump ⇒ suíte falha; com bump + invariante atualizado ⇒ verde.

---

## Frente 3 — COBERTURA VOLTADA AO USUÁRIO (o gate prova cadeias internas; o usuário sente outra coisa)

A v0.25.1 provou o gap: cadeia interna verde, ditado morto. Adicionar à missão E2E do gate **smokes baratos do que o usuário sente**, todos com instrumentação já existente:

| # | Smoke | Assert (barato) | Base já landada |
|---|---|---|---|
| S1 | **Ditado entrega** | Simular fluxo de voz → texto TEM que aterrissar no pane alvo; verificável pelo evento de entrega confirmada no `voice.log` (instrumentação de 550b135e `fix(voice): entrega confirmada do ditado no pane`). Assert: evento `delivered` com paneId esperado dentro de timeout | 550b135e |
| S2 | **Quit limpo** | Ao final da missão E2E, pedir quit do app e assertar: (i) processo main encerra dentro do deadline global (a78dbc21); (ii) escalação registrou desfecho (76d405d1); (iii) **sweep de supervisores: ZERO `nexus-pty-supervisor` do .app extraído vivo após o quit** — teria pego HOJE os 8 zumbis órfãos do gate (evidência: diagnóstico 05/08, sample no loop de main.c:1369; ver `2026-08-05-pty-supervisor-rust.md`) | 76d405d1, a78dbc21 |
| S3 | **Missão termina em estado terminal** | A missão do gate deve alcançar estado terminal explícito (done/failed com veredito), nunca "acabou por timeout do runner". Assert no registro da missão no runtime.sqlite3 do gate | evidência existente do gate |

Implementação: os três entram como asserts adicionais no `e2e-real-mission-evidence` (mesma passada, sem nova execução do app — custo de wall-clock ~zero, exceto S2 que já é o caminho de quit). **S2 é também a regressão permanente do achado de hoje** (zumbis de supervisor).

Size total Frente 3: **S/M**. Prioridade: S1 (foi o furo real shipado) → S2 (furo achado hoje) → S3.

---

## Resumo executivo

| Frente | Entrega | Size | Quando |
|---|---|---|---|
| 1 Velocidade | 1a+1e+1f+1c+1b (local < 15min; hotfix < 5min; checkout isolado) | M | P1 |
| 1d CI runner | runbook + workflow self-hosted | L | P2 |
| 2 Invariantes | meta-teste de mapeamento + checklist | S/M | P1 (junto do próximo touch de contrato) |
| 3 User-facing | S1 ditado, S2 quit+sweep, S3 terminal | S/M | P1 — S2 fecha a regressão dos zumbis |
