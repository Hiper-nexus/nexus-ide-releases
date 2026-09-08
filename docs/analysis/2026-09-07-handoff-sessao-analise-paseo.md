# Handoff — sessão "análise Paseo × Nexus" → sessão em andamento

**Data:** 2026-09-07 · **Branch:** `fix/nexus-mission-reliability-20260904`
**Origem:** sessão que analisou o Paseo (`getpaseo/paseo`, Apache-2.0) e executou a Fase 0 do plano.
**Estado do remoto:** `origin/fix/nexus-mission-reliability-20260904` = `e615c2eb`, 0 à frente / 0 atrás. Tudo que fiz está pushed.
**Este arquivo está intentionally untracked** para viajar junto com o seu commit.

---

## 1. LEIA ISTO PRIMEIRO — eu commitei trabalho seu por engano, e já desfez

Enquanto eu trabalhava, você tinha mudanças não commitadas em `src/renderer/styles/app-shell.css`
(novas regras `.product-header__identity`, `.product-header__name`, `.product-header__destination`,
`.product-header__tools`, e `grid-template-rows` de 5 para 6 faixas).

Eu editei 3 linhas nesse mesmo arquivo (fallbacks `--surface-*`) e fiz `git add` do arquivo inteiro.
O commit `daf12338` saiu com **105 inserções e 78 deleções**, quando as minhas eram 3 e 3. Ou seja:
pushei ~102 adições e ~75 deleções suas, deixando o remoto com CSS de `.product-header__*` sem o
`.tsx` correspondente (que continua não commitado) — um estado quebrado para quem fizesse pull.

**Como corrigi, sem force-push:**

- `30bf1879` restaura `app-shell.css` no remoto para `base (3c61b149) + minhas 3 linhas`.
  O CSS órfão saiu do remoto: `git show origin/…:src/renderer/styles/app-shell.css | grep -c product-header__identity` → `0`.
- Devolvi o seu conteúdo ao working tree **exatamente como estava**. Verificado agora:
  `grep -c product-header__identity src/renderer/styles/app-shell.css` → `1`. Seu trabalho não foi perdido.
- Backup das duas versões, se quiser conferir: `/tmp/app-shell-com-trabalho-deles.css`
  (= conteúdo de `daf12338`) e `/tmp/app-shell-base.css` (= `3c61b149`).

**Histórico:** `daf12338` continua no histórico com o conteúdo misturado, e `30bf1879` o desfez.
Não reescrevi histórico publicado porque você pode estar pushando a qualquer momento.
Se preferir histórico limpo, `git rebase -i 3c61b149` e squash de `daf12338`+`30bf1879` resolve —
mas exige force-push, e eu não fiz isso sem você pedir.

### Overlap que você precisa saber ao commitar

O seu refactor de `app-shell.css` **reescreve o bloco onde estavam 2 dos meus 3 fixes**:

| Linha (base) | Meu fix em `daf12338` | O que o seu refactor faz |
|---|---|---|
| `--surface-1` no `.workspace-rail__mission` | `rgba(255,255,255,0.035)` → `#121115` | substituído por `var(--surface-1)` sem fallback |
| `--surface-3` no `--row--selected` | `rgba(255,255,255,0.10)` → `#201e25` | substituído por `var(--surface-3)` sem fallback |
| `--surface-2` no `:hover` | `rgba(255,255,255,0.065)` → `#16151a` | **sobrevive** — hoje na linha 646 |

Isso **não é conflito de intenção**: `DESIGN.md` §2 diz "Fallbacks de `var()` devem ter o valor ATUAL
do token" — quem não escreve fallback não viola a regra. Então quando você commitar, 2 dos 3 fixes do
F-335 em `app-shell.css` simplesmente deixam de existir, e está correto. Os outros 3 fixes do F-335
(`mission-board.css:1580,1585` e `git-scm.css:506`) não têm overlap com você e permanecem.

---

## 2. O que está committed e pushed (6 commits)

