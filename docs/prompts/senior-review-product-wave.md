# Senior Code Review — Nexus IDE product wave (Grok session)

## Contexto

Você é um **staff/principal engineer** fazendo **code review sênior adversarial** (não um summary amigável). O objetivo é achar bugs reais, falhas de segurança, wiring morto, regressões de multi-workspace, e overclaim de "produto pronto".

| Campo | Valor |
|-------|--------|
| **Repo** | nexus-ide (Electron + React + TypeScript) |
| **Branch** | `fix/claude-family-zero-click` |
| **Base sugerida** | `main` / `origin/main` |
| **Prompt path** | `docs/prompts/senior-review-product-wave.md` |

### Commits principais deste trabalho (antigo → novo)

```
b994d98 feat(product): enable full product wave by default and wire end-to-end
59bfdf5 fix(product): senior review remediations for full product wave
520a5ad test(product): cover symlink escape and scoped search IPC binding
18ca041 fix(ui): restore app body layout and mount progressive onboarding
57794c1 feat(terminal): CommandBlock Cmds menu on pane toolbar
239e9ab fix(product): senior review remediations through product wave
46a5306 fix(product): force all flags on for unpackaged dogfood and scope pane recovery
```

**Escopo do review:** esses commits e o diff associado. Se achar acoplamento perigoso com commits de orch/intent-first logo abaixo na branch, mencione — mas o foco é o product wave + o force-flags + recovery de pane por scope.

### Escopo estreito (opcional)

Se o budget de contexto for baixo, adicione no topo da sessão:

```text
ESCOPO ESTREITO: revise apenas `46a5306` e arquivos tocados; use o resto da branch só como contexto.
```

### Comandos de setup

```bash
git fetch origin
git log --oneline origin/main..HEAD
git diff origin/main...HEAD --stat
# foco product wave:
git show 46a5306 --stat
git show 239e9ab --stat
git show b994d98 --stat
```

---

## O que foi implementado (claim do autor — valide, não confie)

Product wave clean-room (inspirado em Warp/BridgeMind, **sem copiar AGPL**):

1. **Feature flags** (`src/shared/feature-flags.ts`, `src/main/feature-flags/feature-flag-registry.ts`)
   - 10 flags de produto com `defaultEnabled: true`
   - `forceEnableAll()` limpa kill switches + override ON
   - `enableAllProductFlagsForTesting()` no bootstrap de `main.ts` quando `!app.isPackaged` **ou** `NEXUS_FORCE_ALL_FLAGS=1`
2. **CommandBlock + OSC133** (terminal semantic blocks)
3. **Mission event journal** (append-only + cursors/ACK)
4. **SearchMixer** (debounce, cancel, generation, ranking)
5. **Scoped workspace FS** (path traversal / symlink escape)
6. **Contextual panel** + persistência
7. **Progressive onboarding** + mode launcher
8. **MCP hub** (incl. rollback IPC reclamado)
9. **Skills catalog**, **nexus-memory**, **autonomy profiles**
10. **Agent lifecycle reap**
11. **Editor workspace model** (CM6 deferred — textarea path)
12. **Último fix de orch:** `hasMirroredScope` em `mission-driver-io.ts` + `pane-registry` propaga `scope` no snapshot (evita recovery cross-project)

---

## Como revisar (obrigatório)

### 1. Threat model / security

- Path traversal, symlink escape, `startsWith` em paths (prefix trap)
- IPC handlers: validação de input, authz, capability, escopo de projeto
- Editor open / skills scan / `$HOME` scan — ainda há leak fora do workspace?
- Feature flags: `forceEnableAll` em unpackaged é aceitável? risco se alguém empacotar errado e `isPackaged=false`? `NEXUS_FORCE_ALL_FLAGS=1` vaza para prod?
- Secrets em logs/errors; SSRF em MCP/search; command injection no terminal/blocks
- FS writes (memory, skills, panel persist) atômicos? race? permissões?

### 2. Correctness / multi-workspace

