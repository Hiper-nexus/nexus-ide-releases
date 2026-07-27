# Plano final de correções — NexusIDE v0.19.30

**Data:** 2026-07-26 · **Base:** relatório de auditoria v0.19.30 (commit `31628c4f`) + análise sênior em `2026-07-26-analise-senior-relatorio-v0.19.30-e-plano.md`
**Decisões de produto registradas:** autonomia-first (yolo/full-auto é tese do produto, 2026-07-26)
**Este documento substitui a Parte 2 do documento de análise.**

---

## 0. Resultado do audit de dependências (executado hoje)

A lacuna maior da auditoria estática foi fechada com autorização do dono do produto:

| Verificação | Escopo | Resultado |
|---|---|---|
| `npm audit` (GitHub Advisory DB) | árvore completa, 1.086 deps (root + workspace server, lockfile único) | **0 vulnerabilidades** |
| OSV `querybatch` | 67 dependências diretas (root + server) | **0 hits** |

Pacotes críticos no lock: electron 43.0.0, @lydell/node-pty 1.2.0-beta.12, better-sqlite3 12.11.1, onnxruntime-node 1.19.2, zod 4.4.3, react 18.3.1 (+@types/react 19.2.17 — skew confirmado), typescript 6.0.3.

**Leitura:** nenhum CVE conhecido explorável no snapshot. O bump Electron 43.0.0 → 43.2.0 continua no plano, mas por **política de suporte** (só o último minor recebe patch), não por advisory. O audit passa a ser item permanente de CI (Bloco 1) — um snapshot limpo hoje não diz nada sobre amanhã. Mobile não foi auditado (sem lockfile; destino do produto pendente).

---

## 1. O que este plano corrige — e o que ele recusa

Princípio: **autonomia-first é decisão tomada**. Nenhum item deste plano reintroduz atrito de consentimento no fluxo normal do vibe coder. Segurança vem de isolamento e contenção de blast radius, não de modal.

O plano tem 5 blocos (~12 semanas, 1–2 sêniores a ~50%). Tudo que não está aqui foi para a seção 3 (backlog explícito) — não é esquecimento, é decisão.

---

## Bloco 1 — Fundação verificável (semana 1–2)

Nada abaixo é negociável: sem CI, o resto do plano não tem prova.

| # | Item | Origem | Gate |
|---|---|---|---|
| 1.1 | `.github/workflows/quality.yml` em PR/push: Node 22.23.1, `npm ci`, typecheck + test root e server; branch protection exigindo o check | QUAL-01 | PR de teste falhando é bloqueado |
| 1.2 | Pin de toolchain (`.nvmrc`/Volta + checagem pré-script) e alinhamento `@types/react` ↔ React 18 | QUAL-03 | Checkout limpo reproduz |
| 1.3 | `npm audit` + OSV no CI (repetir o procedimento de hoje a cada PR/release) | lacuna do relatório | Job falha em vuln high+ nova |
| 1.4 | Bump Electron → 43.2.0 isolado; smoke dos nativos (node-pty, better-sqlite3, onnxruntime) empacotado | QUAL-04 | Smoke por SO |
| 1.5 | `lint`: renomear ou ESLint com baseline mínimo (sem reformat) | QUAL-05 | Check separado no CI |
| 1.6 | Hook global `web-contents-created` negando popup/permissão/navegação por default | SEG-12 | Teste com webContents sem config |

## Bloco 2 — Segredos fora do alcance do agente (semana 2–5)

**O item de segurança nº 1 do programa.** Com yolo por design, segredo em plaintext no workspace é o caminho óbvio de exfiltração via prompt injection.

| # | Item | Origem | Gate |
|---|---|---|---|
| 2.1 | MCP Hub: workspace persiste só referências; valores reais em safeStorage/Keychain, resolvidos apenas no spawn do servidor MCP | SEG-02 | `grep` do workspace não acha valor real |
| 2.2 | Migração atômica com rollback protegido (formato antigo lido por uma release inteira) | SEG-02 | Teste ida e volta |
| 2.3 | Valores reais fora de qualquer payload IPC ao renderer | SEG-02 | Auditoria de payload + UI mascarada |
| 2.4 | Credenciais gerenciadas: ACL mínima, nomes não previsíveis, fora do workspace, cleanup em crash/kill | SEG-06 | Teste com kill -9 |
| 2.5 | Prova adversarial: worker full-auto não obtém valor real | SEG-02/06 | Cenário executado de verdade |