| Commit | Finding | O que faz |
|---|---|---|
| `daf12338` | F-335 | 6 fallbacks `var(--surface-*)` defasados → valor atual do token, em `app-shell.css` (3), `mission-board.css` (2), `git-scm.css` (1) |
| `7ea8c7d3` | F-404 | `checkWorktreeStatus` tri-estado + fim do sucesso falso em `archiveWorktree` |
| `7e67951f` | F-405 | Marcadores `NOT WIRED` nos 4 módulos da ilha de worktree |
| `6f0bd074` | F-505 | `AGENTS.md` aponta segurança para os 3 docs reais, não só o stub de 1.3 KB |
| `30bf1879` | F-335 | **Reparo**: remove do remoto o seu trabalho que entrou por engano |
| `e615c2eb` | — | oxlint: `.oxlintrc.json` + 2 scripts + devDep |

Docs de finding criados: `docs/qa/items/F-335.md`, `F-404.md`, `F-405.md`, `F-505.md`.
**Não use esses IDs** — os seus são `F-132…F-141`, `F-332…F-334`, `F-403`. Sem colisão.

---

## 3. O único change de código real: F-404

`src/main/runtime/worktree-lifecycle.ts` tinha dois defeitos na mesma função.

**Antes** — fail-open:

```ts
} catch {
  // If git status fails (e.g. directory already gone or invalid), consider clean to allow prune
  return Object.freeze({ isClean: true, dirtyFiles: Object.freeze([]) });
}
```

Qualquer falha do `git status` virava "limpo". Um `index.lock` retido por um agente concorrente —
cenário real com várias missões no mesmo checkout — era lido como worktree limpo e liberava
`git worktree remove` + `git branch -D` sobre mudanças não commitadas.

**Antes** — sucesso falso, cuja guarda não implementava a intenção do próprio comentário:

```ts
} catch (err) {
  // If removal failed because the worktree directory is already deleted/missing, continue to prune
  if (!options.force && status.dirtyFiles.length > 0) { throw err; }
}
```

Para worktree limpo cuja remoção falhou, `dirtyFiles.length` é 0 → exceção engolida → `ok: true`
sobre um worktree que continua no disco. `dirtyFiles` não tem relação com "diretório ausente".

**Depois** — `state: 'clean' | 'dirty' | 'missing' | 'unverifiable'`, com `existsSync` decidindo
`missing` **antes** de consultar o git, `archiveWorktree` recusando `dirty` **e** `unverifiable`
sem `force` (novo `WorktreeStatusUnknownError`), e a guarda de remoção virando
`if (status.state !== 'missing') throw err` — que é a intenção que o comentário descrevia.

O precedente é do próprio repo: `EndpointClaim.kind` em `src/main/pty-daemon/endpoint-ownership.ts`
é `'claimed' | 'incumbent-live' | 'unverifiable'`, e `docs/architecture/pty-daemon-spec.md` escreve
"nunca colapsar 'não sei' em 'morto'".

**O teste antigo não pegava nenhum dos dois** porque o mock de `GitRunner` nunca lançava exceção e os
paths eram fabricados (`/tmp/wt`), então nem o `catch` nem a guarda de remoção eram exercidos.
Reescrevi com `mkdtempSync` (diretórios reais) e 3 casos novos. 13/13 verdes; 49/49 na suíte adjacente.

**Impacto em você: zero.** `isClean` não existe mais em lugar nenhum (`grep -rn "isClean" src/` vazio),
e este módulo não tem call sites de produção — ver F-405 abaixo.

---

## 4. F-405 — registrado como `precisa-decisao`, e o usuário decidiu: **LIGAR**

Os 4 módulos derivados do Paseo (`src/shared/worktree-branch-slug.ts`,
`src/main/runtime/worktree-metadata.ts`, `worktree-lifecycle.ts`, `mission-worktree-orchestrator.ts`)
formam uma **ilha fechada**: toda referência externa é `.test.ts`. Consequências verificadas:

- `.git/nexus/worktree.json` **nunca é escrito** por um app rodando.
- `autoArchiveOnMerge` tem 5 ocorrências no repo inteiro (tipo, default, `true` hardcoded, teste) e
  **nenhum leitor**. Não existe lógica de auto-archive.
- Dois esquemas de branch sem reconciliação: produção usa
  `refs/heads/nexus/<projectKey[0:16]>/<taskKey[0:32]>` (`WorktreeManager`), a ilha produz `task/<slug>`.
- O caminho de remoção de produção é `worktree-removal-safety.ts`, não `archiveWorktree`.

**Decisão do usuário: ligar ao `WorktreeManager`.** Isso exige, antes de ligar:

1. Reconciliar `task/<slug>` com `refs/heads/nexus/<hash>/<hash>` — decidir um, ou um mapeamento.
2. Decidir o dono da remoção: `archiveWorktree` ou `worktree-removal-safety.ts`.
3. **Implementar o leitor de `autoArchiveOnMerge`, que não existe.**
4. Lock advisory cross-process em `worktreesRoot`. Hoje a proteção é o CAS do SQLite
   (`WorktreeManager.#mutate`, `MAX_CAS_ATTEMPTS = 16`) + `index.lock` do git, o que cobre uma
   instância do app mas não duas, nem um `git worktree add` manual do usuário.

Tudo isso é `src/main/runtime/` — **não colide com você**, que está em `src/main/orch/`,
`src/main/context/` e `src/renderer/`. Mas o gatilho de "merge detectado" provavelmente mora no seu
lado (missão concluída / merge queue), então o ponto 3 precisa de uma conversa.

Não comecei isso: a Fase 0 inteira coube nesta sessão e ligar a ilha é trabalho de fronteira de
segurança declarada no `AGENTS.md`.

---

## 5. O que eu NÃO toquei (e por quê)

O usuário escolheu explicitamente **"só o que não colide"**. Ficaram fora:

- **Todos os seus 38 arquivos modificados e ~24 untracked.** Nenhum staged, nenhum commitado
  (a exceção foi `app-shell.css`, corrigida no §1).
- `src/renderer/components/**` — bloqueia a Fase 1 (virtualização de `AgentActivityTimeline.tsx`
  e persistência de rascunhos em `GitPanelBody.tsx`).
- `src/main/orch/**` — bloqueia parte da Fase 4.
- `src/main/context/**` — você está editando agora.
- `DESIGN.md`, `PRODUCT.md` — você tem mudanças não commitadas em ambos.
- `npm run lint` — continua `tsc --noEmit`. Não mudei a semântica de nada que você ou o CI usam.

---

## 6. Estado dos gates — importante para você

| Gate | Estado | Observação |
|---|---|---|
| `npx tsc --noEmit` | **VERMELHO, 3 erros** | Todos em `src/main/orch/mission-independent-review-gate.test.ts:90,105,109,119` — `'scope'` e `'automaticProof'` não existem no tipo. **É seu, não meu.** Nenhum arquivo que toquei aparece na saída. |
| `npm run security:renderer-sinks` | verde | "0 executable DOM sinks" |
| Testes focados dos meus arquivos | verde | 49/49 em `worktree-lifecycle`, `worktree-metadata`, `mission-worktree-orchestrator`, `worktree-branch-slug`, `ui-theme` |
| `npm run lint:oxlint` | 168 warnings, 0 erros | novo, report-only, ~190ms em 2731 arquivos |
| `npm run lint:oxlint:ratchet` | verde no baseline 168 | falha acima de 168 |

**Eu não podia usar `tsc --noEmit` como gate de repo inteiro por causa do seu arquivo.** Validei meus
changes por arquivo: os 3 erros são todos em `mission-independent-review-gate.test.ts`, que está
modificado por você e não tem nenhuma relação de import com o que toquei
(`grep -rn "worktree-branch-slug\|worktree-lifecycle\|worktree-metadata\|mission-worktree-orchestrator" src/main/orch/` → vazio).

### oxlint: 47 dos 168 warnings são seus

Distribuição por diretório: `src/main/orch` **47**, `src/renderer/voice` 20, `src/main/context` **14**,
`src/main/pty` 8, `src/main/voice` 6, `src/renderer/pet` 5, `src/main/design` 5, resto espalhado.
Zero nos meus arquivos.

Por isso os dois scripts são **opt-in e não entraram em `pretest`/`premake`/CI** — virar blocking
quebraria o build de trabalho em voo que não tem nada a ver com lint. Se você quiser adotar de
verdade, o caminho é queimar os 47 de `orch/` e os 14 de `context/` primeiro e só então plugar no CI.

Regras ligadas (9): `preserve-caught-error` (46 — engolir o erro original), `no-unsafe-optional-chaining` (24),
`no-unused-expressions` (10), `no-unused-vars` (8), `no-unsafe-finally` (7),
`no-misleading-character-class` (1), `max-lines` 1500 (14 arquivos), `max-depth` 4 (58).
Desligadas de propósito, com a contagem que fariam num run default: `no-control-regex` (67 falsos
positivos — este codebase redige e parseia chars de controle de propósito, ex.
`renderer-mission-authority.ts:146`), `no-array-sort` (367), `no-underscore-dangle` (174),
`consistent-function-scoping` (152), `promise/always-return` (131), `complexity` (300 a max 20 —
parede, não sinal), `max-nested-callbacks` (200, quase tudo aninhamento de teste).

