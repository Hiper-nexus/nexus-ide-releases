# Handoff — NexusIDE 0.19.32 (sessão de 27–28/07/2026)

**Objetivo original:** rodar testes, testar em dev, notarizar e publicar a
release. **Estado:** build assinado e notarizado pronto, gate E2E ainda não
passou, **nada publicado**. Última release pública continua sendo a **0.19.30**.

---

## 1. A descoberta que justifica a sessão inteira

O operador relatou: *"quase um mês e nunca consegui usar o Nexus, nunca fiz uma
feature nele."*

**Causa encontrada:** o worker governado **não conseguia commitar** dentro do
worktree isolado. Um worktree vinculado guarda só um `.git` de uma linha; os
objetos, refs e reflogs do commit vão para o **repositório pai**, que fica fora
da raiz de execução do worker. O perfil Seatbelt negava, e o commit morria com
`Operation not permitted`. O agente então — corretamente — se recusava a forjar
repositório ou reportar sucesso sem commit, e a missão bloqueava **com o
arquivo já criado e verificado**.

Do lado do usuário isso aparece como *"mandei fazer e não saiu nada"*.

Não é regressão recente: é anterior, e explica por que a 0.19.31 também ficou
retida no gate. O gate estava certo — recusava publicar um produto que não
entregava.

Reproduzido fora do app com `sandbox-exec` e worktree real; mensagem idêntica.

---

## 2. O que foi feito (commitado)

Commits à frente de `origin/main` (que está em `af1e25f1`):

| Commit | O quê |
|---|---|
| `ab8bea25` | spikes CDP: limpa device-metrics override, harness de missão rápida |
| `96f7e714` | docs de análise |
| `87459777` | fronteira de readiness reconhece a lane advisory read-only |
| `62700e1c` | bump 0.19.32 (package/server/lock/CHANGELOG/release-notes) |
| `f4ef40ab` | **worker volta a commitar no worktree isolado** |
| `2548535c` | **todo CLI do squad roda confinado pelo kernel** |
| `611102e9` | texto da release |
| `38178784` | staging do kimi leva `config.toml` |
| `8a8e8daf` | **participação advisory derivada da capacidade, não de allowlist** |

### 2.1 Autoridade git do worktree (`linked-worktree-git-paths.ts`)

Descoberto por iteração, cada erro confirmando o anterior:

1. sem escrita → `index.lock: Operation not permitted`
2. com escrita, sem leitura → `fatal: not a git repository`
3. leitura parcial → `Invalid path '<repo>/.git'`
4. **forma final** → commit conclui

Conjunto medido contra Seatbelt real:
- **leitura**: o `.git` do repo pai inteiro (git precisa listá-lo para resolver)
- **escrita**: gitdir do worktree + `objects` + `refs` + `logs` (+`packed-refs`)
- **protegido**: `hooks/` e `config` explicitamente carvados fora — um daria
  execução de código arbitrário no host, o outro reescreveria remotes/filters

Verificado: commit conclui **e** escrita nesses dois segue negada.

### 2.2 Lane advisory com confinamento do kernel (`advisory-process-sandbox.ts`)

O dispatch recusava `read_only` para CLI sem barreira mecânica verificada. Em
vez de afrouxar, o Nexus passou a **fornecer** a barreira: aplica o próprio
perfil Seatbelt em volta do advisor.

- raiz de execução montada **somente-leitura pelo kernel**
- única área gravável: o HOME privado que o overlay MCP já cria por sessão
- **rede aberta** (`workspace-net`) — decisão de produto: a fronteira que
  importa para um conselheiro é ESCRITA; ele é rotineiramente mandado ler a
  referência que o operador jogou no meio da missão
- **fail-closed**: sem confinamento construível o spawn aborta, nunca degrada

Camadas que precisaram conhecer a lane: `squad-runtime-policy` (readiness),
`mission-scheduler-dispatch-transaction` (dispatch), `pty-manager` (spawn).
`mission-task-plan-authority`, `guided-mission-planner`,
`task-dispatch-claim-authority` e `real-mission-e2e-participation` já conheciam.