## Bloco 3 — Autonomia responsável (semana 3–5, paralelo ao 2)

Implementa a decisão autonomia-first com contenção de blast radius.

| # | Item | Origem | Gate |
|---|---|---|---|
| 3.1 | ADR: autonomia-first é decisão de produto (não reabrir sem evidência nova); matriz pane/role/modo/flag por adapter | SEG-01 | ADR mergeado |
| 3.2 | Consentimento informado **uma única vez** no primeiro uso ("agentes executam sem pedir permissão"), nunca mais | SEG-01 | Zero atrito após opt-in |
| 3.3 | Máscara da subárvore `.nexus` no isolamento do processo nativo; fechar lacuna do Windows (PTY interativo sem ProcessSandbox) | SEG-01/02 | Adversarial não lê `.nexus` |
| 3.4 | Worktree descartável como opção de execução para missões/repos não confiáveis | SEG-01 | Smoke de missão em worktree |
| 3.5 | Shell destrutivo proporcional: modal **só** para conjunto catastrófico irreversível (`rm -rf` raiz/home, `mkfs`, `dd`, wipe) + variantes (`git clean -fdx`, PowerShell); descrição da tool corrigida para não prometer bloqueio que é só classificação | SEG-03 | Teste vermelho: variantes conservam modal; shell normal nunca pede modal |
| 3.6 | `allowedTools: null` → união discriminada `toolPolicy.mode` com migração versionada | ARCH-03 | Snapshot de capacidade efetiva |
| 3.7 | **PREVC (decidido 2026-07-26):** campo de política explícito persistido por missão — default `intent-only`, opt-in `prevc-required`; em `prevc-required`, falhar fechado para tools com efeito se contrato ausente/vencido/estágio errado; exibir política + revision hash na UI; migração para missões legadas | SEG-04 | Matriz missing/stale/current em teste; smoke de missão legada |

## Bloco 4 — Higiene: deletar e completar (semana 5–8)

PRs pequenos e independentes; deletion test documentado em cada um.

| # | Item | Origem | Entrega |
|---|---|---|---|
| 4.1 | Reachability dos 11 módulos suspeitos; integrar ou deletar (worktree-removal-safety: integrar a proteção, não apagar) | TD-01 | 300–1.100 LOC |
| 4.2 | Harness real-mission-e2e fora do grafo de release | TD-02/ARCH-01 | Metafile sem módulos E2E |
| 4.3 | Manifests gerados → artefatos de build | TD-03 | ~1,9 MB fora da árvore |
| 4.4 | Cost bridge: **completar** (decidido 2026-07-26) — canais/tipos em `shared`, bridge `cost` no preload ligando aos handlers de `cost-ipc.ts`; remover cast `unknown` e o no-op silencioso | FUNC-01 | Contrato do preload testado; evento de custo main→store; estado explícito de indisponibilidade |
| 4.5 | MCP Hub health real (probe/timeout/backoff, estados honestos) | FUNC-02 | UI não mente |
| 4.6 | Marcar `ARCHITECTURE.md` como histórico + índice arquitetural vivo de 1 página + glossário | ARCH-02 | Doc não contradiz código |
| 4.7 | Kickoff legado, schema de model ID, testes cross-fronteira | TD-17/18/19 | Pequenos deletions |
| 4.8 | Arquivar `mobile/` (decidido 2026-07-26): mover para arquivo/marcar como protótipo sem owner, fora do CI e do grafo de release; companion/PWA permanece como caminho remoto oficial | TD-16 | Repo sem mobile ativo; histórico preservado |

## Bloco 5 — Seams de segurança + desinflamento de IPC/preload (semana 8–13)