---

## 7. Decisões já tomadas pelo usuário (não pergunte de novo)

1. **Colisão com a sua sessão:** só o que não colide. → Fases 1 e 2 adiadas até você commitar.
2. **F-405:** ligar a ilha ao `WorktreeManager`.
3. **Dependências:** tudo que o plano pede — `oxlint` (feito), `@tanstack/react-virtual` (Fase 1),
   `sqlite-vec` (Fase 5).

## 8. O que falta (Fases 1–5), e o que as bloqueia

| Fase | Conteúdo | Bloqueio |
|---|---|---|
| 1 | Virtualização de timeline + diff; persistir rascunhos de anotação do diff (hoje são estado local de componente e se perdem em troca de aba) | `src/renderer/components/**` — **você** |
| 2 | Frame binário de terminal (2 bytes + mux de slots), MessagePort direto PTY→xterm, `monitorEventLoopDelay` + métrica de 30s | `src/main/pty/pty-manager.ts` (3260 linhas, fronteira de segurança). Não colide com você, mas é grande demais para entrar junto com o seu trabalho em voo |
| 3 | `palette-gen.ts` (gerador de paleta com piso de contraste) + gate de contraste | **ENTREGUE** — commit `001dc4ab`. Veja §10. |
| 4 | Hook installer declarativo, `VersionedCollection`, `writePrivateFileAtomicSync`, digesto de atividade | **PARCIAL — entregue** `8fe4658b`/`b81de9ed`, e os dois itens de porte foram **descartados com evidência**. Veja §11. Restante: hook installer e digesto tocam `src/main/orch/` — **você** |
| 5 | `sqlite-vec` + embeddings sobre o FTS5 que já existe em `workspace-memory.ts` | **DECIDIDO POR MEDIÇÃO — `sqlite-vec` rejeitado**, commit `f4b9bc5e`. Veja §12. Restante bloqueado pela escolha do modelo de embedding (decisão de produto, F-506) |

Nota sobre a Fase 3: **nenhum dos dois projetos tem gerador de cor.** O `theme.ts` do Paseo documenta
o algoritmo em ~80 linhas de comentário (L=0.50/0.70 croma 55-60% do gamut max; dots L=0.62/0.72
croma 90%) mas **não implementa nada** — regeneração é ritual humano, e o único teste de contraste do
repo deles é `identity-colors.test.ts`. O `DESIGN.md` daqui lista hexes finais em tabela Markdown e
já deriva com `color-mix(in oklch/oklab)` (638 ocorrências), mas os hexes base são autorados à mão.
Construir o gerador seria pioneirismo, não catch-up — e `scripts/design-system-sensor.mjs` já é o
lugar natural para o gate.

---

## 9. Se você for commitar agora

- `git add` por arquivo, como o `QA-PROTOCOL.md` manda. **Não use `git add -A`**: além do seu
  trabalho, a árvore tem `.qwen/` (dir da minha sessão) e este handoff.
- `src/renderer/styles/app-shell.css` já contém os 3 fixes do F-335 no HEAD; o seu diff contra o HEAD
  vai mostrar **só** o seu refactor de product-header (110 inserções / 77 deleções). Está correto.
- Seus 3 erros de typecheck em `mission-independent-review-gate.test.ts` vão impedir
  `premake`/`prepackage` de passar até serem resolvidos.
- `npm run lint:oxlint` vai mostrar 47 warnings em `orch/` e 14 em `context/` que já existiam; não
  são regressão sua nem minha.

---

## 10. Fase 3 entregue (commit `001dc4ab`) — e um pedido que depende de você

### O que entrou

- **`src/renderer/styles/palette-gen.ts`** — a doutrina de cor do `DESIGN.md` §2 tornada executável.
  Conversão OKLab/OKLCH, croma máxima de gamut por busca binária, luminância e contraste WCAG, e a
  paleta como bandas de `(lightness, fração de croma do máximo de gamut, hue)`. Puro: sem DOM, sem
  React, sem builtins do node — importável pelo renderer, pelo vitest e por um script tsx.