### 2.3 Participação derivada, não enumerada

Motivação do operador: *"amanhã outro cliente vai usar outras CLIs"* e *"tenho
Qwen 3.8 no Qoder, vou usar também"*.

Regra em dois níveis, ambos técnicos:
- **pode aconselhar**: quem NÃO se confina sozinho (codex/grok usam o próprio)
- **pode participar**: quem tem rota de handoff físico
  (`handoffCapableCliIds`, novo na política) — sem ela a CLI conversa mas nunca
  prova o que fez

Verificado com um id inexistente: `supportsAdvisoryParticipationCli('qwen')`
retorna `true`. CLI nova entra sem editar código.

### 2.4 Três detecções de login que mentiam

- **claude**: staging só copiava `oauthAccount` se fosse **string**; num perfil
  real é **objeto** (`{emailAddress}`). O campo que o probe lê sumia. O teste
  não pegou porque modelava o formato errado — validava contra uma ficção.
- **agy**: probe procurava `~/.gemini/antigravity`, que é diretório de
  **instalação**, não credencial. Agora `oauth_creds.json` vem primeiro.
- **kimi**: recebia credencial sem `config.toml` → `[config.invalid] Model ...`

### 2.5 Números

- typecheck limpo
- **8039 testes / 949 arquivos**, todos passando
- `npm run release:security`: **0 vulnerabilidades** (o bloqueio histórico do
  `brace-expansion` não aparece mais)
- build assinado (Developer ID `35P5XL3JN6`) e **notarizado pela Apple**

---

## 3. Commit da continuidade (pós-`8a8e8daf`)

Working tree anterior foi commitada nesta retomada. Inclui:

1. **Roster E2E selado** (`preserveExactCliAssignments` no squad do gate) —
   evita rebalance silencioso que quebrava o binding → `observer-invalid`.
2. **Reviewers/scouts selados** em `balanceSquadRosterCli` (qualificação na UI,
   não no rebalance).
3. **Diagnóstico** em `real-mission-e2e.ts` + `validateHarnessAdvisorAdapters`
   respeita `NEXUS_REAL_MISSION_ADVISOR_SKIP`.
4. **Pré-autorização squad+projeto** (`mission-approval-trust.ts` + checkbox
   no modal; desligada no gate E2E).
5. **Mensagem Claude honesta** em `MissionWizardReview` (auth ≠ sem
   qualificação).
6. **Kimi**: staging de `device_id` + `oauth/kimi-code`; default `kimi-code/k3`.

**Próximo passo:** árvore limpa → `make:release` (~25 min) → `release:candidate`
(com `NEXUS_REAL_MISSION_ADVISOR_SKIP` se aplicável) → só então `release:publish`.
O build anterior em `out/` aponta para `8a8e8daf` e fica **stale** após este commit.

---

## 4. Estado exato para retomar

- **HEAD**: `8a8e8dafe649`
- **tag `v0.19.32`**: existe local, **NÃO** enviada (aponta para o HEAD do
  build atual; se commitar mais, **recriar**)
- **origin/main**: `af1e25f1` — 9 commits atrás, sem divergência (push será
  fast-forward)
- **build**: `out/make/NexusIDE-0.19.32-arm64.dmg` + ZIP, assinado/notarizado,
  recibo em `release-artifacts/candidate-build.json` casando com `8a8e8daf`
- **`gh`**: autenticado, ADMIN nos dois repos

### Runtime obrigatório

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"   # Node 22.23.1 exato
```

`package.json > nexusRelease.node` exige **22.23.1**. Node 26 quebra o make
silenciosamente.

### Sequência canônica

```bash
# 1. árvore limpa é obrigatória (até untracked)
test -z "$(git status --porcelain=v1 --untracked-files=all)"

# 2. tag sobre HEAD
git tag -d v0.19.32; git tag -a v0.19.32 -m "NexusIDE v0.19.32"

# 3. wrapper de retry do codesign (TSA da Apple derruba rajadas)
mkdir -p scripts/codesign-retry-bin
ln -sf ../codesign-with-retry.sh scripts/codesign-retry-bin/codesign