| # | Item | Origem | Gate |
|---|---|---|---|
| 5.1 | `trusted-ipc` central (validação exata de main-frame/protocol/host, deny-by-default); migrar mutadores primeiro: settings, account, provider-config, updater, team | SEG-05 | Testes com frames atacantes |
| 5.2 | OAuth window: allowlist de origens por provider + callback loopback exato | SEG-08 | Testes cross-origin/punycode/IPv6 |
| 5.3 | Auditoria de sinks DOM como check de CI + corrigir doc de CSP | SEG-13 | Check no CI |
| 5.4 | Servidor: rate limit com modo de deploy codificado + trust proxy validado | SEG-11 | Teste multi-instância |
| 5.5 | Servidor: security headers no app + smoke externo | ARCH-04 | Headers no endpoint público |
| 5.6 | orch-ipc → Adapter fino (promovido do backlog em 2026-07-26): extrair NativeAttestation e SquadFileExchange como módulos profundos; `registerOrchIpc` vira parse → chamar Interface → serializar; bootstrap/close separados do registro. Sinergia com 5.1 (trusted IPC) | TD-06 | 66 casos de authority agrupados; symlink/TOCTOU/CAS; revogação durante modal. Redução: 250–450 LOC prod + 500–800 testes |
| 5.7 | Preload por domínios (promovido do backlog em 2026-07-26): extrair `create*Bridge` para orch/voice/pet + helper tipado de subscribe/unsubscribe; testes com IpcRenderer fake. Sinergia com 4.4 (cost bridge já toca o preload) | TD-07 | Contrato enumera chaves expostas, canais/payloads e cleanup. Redução: 180–300 LOC |

---

## 2. Métricas do programa (revisão mensal)

- Checks de CI verdes em PRs (meta: 100% após Bloco 1)
- Vulnerabilidades high+ abertas no audit (meta: 0; hoje: 0)
- LOC líquido removido por mês (Blocos 4 e 5; meta: envelope de 3.000–5.700 ao longo do programa)
- WIP máximo: 2 blocos ativos por vez

## 3. Backlog explícito — NÃO fazer agora

| Item | Motivo do adiamento | Quando reabrir |
|---|---|---|
| Refatorações profundas TD-04, TD-05, TD-08 a TD-13 (voz, pane lifecycle, browser, OMP, hooks, mission authority, workflow, terminal) | Alto risco, benefício invisível ao usuário; estimativas de LOC são chutes. **TD-06 e TD-07 foram promovidos ao Bloco 5 (5.6/5.7) em 2026-07-26** | Quando uma feature real tocar o módulo — refatorar junto da feature |
| SEG-07 (manifesto assinado do catálogo), SEG-09 (SBOM+cosign imagem Windows) | Padrão enterprise/compliance desproporcional ao estágio | Cliente enterprise exigindo |
| SEG-10 (LAN/PWA MITM) | Risco já aceito e documentado | Companion nativo existir |
| QUAL-02 (mutation testing, cobertura global) | 80% do valor vem de cobertura nos gates de política, não de % global | Após Bloco 5, se sobrar capacidade |
| TD-14/15/09, TD-20 completo | Consolidação cosmética sem driver de feature | Junto de features adjacentes |
| Server multi-réplica avançado, deploy hardening além de 5.4/5.5 | Topologia de deploy ainda não definida | Deploy real definido |

## 4. Decisões do dono do produto — status

1. **PREVC** — ✅ **DECIDIDA (2026-07-26, delegada ao eng. sênior):** política explícita por missão com default **`intent-only`** e **`prevc-required` como opt-in por missão**. Justificativa: fail-closed por default contradiz a tese autonomia-first; mas a política deixa de ser inferida pela ausência de registro — vira campo persistido, visível na UI com revision hash, e auditável. Implementação no Bloco 3.7.
2. **Mobile** — ✅ **DECIDIDA (2026-07-26, delegada ao eng. sênior): arquivar.** Justificativa: Expo 51/React Native 0.74 desatualizados, fora do workspace raiz, sem lockfile, 217 LOC, sem owner — custo de manutenção sem produto. O caminho remoto real do produto é o companion/PWA. Execução: mover `mobile/` para `docs/archive/mobile/` (ou marcar claramente como protótipo arquivado), sem deletar histórico; não entra no CI. Reabrir apenas se virar produto com dono.
3. **Cost bridge** — ✅ **DECIDIDA (2026-07-26): completar, não deletar.** A feature de custo por pane está no roadmap. Implementação no Bloco 4.4: canais/tipos em `shared`, namespace `cost` no preload, ligação aos handlers existentes em `cost-ipc.ts`, remoção do cast `unknown` e do no-op silencioso, estado explícito de indisponibilidade.