- **`src/renderer/styles/palette-gen.test.ts`** — 23 testes.
- **`scripts/check-palette-contrast.mjs`** + **`.test.mjs`** — gate, `npm run design:palette-check`.
- **`src/renderer/styles/ui-theme.ts`** — `PALETTES` exportado (+7/-1). Motivo: `--bg`,
  `--bg-elevated` e `--bg-bar` são escritos inline por `applyUiTheme` e **nunca** declarados no
  `base.css`, então qualquer auditoria de contraste tem que lê-los dali.
- `docs/qa/items/F-337.md`, `F-338.md`, `F-339.md`, `F-340.md`.

### O resultado que valida o gerador

Medindo os tokens enviados de volta: pills em **L=0.700, croma 54.7–55.1%** do máximo de gamut; dots
em **L=0.719, croma 89.7–89.9%**. Ou seja, exatamente o `0.70/55%` e `0.72/90%` da doutrina. Uma
busca por **um único hue por família** que reproduz as duas bandas bit-a-bit caiu em
**150 / 27 / 70.5 / 300**, e `generatePalette` reproduz os **7 hexes enviados exatamente**. O teste
assera isso contra o `base.css`, então o gerador é a *fonte* dos tokens, não uma descrição deles —
mexeu numa banda ou num hue, o teste falha.

Croma é fração do máximo de gamut e não valor absoluto porque o gamut é assimétrico: o âmbar esgota
muito antes do vermelho, então cromas absolutos iguais deixam `--status-warning` visivelmente mais
opaco que `--status-danger`. Medido: `maxChromaAt(0.70, 70.5) < maxChromaAt(0.70, 27)`.

### Quatro findings, nenhum corrigido — cada um precisa de decisão

- **F-337 (raiz)** — `--surface-*` é declarado **uma vez** no `:root` (`grep -c "\-\-surface-0:" base.css` → 1),
  não aparece em nenhum bloco `[data-theme=…]` e não está em `UiPalette`. Então no `nexus-light`
  **35 declarações** `var(--surface-*)` renderizam `#080709…#201e25` sobre `--bg #f7f8fb`.
  Decisão: `nexus-light` é tema claro completo (e precisa de surfaces claras) ou é híbrido
  (chrome claro, conteúdo escuro — e aí o `DESIGN.md` §8 é que está errado)?
- **F-338** — a banda escura de status mede **2.32–2.80:1** sobre o fundo claro, contra os **3:1**
  que o `DESIGN.md` §2 afirma. A banda clara já está gerada e o teste confirma que passa
  (`#3e704a #9d433b #7b5d39 #7347af` / `#299f51 #f12e2f #b37824`), mas **aplicar só ela quebraria**
  os sítios onde o status pousa numa `--surface-*` ainda escura. F-337 decide F-338.
- **F-339** — `DESIGN.md` §8 lista **5 temas**; `TERMINAL_THEME_IDS` (`src/shared/settings-types.ts:28-36`)
  tem **7** — faltam `nexus-gray` e `nexus-red` no documento. O código é consistente
  (`PALETTES` 7 chaves, `base.css` 6 blocos + default no `:root`); a defasagem é só do documento.
  **Não corrigi porque `DESIGN.md` tem edições suas não commitadas.** → **é o pedido: acrescente
  `nexus-gray` e `nexus-red` na linha 236-237 quando for commitar o `DESIGN.md`.** O
  `design-system-sensor.mjs` não pega isso porque a lista é prosa, não linha de tabela de token — e
  ampliar o sensor para ler prosa é justamente o que o cabeçalho dele documenta como tendo causado
  bloqueio de merge indevido.
- **F-340** — `--warn #9a6b00` (4.69:1) e `--gold #8a6d00` (4.92:1) não atingem os **≥5.4:1** que o
  comentário logo acima deles afirma, embora ambos passem o AA de 4.5:1. **Não há falha de
  acessibilidade**; o comentário é que promete um piso que vale para metade dos tokens
  (`--ok` 5.41:1 e `--live` 5.57:1 atingem). Escurecer cor enviada para satisfazer um comentário não
  é decisão desta sessão.

### Por que o gate não entrou no `premake`

