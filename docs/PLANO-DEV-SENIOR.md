# Plano — Nexus como Dev Sênior para Não-Desenvolvedores

> Tese: o operador do Nexus NÃO valida código. Ele confia cegamente na LLM.
> Portanto o Nexus é quem precisa ser o dev sênior responsável: entende o
> projeto desde o início da missão, evita função órfã / código duplicado /
> stack antiga / brecha de segurança, revisa tudo que os workers produzem e
> entrega um laudo em linguagem humana. De landing page simples a SaaS
> complexo, sem nenhuma trava manual no caminho do operador.

Status: proposta (2026-08-22). Base: v0.65.0, motor Via Rápida único.

---

## 1. Diagnóstico — o que o sistema JÁ É (forte; não reconstruir)

| Capacidade | Onde vive | Estado |
|---|---|---|
| Motor de missão único (Via Rápida): 1 terminal interativo por agente, conclusão observada busy→idle, Retomar adota panes vivos | `src/main/orch/mission-fast-lane.ts`, `mission-engine*.ts` | Vivo, maduro (0.63–0.65 cortaram as raízes de travamento) |
| Cerimônia antiga | — | **Deletada** (SWEEP-NOTES 2026-08-10); merge queue sobreviveu dentro de `worktree-runtime-registry` (`nexus_worktree_create/get`, `nexus_merge_status`) |
| Contexto estrutural do projeto: índice de símbolos, import graph, blast radius, code map exposto ao agente | `src/main/context/orientation/*`, `src/main/orch/tools-code-map.ts` | Vivo |
| Memória persistente FTS5 + memória confiável (`trusted:`) no recall automático | `src/main/memory/workspace-memory.ts`, `trusted-memory.ts` | Vivo; consolidação `reflect()` pendente (documentada) |
| Bootstrap greenfield: map → scaffold → propose → quorum review → apply → commit; brief aprovado não inventa stack | `src/main/context/context-bootstrap-autopilot.ts`, `src/main/runtime/guided-greenfield-brief.ts` | Vivo |
| Sensores de qualidade (rodam scripts do projeto-alvo): typecheck, unit, dead-code, duplication, api-similarity, coverage | `src/main/context/context-doctor.ts` (linhas ~202–231), `sensor-broker.ts` | Vivo, mas **condicional** (ver §2.2) |
| Gate de revisão independente com vereditos estruturados `[VALIDADA]/[REPROVADA]` antes de heurística | `src/main/orch/mission-independent-review-gate.ts`, chamado em `mission-engine-production.ts:45` | Vivo |
| Scanner determinístico de qualidade do diff (dead code, duplicação, limites de budget) + revisor CLI automatizado em worktree destacado | `src/main/context/candidate-quality-scanner.ts`, `candidate-quality-analysis.ts`, `cli-automated-reviewer.ts`, `detached-review-worktree.ts` | **Construído e testado, mas órfão** — nenhum caller vivo fora de testes após a varredura cerimonial |
| Task router com tiers/especialidade (visual/security…), circuit breakers, ranking por benchmark | `src/main/orch/task-router.ts`, `route-pipeline.ts`, `src/main/eval/*` | Vivo |
| Sandbox real: Seatbelt/Bubblewrap/OCI, supervisor nativo darwin, worktrees CoW, HOME efêmero | `src/main/pty/*`, `src/main/runtime/process-sandbox.ts` | Vivo |
| MCP ~140 tools com skill-gate fail-closed, handoff físico one-shot, delivery evidence | `src/main/orch/mcp-server.ts`, `tools-handoff.ts`, `worker-delivery-evidence.ts` | Vivo |

## 2. O furo central (por que hoje ele NÃO é o dev sênior do leigo)

### 2.1 A revisão é opcional exatamente no modo que o leigo usa

`mission-independent-review-gate.ts` — `isCivilianViaRapidaReviewExempt()`:

- `mode === 'guided'` ou missão `legacy` → exige revisão independente.
- **`mode === 'livre'` ou `freeAgentChoice === true` → ISENTO de revisão.**
- Só lanes `standard`/`ops` com squad chegam ao gate.

Ou seja: o fluxo civil fecha "board N/N + arquivos + handoffs" sem nenhum
revisor. Para um dev experiente isso seria aceitável; para o público-alvo
(não-valida nada) é o oposto da promessa.

### 2.2 A rede de segurança depende do próprio projeto-alvo

Os sensores do context-doctor só são scaffoldados se o `package.json` do
projeto **já tiver** scripts `typecheck/test/dead-code/duplication/coverage`
(`context-doctor.test.ts`: "scaffolds senior quality gates only for explicit
project scripts"). Projeto greenfield nasce sem nada — quem criaria esses
scripts? A própria LLM, sem ser obrigada. Resultado: missões em projetos novos
podem concluir sem UMA verificação mecânica.

### 2.3 A maquinaria de qualidade determinística ficou órfã

O scanner determinístico + revisor CLI automatizado existem, têm testes, mas
ficaram sem caller quando o motor cerimonial foi deletado. Hoje a única
revisão viva é a do agente reviewer (LLM revisando LLM) — e só nos modos
guiados.

### 2.4 Não há doutrina de stack nem laudo humano

- Nada impede worker de introduzir lib deprecated/stack morta; o
  `guided-greenfield-brief` deliberadamente **não escolhe stack** (bom para
  flexibilidade, péssimo sem contrapeso).
- As evidências (sensores, verdicts, screenshots de preview, delivery
  evidence) existem espalhadas, mas não há projeção final "laudo" para o
  operador leigo entender o que foi entregue.

## 3. Princípios invioláveis — o que este plano NÃO pode ter

Estas travas estão PROIBIDAS (o operador não sabe sair delas):

1. **Nunca bloquear início de missão** por readiness/auth/modelo/conta
   (doutrina 0.60+: capacidade ordena, não filta — manter).
2. **Nunca exigir edição manual** de `.context/policy.json`, squads.json,
   env vars ou qualquer config pelo usuário leigo. Toda política tem default
   correto out-of-the-box.
3. **Nunca pedir revisão de diff/código ao operador.** Aprovação dele é
   objetivo e critérios, não código.
4. **Nunca recriar segundo motor/cerimônia.** Um caminho só; qualidade entra
   DENTRO da Via Rápida como etapa observada, não como fila paralela.
5. **Falha se NOMEIA e oferece 1 botão** (padrão das releases 0.63–0.65):
   reprovação vira ciclo de reparo automático; só escala ao operador em
   linguagem simples após esgotar tentativas.
6. **Sem dependências externas pagas novas** (sem serviço de embeddings,
   sem SaaS de análise). Reusar FTS + scanners locais + CLIs já suportados.
7. **Não engessar stacks legítimas**: doutrina recomenda, scanner detecta;
   nada de allowlist fechada que impeça um stack válido.

## 4. Etapas

Cada etapa entrega valor sozinha e é verificável com `tsc --noEmit` + vitest
focado + smoke de missão real.

### Etapa 1 — Revisão Sempre-On invisível (o coração) 🔴

**Problema:** §2.1 e §2.3.
**Mudança:**

1. Inverter a isenção: `isCivilianViaRapidaReviewExempt` deixa de isentar
   missões civis de *ter* revisão — a revisão passa a ser automática e
   invisível (reviewer roda em background; o operador nunca vê um passo
   "revisão", vê só o resultado no laudo da Etapa 5). Guided mantém o
   comportamento atual.
2. Re-ligar a maquinaria órfã no caminho de conclusão da fast lane:
   - `candidate-quality-scanner` roda deterministicamente antes do reviewer
     (critical/high bloqueiam promoção — comportamento já implementado);
   - `cli-automated-reviewer` em worktree destacado como reviewer
     independente quando o squad não trouxer reviewer (fallback main-owned);
   - veredito `[VALIDADA]/[REPROVADA]` por story alimenta o gate existente
     `assertIndependentReviewForDone`.
3. Reprovação → marker `[NEXUS_QUALITY_REPAIR]` (caminho vivo) com limite de
   N=2 ciclos; esgotou → missão bloqueia VISIVELMENTE com resumo em linguagem
   natural dos findings + botão "Retomar com ajuste".

**Arquivos-alvo:** `orch/mission-fast-lane.ts`, `orch/mission-independent-review-gate.ts`,
`context/cli-independent-review-policy.ts`, `context/candidate-quality-review.ts`.
**Pronto quando:** toda missão livre concluída tem registro de scanner +
veredito; reprovação abre reparo sozinha; zero passos novos visíveis ao
operador em missão verde.

### Etapa 2 — Rede de segurança universal (sensores garantidos) 🟠

**Problema:** §2.2.
**Mudança:**

1. Missão cujo contrato cria/modifica projeto Node garante, como parte do
   escopo (não como trava): scripts mínimos `typecheck` + `test` no
   package.json. O scaffold do context-doctor já sabe consumi-los depois.
2. Sensor determinístico Nexus-owned que NÃO depende de script do alvo:
   - `tsc --noEmit` quando existe `tsconfig.json`;
   - `npm audit --omit=dev --json` parseado para findings security;
   - dead exports/duplicação via análise do scanner (Etapa 1) estendida de
     diff-only para símbolos exportados do índice estrutural (anti-função-
     órfã mecânica: símbolo novo nunca referenciado = finding).
3. Projetos sem toolchain (landing HTML puro): auditoria de conteúdo +
   preview/screenshot pela surface de design que já existe
   (`automated-review-design-surface.ts`, `automated-review-preview.ts`) como
   sensor mínimo.

**Arquivos-alvo:** `context/context-doctor.ts`, `context/sensor-broker.ts`,
`runtime/nexus-doctor-context-check.ts`, novo `context/sensors/nexus-owned/*`.
**Pronto quando:** missão em repo recém-criado termina com ≥1 sensor
executado e evidência registrada; brecha crítica de audit bloqueia merge.

### Etapa 3 — Contexto anti-orfão obrigatório no kickoff 🟠

**Problema:** função órfã / código duplicado nascem de kickoff sem mapa.
**Mudança:**

1. Contrato canônico da missão (payload do `prepare`) passa a embutir,
   automaticamente: resumo do orientation index (top símbolos vivos por
   domínio impactado), stack detectada, e as 4 regras duras: proibido função
   órfã, proibido duplicar implementação existente (reusar/estender),
   proibido introduzir dependência deprecated sem justificativa no resultado,
   proibido contorno de sandbox/segredo.
2. Ampliar `orch/stack-detector.ts` (hoje: node/react/electron/vite/python/
   go/rust) para nível framework + versão: next/expo/tailwind/django/fastapi/
   spring etc., lendo lockfiles e manifests.
3. `nexus_code_map_get`/`blast_radius` viram parte do prompt canônico do
   Maestro (tool já existe; falta doutrina de uso obrigatório antes de criar
   arquivo novo).

**Arquivos-alvo:** `orch/mission-contract*`/payload compiler em
`context/contract-compiler.ts`, `orch/stack-detector.ts`,
`orch/tools-code-map.ts`.
**Pronto quando:** payload de missão carrega mapa+stack; reviewer recebe
checklist anti-duplicação; teste prova que símbolo órfão gera finding.

### Etapa 4 — Doutrina por tipo de projeto (landing → SaaS) 🟡

**Problema:** leigo não sabe pedir stack; LLM escolhe do humor.
**Mudança:**

1. Biblioteca de doutrinas versionadas no repo (`resources/doctrines/`):
   `landing-page`, `ecommerce`, `saas-dashboard`, `api-backend`, `mobile`.
   Cada uma define: stack recomendada moderna, checklist de segurança
   (auth, pagamento, LGPD/GDPR, headers/CSP, rate limit), performance
   budget, e "definição de pronto".
2. MissionSetup pergunta UMA coisa nova em linguagem natural ("o que é? uma
   página, uma loja, um sistema?") e anexa a doutrina ao contrato — nunca
   formulário técnico.
3. Task-router usa especialidade existente (visual/security) para selecionar
   reviewer compatível com a doutrina.

**Arquivos-alvo:** `resources/doctrines/*` (novo), renderer
`MissionSetup.tsx`/`DirectionComposer`, `context/contract-compiler.ts`.
**Pronto quando:** missão "loja" nasce com checklist de pagamento+LGPD no
contrato e reviewer security designado; missão "landing" não arrasta auth
desnecessário.

### Etapa 5 — Laudo final em linguagem humana 🟡

**Problema:** evidências espalhadas; leigo não lê markdown técnico.
**Mudança:** card final da missão (MissionBoard/MissionInspector) mostra:

- O QUE foi feito (do result do completeVerified, já obrigatório);
- VERIFICAÇÕES: sensores executados ✓/✗, veredito do revisor, scan de
  segurança, screenshots do preview;
- PENDÊNCIAS traduzidas (finding severity → frase simples);
- Botão único "Ver detalhes técnicos" (colapsado) para quem quiser.

Nenhum dado novo: é projeção das evidências que a Etapa 1–2 passam a gerar.

**Arquivos-alvo:** renderer `components/mission/MissionBoard.tsx`,
`MissionInspector.tsx`, store `mission-inspector-store`; IPC read-only novo
via preload (seguir padrão Zod do `security:renderer-sinks`).
**Pronto quando:** missão verde exibe laudo completo sem ação do operador.

### Etapa 6 — Memória que aprende por missão 🟢

**Mudança:** ativar a consolidação pendente (`reflect()`, PENDÊNCIA C2):
learnings do `completeVerified` + findings resolvidos do ReviewCouncil viram
memória `trusted:` automática do workspace. Próxima missão no mesmo projeto
nasce com o histórico (recall workspace-first já existe).

**Arquivos-alvo:** `memory/workspace-memory.ts`, `memory/trusted-memory.ts`,
hook pós-completeVerified em `orch/mission-engine-production.ts`.
**Pronto quando:** segunda missão no mesmo projeto cita decisões da primeira
no contexto compilado.

### Etapa 7 — Remoção e higiene 🟢

1. Segunda varredura de órfãos reais (agora com mapa preciso desta análise):
   confirmar callers de `task-dispatch-store` (projeções legacy), lane inerte
   `pty-stream-handoff`, `HANDOFF-0.19.32.md` na raiz, drift de docs
   (ARCHITECTURE diz 24 tools; existem ~140).
2. Adicionar `knip` (ou ts-prune) como script opcional do próprio repo — o
   Nexus que caça função órfã precisa não ter as suas.
3. Atualizar ARCHITECTURE.md §tools com contagem real.

**Pronto quando:** `knip` limpo ou com baseline documentado; docs coerentes.

## 5. Ordem e dependências

```
Etapa 1 ──► Etapa 2 ──► Etapa 5
   │                        ▲
   ├──► Etapa 3 ─┐          │
   └──► Etapa 4 ─┴──────────┘
Etapa 6 e 7 independentes (qualquer momento após 1)
```

Etapa 1 é a promessa central e desbloqueia as demais (elas produzem insumos
para o laudo). 3 e 4 podem avançar em paralelo com 2.

## 6. Métricas de sucesso

| Métrica | Hoje | Alvo |
|---|---|---|
| Missões livres concluídas COM veredito registrado | 0% (isentas) | 100% |
| Missões greenfield com ≥1 sensor executado | condicional | 100% |
| Ciclos de repair resolvidos sem intervenção | n/a | ≥80% |
| Símbolos órfãos entregues | indetectado | finding bloqueante |
| Passos manuais novos exigidos do operador | — | **zero** |
| Regressão de tempo de missão verde | — | ≤ +20% (revisor roda em paralelo) |