# 4. build assinado + notarizado (~25 min)
caffeinate -i env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD \
  NEXUS_MAC_PUBLISH_RELEASE=1 APPLE_TEAM_ID=35P5XL3JN6 \
  APPLE_KEYCHAIN_PROFILE='nexus-notary' \
  PATH="$PWD/scripts/codesign-retry-bin:$PATH" \
  npm run make:release

# 5. gate: verificação + missão real (até 32 min)
caffeinate -i env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD \
  NEXUS_MAC_PUBLISH_RELEASE=1 APPLE_TEAM_ID=35P5XL3JN6 \
  APPLE_KEYCHAIN_PROFILE='nexus-notary' \
  NEXUS_REAL_MISSION_ADVISOR_SKIP=agy,opencode,claude \
  npm run release:candidate

# 6. publicar (só se o gate passar)
caffeinate -i env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD \
  NEXUS_MAC_PUBLISH_RELEASE=1 APPLE_TEAM_ID=35P5XL3JN6 \
  APPLE_KEYCHAIN_PROFILE='nexus-notary' \
  npm run release:publish

# 7. devolver o ABI de Node ao desenvolvimento local
npm run rebuild:node
```

**Mac desbloqueado**: keychain recusa com tela bloqueada
(`No Keychain password item found`).

---

## 5. PENDÊNCIAS

### 5.1 Bloqueiam a publicação

**Gate E2E nunca passou.** Melhor resultado obtido:
`panes=2 dispatches=1 handoffs=1` — executor nasceu, trabalhou e submeteu
handoff; parou no commit (corrigido depois, não revalidado end-to-end).

Falhas por rodada, em ordem de progresso:
1. `claude-worker` → readiness sem lane advisory (**corrigido**)
2. `worker-unavailable: agy/claude` → detecção de auth (**corrigido**)
3. `mission-blocked` → commit negado pelo sandbox (**corrigido**)
4. `read_only_unsupported: kimi` → dispatch sem lane (**corrigido**)
5. `observer-invalid` em `product-wizard-ready` → **NÃO diagnosticado**

**#5 atacada no commit de continuidade** (roster selado + adapters respeitam skip + logs de razão). **Ainda falta revalidar no gate** assinado (`make:release` + `release:candidate`).

### 5.2 Pedidas pelo operador, não feitas

**Modal de aprovação → pré-autorização.** **Implementado** (`mission-approval-trust`: uma vez por squad+projeto; checkbox no modal; E2E force-disabled). Ainda falta prova no produto assinado.

Não é apagar a tela: o modal **produz o `approvalReviewSha256`**.
`orch-ipc.ts` chama `confirmMissionAuthorityChange`, recebe o hash do que foi
exibido, revalida o `fence` (`approval_stale` se algo mudou com o diálogo
aberto) e passa o recibo a `approveIntentFromRenderer`. O hash entra no
contrato selado e é reconferido (`contract.approvalReviewSha256 !== expected`
derruba a missão).

**O caminho já existe**: missões de cron rodam sem modal —
`cron-execution-authority.ts` compila com `source:'automation'` e
`executionMode:'autopilot'`, sem recibo; o campo é `.optional()` em
`mission-intent.ts`.

Desenho acordado: aprovar **uma vez por squad+projeto**, reusar enquanto roster
e projeto não mudarem, modal volta quando o roster muda. Atenção: o recibo muda
de semântica ("vi este objetivo" → "confio neste squad") e a evidência precisa
registrar que foi autorização por delegação.

Opções dadas ao operador: (1) pré-autorização completa ~40 min; (2) apenas
"não perguntar de novo" ~20 min e menos risco; (3) publicar sem mexer.

### 5.3 Defeitos conhecidos, não corrigidos

- **Claude advisor não qualifica** no wizard: *"não possui essa qualificação
  nesta release"*. A correção do `oauthAccount` era necessária mas insuficiente.
  Rastrear `isAdapterModelAuthenticated` → `authReadyModels` →
  `authDecision`. Suspeita: modelo do roster não casa com a rota de
  subscription, deixando `authStrategy = login-needed`.
- **Agy**: probe corrigido, **não revalidado** end-to-end.
- **Mensagem enganosa** (auth vs qualificação): **corrigida** no commit de continuidade; permanece a suspeita de modelo/subscription do Claude ainda cair em `login-needed`.
- **Pane do Kimi renderiza duplicado**. O quirk `altScreen` já está declarado
  (igual às outras), então a causa é outra.
- **`omp-rpc` ainda hard-coded** em `mission-advisory.ts`. Idealmente derivar
  de `kind !== 'cli-pty'` lendo o adapter.

### 5.4 Documentação preparada, não aplicada

`scratchpad/doc-missao-assinada-PENDENTE.md` tem o texto pronto para:
- corrigir o header **obsoleto** de `scripts/spikes/e2e-real-mission-fast.mjs`
  (promete iterar sem assinatura — **falso** desde o hardening Darwin de 27/07)
- acrescentar seção de diagnóstico em `build/notarize.md`

---

## 6. Armadilhas que custaram tempo (não repita)

1. **`npm run package` NÃO prova nada.** Assinatura ad-hoc sem Team ID: o
   supervisor PTY do Darwin recusa o spawn **e** o app não lê o keychain (o que
   derruba `claude` e `agy`, cujo segredo vive lá). Só `make:release` +
   `release:candidate` provam. O spike `e2e-real-mission-fast.mjs` ficou
   obsoleto.
2. **A causa real do bloqueio não está no stderr.** Está na `description` da
   missão, no banco:
   ```bash
   sqlite3 "$USERDATA/project-runtime/projects/project-*/checkout-*/runtime.sqlite3" \
     "SELECT description FROM missions LIMIT 1;"
   ```
   O erro `project-scoped domain stores are not initialized` que aparece no
   stderr é **efeito do shutdown**, não causa — vem depois do FAIL.
3. **O log do gate fica mudo** quando o app trava na tela de revisão. As pistas
   decisivas vieram do operador lendo a tela. Se o gate parar com log de 4
   linhas e o app vivo, **peça o que a tela diz**.
4. **Qualquer commit invalida o build**: o gate exige que o recibo case com o
   HEAD (`candidate build receipt provenance is stale`). Commitou? Rebuild.
5. **Árvore limpa inclui untracked.** Um repo git vazio chamado `NEXUS IDE/`
   apareceu na raiz e derrubou o gate.
6. **Versão em 5 lugares**: `package.json`, `server/package.json`,
   `package-lock.json` (raiz **e** `packages.server`), `CHANGELOG.md`
   (`## X.Y.Z — `) e `CURRENT_RELEASE` em `src/shared/release-notes.ts`.
   Validar com `scripts/release-authority.mjs`.

---

## 7. Direção de produto declarada pelo operador

Registrada porque orientou várias decisões desta sessão:

- **"Rigor no código que sai, leveza na ferramenta que opera."** As regras que
  moldam o código gerado (Carta de Design anti-slop, `bridgesecurity`,
  `check-work`, ownership) ficam. O atrito operacional deve cair.
- **O Nexus é olhos e braços de um viber coder.** Precisa ser livre: mandar uma
  referência no meio da missão e o orquestrador distribuir às CLIs. Foi por
  isso que a rede do conselheiro voltou a ser aberta.
- **Mais CLIs = menos token e código melhor.** Cada modelo tem preço e viés
  diferentes; um revisor de outro modelo pega o que o executor não vê.
- **Referências**: Orca e Overclock, que têm o mínimo atrito possível. O que o
  Nexus tem a mais — e deve manter — é a **prova** de que o trabalho aconteceu.

---

## 8. Resumo de uma linha

O bug que impedia qualquer missão de entregar foi encontrado e corrigido com
prova; a lane multi-CLI foi implementada e generalizada; correções de continuidade (roster/trust/Kimi/mensagem) estão commitadas; **falta rebuild + gate E2E passar** e publicar.