- `hasMirroredScope` + `sameProjectScope`: edge cases (scope undefined, missionId em pane de outro projeto, race no first paint)
- `listPaneSnapshots` / recovery: ainda pode matar ou recriar pane errado?
- SearchMixer generation/cancel: stale results UI?
- Mission journal: crash mid-write, cursor corruption, replay idempotency
- Agent lifecycle reap: mata processo vivo? orphan?

### 3. Wiring real (anti-theater)

Para **cada** flag/feature, prove:

- Existe IPC registered no main?
- Preload expõe canal?
- Renderer consome?
- Flag gate está no caminho real (não só default true + código morto)?
- Testes cobrem o path de produto, não só unit puro?

Marque cada feature como: **WIRED** | **PARTIAL** | **DEAD** | **UNPROVEN**

### 4. Flags / dogfood

- Defaults `true` + force enable: coerente com "não está em produção"?
- Kill switch ainda funciona depois de `forceEnableAll`?
- Overrides persistidos vs force in-memory: quem ganha no próximo boot?
- Em app **packaged** (`/Applications/NexusIDE.app`), flags force **não** ligam — isso é bug ou intencional para o dogfood do usuário?

### 5. Tests & gaps

- O que os testes **não** cobrem?
- Falsos verdes (mocks que escondem wiring)?
- E2E / package smoke: o que falta?

### 6. Product / UX regressions

- Progressive onboarding montado sem quebrar layout do app body?
- Contextual panel persist corrompe state?
- CommandBlock toolbar não quebra panes existentes?

---

## Formato da saída (obrigatório)

### A) Veredito

`APPROVE` | `APPROVE WITH NITS` | `REQUEST CHANGES` | `REJECT`

### B) Findings (ordenados por severidade)

Para cada finding:

- **ID:** F1, F2…
- **Severidade:** CRITICAL / HIGH / MEDIUM / LOW / NIT
- **Título**
- **Arquivo:linha** (ou range)
- **Por que é bug/risco real** (não estilo)
- **Repro / cenário**
- **Fix sugerido** (mínimo, concreto)
- **Confiança:** alta/média/baixa

### C) Feature wiring matrix

Tabela: feature | flag id | main | preload | renderer | tests | status

### D) Residual risks / known incompletes

Inclua se ainda for verdade: CM6 deferred, OAuth MCP, E2E, package smoke, etc. Desafie qualquer claim "done".

### E) Diff do último commit (`46a5306`) — review focado

Especial atenção a:

- `forceEnableAll` / `enableAllProductFlagsForTesting`
- bootstrap em `main.ts`
- `hasMirroredScope` + uso em `paneDead`
- `pane-registry` snapshot scope merge order (`sessionScope` vs `meta` — quem sobrescreve?)

### F) Top 5 ações antes de merge

Lista priorizada, objetiva.

---

## Regras de rigor

- **Não** elogie genérico. Zero fluff.
- **Não** invente arquivos — leia o diff.
- Prefira findings com **repro** e **impacto**.
- Se algo parece ok, diga **PASS com evidência** (arquivo:linha).
- Se não conseguir provar wiring, marque **UNPROVEN**, não WIRED.
- Separar: bug de produção vs dívida de dogfood/dev.
- Lembre: app **não está em produção**; flags ON em unpackaged é intencional — critique se o mecanismo for perigoso no **packaged** build, não o dogfood em si.

---

## Comandos úteis

```bash
# testes do wave de flags / shared
npx vitest run src/main/feature-flags src/shared/feature-flags.test.ts src/main/orch/mission-driver-io.apply.test.ts

# grep de wiring
rg -n "FEATURE_FLAG_IDS|isEnabled\(|enableAllProductFlags|forceEnableAll|hasMirroredScope|registerProductWaveIpc|registerSearchMixerIpc" src

# IPC channels
rg -n "product-wave|search-mixer|command-block|contextual-panel|mcp-hub|skills|nexus-memory|autonomy" src/shared src/preload src/main
```

---

## Início

Comece lendo o diff e a matrix de wiring. Só depois escreva findings.