O cabeçalho do `design-system-sensor.mjs` registra o precedente: uma versão anterior, agressiva
demais, marcou o próprio `DESIGN.md` do projeto e o `merge-validation-coordinator` transformou esse
exit 1 em merge bloqueado. Um gate que o repo não passa é pior que nenhum, porque o jeito mais barato
de passar é enfraquecê-lo. Então: `npm run design:palette-check` sai **0** hoje (as 21 violações do
`nexus-light` são gaps registrados como F-338, não regressões novas), e
`check-palette-contrast.test.mjs` faz o snapshot desse conjunto — se um gap começar a passar, o teste
falha até a entrada ser apagada. O ratchet só aperta.

Estado dos gates depois da Fase 3: `design:palette-check` exit 0 · `lint:oxlint:ratchet` exit 0
(168, inalterado — os 4 arquivos novos somam 0 warnings) · `security:renderer-sinks` 0 sinks ·
70 testes verdes em `src/renderer/styles/` + `scripts/` · `tsc --noEmit` sem erro em nenhum arquivo
desta fase (os 3 do repo continuam sendo os seus).

---

## 11. Fase 4 parcial entregue (commits `8fe4658b`, `b81de9ed`) — e o que decidi NÃO portar

### O que entrou

- **F-406** — `src/main/persistence/atomic-json-file.ts` virou shim de uma linha delegando a
  `src/main/util/atomic-write.ts`. Bytes de saída idênticos, `\n` final incluído.
- **F-407** — `src/main/util/atomic-write.test.ts` criado, 15 testes. O writer canônico **não tinha
  teste co-localizado**, violando o `AGENTS.md`, e é do qual 8 módulos dependem para persistência de
  segredo — incluindo `src/main/remote/remote-device-token-store.ts:53` (tokens de pareamento remoto).

### Por que isso substituiu o porte de `writePrivateFileAtomicSync`

O plano original era portar `packages/server/src/server/private-files.ts` do Paseo (40 linhas,
`0o700` dir / `0o600` file, temp+rename). **Investigar antes de portar mostrou que seria downgrade.**
Comparação real das três implementações que o Nexus já tem:

| Garantia | `util/atomic-write.ts` | `persistence/atomic-json-file.ts` (antes) | `persistence/secrets-store.ts` | Paseo `private-files.ts` |
|---|---|---|---|---|
| dir `0o700` | sim | **não** | sim (`mkdir` + `chmodSync`) | sim |
| temp `O_EXCL` | sim | sim (`'wx'`) | sim | **não** (`writeFileSync`) |
| temp **`O_NOFOLLOW`** | **sim** | não | não | não |
| `fchmodSync` no fd | sim | não | sim | não (`chmod` pós-rename) |
| `fsyncSync` arquivo | sim | sim | sim | **não** |
| **`fsync` diretório** pós-rename | **sim** | não | sim | **não** |

`util/atomic-write.ts` é estritamente superior ao do Paseo. O problema do Nexus não era falta do
primitivo — eram **três implementações com garantias diferentes**, sendo a mais fraca a mais
descobrível: chama-se `writeJsonFileAtomic` e mora em `persistence/` ao lado de `secrets-store.ts`.
Quem vai gravar um token faz grep, acha esse nome nesse diretório, e conclui que é o writer seguro.
Não era. Sem exposição real hoje (`settings.json` não guarda segredo, verificado) — o risco era o
próximo consumidor.

### O que decidi NÃO portar: `VersionedCollection`

O plano pedia o `directory-sync/internal/versioned-collection.ts` do Paseo (141 linhas, zero
acoplamento de domínio: `<T>` genérico com `getId` injetado, seq monotônico com dedup por
fingerprint, tombstones limitados, `generation` por processo). **`src/main/orch/observer-bus.ts` já
implementa o mesmo conceito**, e com contagens comparáveis:

- `seq` monotônico por sessão a partir de 1;
- ring de `OBSERVER_RING_CAP = 1000` frames por sessão;
- `OBSERVER_MAX_SESSIONS = 512` com evicção LRU (a vítima é a sessão mais fria, nunca o buffer de replay);
- `OBSERVER_MAX_SEQ_TOMBSTONES = 4096`, com o comentário explicando exatamente o invariant que o
  `generation` do Paseo também protege: *"a session whose ring was evicted keeps a seq tombstone, so
  reviving it continues the count instead of replaying seq 1 (a backwards seq would…)"*.

A única peça que falta é o `generation`/epoch por processo. E ela **não tem consumidor**: o único
reset do bus é `__resetObserverBusForTests` (`observer-bus.ts:193`), que é só de teste — em produção
não há reset sem restart do app, e restart do main reinicia o renderer junto, então nenhum cliente
sobrevive carregando um cursor de uma geração anterior. Portar 141 linhas para proteger um caso que
não ocorre seria **outra ilha F-405**. Registrado aqui como resultado negativo de propósito: se um dia
o bus ganhar reset em produção, ou um cliente remoto (`src/main/remote/`) passar a consumir frames do
observer com cursor persistente, aí o `generation` passa a ter consumidor e vale implementar.

### Gates depois da Fase 4

`npx vitest run src/main/persistence src/main/util` → **320 testes / 31 arquivos** ·
`npx vitest run src/main/remote src/main/orch/harness-enrich.test.ts` → **198 testes / 34 arquivos**
(os 2 consumidores do shim e os 8 do canônico) · `lint:oxlint:ratchet` 168 inalterado ·
`design:palette-check` exit 0 · `security:renderer-sinks` 0 sinks · `tsc --noEmit` sem erro em
nenhum arquivo destas duas fases.

**Nota sobre o typecheck do repo:** os erros mudaram de lugar enquanto eu trabalhava. Eram 3 em
`src/main/orch/mission-independent-review-gate.test.ts`; agora são **5 em
`src/main/mcp-hub/mcp-hub-spawn.test.ts`**, que é um arquivo **untracked** seu, criado depois da
minha última verificação. Nenhum é meu. `premake`/`prepackage` continuam bloqueados por isso.

---

## 12. Fase 5: `sqlite-vec` rejeitado por medição (commit `f4b9bc5e`)

### Viabilidade foi sondada, não presumida — e o resultado foi o oposto do que eu esperava

Eu tinha dito que precisava "validar `loadExtension` dentro do Electron antes de assumir que
funciona". Sondei: `select sqlite_version()` → **3.53.2**; `typeof db.loadExtension` → `function`;
carregar um caminho inexistente produz `dlopen(...): no such file`, **não** "not authorized". Ou
seja, o carregamento de extensões **está habilitado** no `better-sqlite3 ^12.11.1` e o `sqlite-vec`
carregaria. FTS5 confirmado (`pragma_module_list` + `CREATE VIRTUAL TABLE ... USING fts5`).

**A rejeição é por valor, não por viabilidade.** Cosseno brute-force sobre `Float32Array`
empacotado, top-64 (= `RECALL_CANDIDATE_POOL` de `workspace-memory.ts:56`), dim 384:

| linhas | cosseno top-64 p50 | p95 | bytes de vetores |
|---|---|---|---|
| 1.000 | **0,25 ms** | 0,32 ms | 1,5 MB |
| 10.000 | **2,36 ms** | 2,59 ms | 15 MB |
| 50.000 | **11,78 ms** | 12,63 ms | 73 MB |
| 100.000 | 23,50 ms | 25,55 ms | 146 MB |
| 250.000 | 58,45 ms | 62,09 ms | 366 MB |

Crossover contra 16 ms: **entre 50k e 100k linhas**. Com `MAX_MEMORY_CONTENT_BYTES = 8_192`, 100k
memórias são ~800 MB de texto — muito além de um histórico pessoal de agentes. Uma extensão de índice
compraria busca sub-linear na casa dos **milhões**, ao custo de um binário por plataforma, um
`loadExtension` em toda abertura de banco e um modo de falha novo na partida, dentro do caminho do
`rebuild:electron`.

### O que entrou

`scripts/benchmark-vector-retrieval.mjs` + `.test.mjs` (5 testes) + `npm run bench:vector-retrieval`.
Constrói um banco descartável com o **schema real** de `workspace-memory.ts` (`memories` +
`memories_fts` de conteúdo externo + trigger `ai`), WAL, `busy_timeout 5000`, `synchronous NORMAL`,
modos `0o700`/`0o600` — os mesmos do produto — e cronometra a **consulta real de recall**
(`bm25(memories_fts)` + `JOIN` + `superseded_by IS NULL` + `ORDER BY rank LIMIT 64`).

As duas metades são **independentes de propósito**. `rebuild:node` e `rebuild:electron` são operações
normais aqui, e o ABI **flipou no meio desta sessão** (`NODE_MODULE_VERSION 148` contra `127` do Node,
mtime do `.node` a um minuto da falha). Um mismatch agora reporta `lexical.unavailable` **com a
causa** em vez de derrubar a execução; o teste assera essa propriedade em qualquer estado de ABI.
**Não rodei `rebuild:node`** para recuperar a medição — viraria o ABI de volta sob você.

O teste inclui uma prova de que o veredito é calculado e não hardcoded: com
`VECTOR_BENCH_BUDGET_MS=0` ele inverte.

### Ressalva que você precisa conhecer antes de citar qualquer número de bm25

Uma varredura anterior mostrou o recall bm25 **2-3× mais lento** que o cosseno (100k linhas: 109 ms
p50 / 332 ms p95 contra 31 ms). **Esses números não valem.** O corpus tinha 24 palavras distintas, o
que é patológico para FTS5 — vocabulário pequeno dá posting list longa para todo termo, então `MATCH`
custa muito mais do que custaria com texto natural. Corrigi o gerador para 2.000 termos com skew Zipf
(`VECTOR_BENCH_VOCAB`), mas **não consegui re-medir** por causa do flip de ABI.

Então: **a observação "o gargalo é o FTS5, não o canal vetorial" NÃO está estabelecida.** A direção do
viés é conhecida (vocabulário realista torna o FTS5 mais rápido, logo a afirmação está inflada), mas
quem quiser usá-la precisa re-medir com `VECTOR_BENCH_VOCAB=2000` num checkout em ABI de Node.
**O veredito sobre `sqlite-vec` não depende disso** — a metade vetorial é JS puro e foi medida em
todas as escalas.

### Por que nenhum store vetorial foi escrito

Sem modelo de embedding decidido, qualquer módulo de store/ranking/blend nasceria **sem consumidor** —
exatamente o F-405: quatro módulos testados, verdes no CI, zero call sites em produção. O benchmark
foi entregue em vez disso porque **tem consumidor real**: quem for decidir sobre índice vetorial agora
mede em vez de achar.

### O que bloqueia o resto, e o que já está resolvido

**Resolvido:** o runtime. `onnxruntime-node ^1.19.2` **já é dependência e já está em
`scripts/rebuild-electron-natives.mjs:23,25`**, e o projeto já roda inferência ONNX em produção num
pipeline de 3 estágios (`src/main/voice/wake-engine.ts:53-58`, incluindo um `embedding_model.onnx`).
Nenhuma dependência nativa nova é necessária.

**Em aberto (F-506, `precisa-decisao`):** o modelo de texto. Três caminhos, todos com precedente no repo:

1. **ONNX commitado em `resources/`** — precedente: `resources/wake/ei-jarvis-ptbr.onnx`, versionado e
   empacotado (aparece em `out/NexusIDE-darwin-arm64/.../Resources/wake/`). Offline desde a primeira
   execução; custa tamanho de repo e pacote (~20-30 MB um MiniLM quantizado).
2. **Pacote npm extraído para `~/.nexus/models/`** — precedente: `src/main/vision/ocr-language-data.ts:25-32`
   resolve `@tesseract.js-data/{eng,por}` e copia para `models/tesseract/<DATASET_VERSION>`, com o
   versionamento no caminho. Não infla o repo.
3. **API remota** — rejeitado por padrão, não por preferência: `workspace-memory.ts:342` aplica
   `redactSecretText` antes de persistir e existe `src/main/memory/trusted-memory.ts`, então o projeto
   trata conteúdo de memória como sensível. Se for considerado, opt-in explícito e pela mesma redação.

Sub-decisão que vem junto: **o modelo tem que ser multilíngue.** O produto opera em PT-BR e um modelo
só-inglês ranqueia mal memória em português — o que descarta o MiniLM padrão e encarece a opção 1.

### Gates depois da Fase 5

`benchmark-vector-retrieval.test.mjs` + `check-palette-contrast.test.mjs` → **11 testes verdes** ·
`lint:oxlint:ratchet` → **168, inalterado** (o ratchet pegou um `preserve-caught-error` no próprio
script novo — rethrow sem `{ cause }` — que foi **corrigido** em vez de o número ser aumentado) ·
`design:palette-check` exit 0 · `security:renderer-sinks` 0 sinks · nenhum arquivo de `src/` tocado
nesta fase, então `tsc --noEmit` não é afetado por ela.



