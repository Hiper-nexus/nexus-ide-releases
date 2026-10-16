# Orquestração + MCP embutido (Fase 2d)

Orquestração completa (ver `ARCHITECTURE.md` §E): squads,
missões, handoffs, todos e um servidor MCP embutido com perto de **190 tools** no
namespace `nexus_*` (o núcleo original da Fase 2d eram as da tabela abaixo; o mapa
por família está em `ARCHITECTURE.md` §E.2 e a fonte é o `tools/list`).

## Servidor MCP

O main process sobe um servidor HTTP MCP em `127.0.0.1:<porta aleatória>/mcp`.
Cada pane de agente recebe no spawn:

- `NEXUS_MCP_URL` / `NEXUS_MCP_TOKEN` — endpoint + bearer token individual;
- `--mcp-config <arquivo>` quando o adapter tem `quirks.mcpAutoload` (Claude);
- `NEXUS_GATE_URL` / `NEXUS_GATE_TOKEN` — endpoint e bearer por pane do mesmo servidor, que
  também recebe os hooks de status do pane; desde o F-1157 ele não nega nenhuma ferramenta.

Aliases aceitos em `tools/call`: `nexus_pane_spawn` ≡ `pane_spawn` (o
`tools/list` expõe apenas os canônicos `nexus_*`).

Tools de bootstrap do orquestrador são serializadas pela prompt queue da
missão. Panes filhos com autoridade `readOnly`, como reviewers de contexto e
merge, não reservam essa fila: eles precisam inspecionar e votar enquanto o
orquestrador mantém a operação pai aguardando.

## Núcleo da Fase 2d

| Grupo | Tools |
|---|---|
| Panes (12) | `nexus_pane_spawn`, `nexus_pane_list`, `nexus_pane_list_providers`, `nexus_pane_read`, `nexus_pane_read_many`, `nexus_pane_write`, `nexus_pane_write_many`, `nexus_pane_close`, `nexus_pane_wait_idle`, `nexus_pane_wait_many`, `nexus_pane_ask`, `nexus_pane_whoami` |
| Handoffs (3) | `nexus_handoff_submit`, `nexus_handoff_list`, `nexus_handoff_ack` |
| Agentes (6) | `nexus_agent_invoke`, `nexus_agent_list`, `nexus_agent_get`, `nexus_agent_prompt`, `nexus_agent_wait`, `nexus_agent_spec_write` |
| Missões (7) | `nexus_mission_create`, `nexus_mission_get`, `nexus_mission_list`, `nexus_mission_set_status`, `nexus_mission_spawn_pane`, `nexus_mission_control`, `nexus_mission_request_resume` |
| Squad/Catálogo/Task (3) | `nexus_squad_save`, `nexus_catalog_install`, `nexus_task` |
| Todos (1) | `nexus_todo_manager` |
| Roteamento (2) | `nexus_route_task` (decide adapter/model/effort por tier+catálogo), `nexus_route_log` (auditoria read-only das últimas decisões com o motivo — "ver para crer") |
| Clarify (1) | `nexus_clarify` (pergunta única com 2-6 chips de sugestão + roteamento determinístico da resposta por id/label/número) |

## Handoffs (SQLite + IPC — melhoria sobre marker files)

Worker chama `nexus_handoff_submit({status, summary, artifacts})` → linha
durável na tabela `handoffs` → entrega automática no PTY do orquestrador da
missão **quando ele fica idle** (nunca no meio de uma resposta). O formato
legado `### NEXUS_HANDOFF v1` + JSON impresso no terminal também é
reconhecido (parser de stream com ANSI-strip).

O orquestrador responde cada entrega com `nexus_handoff_ack`: `accepted` (padrão) ou
`rework` com `note`, que volta ao MESMO writer (`[NEXUS_REWORK]` no PTY ou `resume` na
worktree dele), e o próximo `nexus_handoff_submit` do writer é a rodada seguinte (F-239).
O helper aberto por um agente do operador, sem missão, entrega ao agente pai como
mensagem `unverified`, sem ACK nem recibo de missão (F-565). Writers isolados
(`isolatedWriter: true`) entregam branch, sha, arquivos tocados e diff; as branches não têm
merge automático e o Maestro as integra na ordem de dependência. Revisão `readOnly` roteada
para fora de Claude/Codex em segurança crítica é informativa: o veredito dela nunca satisfaz
o portão de integração. Detalhes em `AGENTS.md` ("Via Rápida", "Handoff sem missão",
"Revisão informativa e portão formal") e nas skills `oc-*` (`docs/SKILLS.md`).

## Gate de agente: acesso aberto (F-1157)

Desde 10/10/2026 o gate do servidor MCP não nega ferramenta por allowlist, papel ou
somente-leitura: `tools/list` mostra toda tool disponível e `tools/call` passa por essas
checagens. `allowedTools`, `allowedSkills` e `readOnly` continuam gravados no token e nos
selos (mudar os dados quebraria missões seladas), mas não negam. Seguem valendo o bearer
por pane e a revogação, o vínculo de sessão/missão/líder, a proveniência do handoff, o
consentimento humano e o modo Hardened que o operador escolhe (`docs/SECURITY.md`,
"Agents without restraints").

O único hook do Nexus sobre ferramentas nos panes Claude é o do spool do
`nexus_handoff_submit` (F-795/F-1154): com o Main fora do ar, o relato vai para o spool
assinado da sessão e o agente ouve "guardado". `/gate/pretool` e `/gate/posttool`, depois de
autenticar o bearer, só respondem `allow: true`; o `/gate/stop` é vestígio para panes de builds anteriores. O
`$HOME` efêmero continua isolando estado e conta do worker, e não é negação de tool.
Histórico: antes do F-1157 o servidor recusava `tools/call` fora da allowlist do token e o
Stop-gate bloqueava a saída sem handoff (máx. 3 tentativas); isso saiu.

## Squads

Schema do `squads.json` (`id`, `name`, `createdAt`,
`builtin`, `orchestratorInstructions`, `agents[]` com `category` incluindo
`orchestrator`, `effort`, allowlists gravadas no selo, sem negar nada desde o F-1157).
Export/import nativo de JSON em Configurações › Squads (`ModuleSections.tsx`,
`orch.exportSquads` / `orch.importSquads`).

## UI

O painel "⛭ Orch" (abas Missions / Handoffs / Todos / Squads) saiu no corte de produto V2
(08/08/2026). A missão vive no Quadro (`components/mission/MissionBoard.tsx`) e nos terminais
da aba, a navegação é declarada por `product-navigation-store.ts`, a configuração de missão
fica em `components/mission/MissionSetup.tsx` e o export/import de squads, em Configurações ›
Squads (`ARCHITECTURE.md`, "Corte de produto V2").

## Runtime multi-CLI

As CLIs instaladas entram na frota pelo mesmo caminho observável:

- o roster aprovado fixa a CLI de cada agente; não há companion invisível nem
  auto-spawn fora do plano;
- workers são processos PTY main-owned, ligados à missão, pane, sessão,
  worktree e incarnation exatos;
- o router considera instalação, autenticação, modelo e capacidade de handoff;
- escrita acontece no worktree da task, enquanto promoção ao branch de
  integração permanece main-owned;
- resultados chegam por HTTP MCP ou PTY-stream e só avançam a missão quando o
  receipt físico corresponde à identidade selada.

No modo Autopiloto, um adapter PTY com launch, prompt injection e observação de
estado também pode atuar como Maestro sem suporte MCP nativo. O terminal emite
`### NEXUS_ACTION v1 <nonce>` seguido de uma ação estruturada; o Main valida
sessão, missão, papel, contrato e revisão atuais antes de encaminhar a chamada
ao mesmo dispatcher auditado. O resultado deduplicado volta ao terminal como
`[NEXUS_RESULT]`. O modo Hardened não habilita esse canal e mantém a fronteira
MCP/native.

## Route pipeline (x-algorithm patterns)

Task routing follows a candidate-pipeline mental model:

1. **Source** — adapters installed (hot-cached ~5s, Thunder-lite)
2. **Hydrate** — models + catalog quality
3. **Filter** — capability table + blocked models
4. **Score** — multi-axis (table rank, quality, cost, mission diversity, circuit)
5. **Select** — top-1 + alternatives; `reserveClaude` for workers
6. **Side effects** — `nexus_route_log`, circuit success/failure on spawn

Diversity attenuation: repeated adapters in the same mission lose score  
(author-diversity idea from X For You algorithm). Circuit breaker opens after  
repeated spawn failures and is skipped by multi-score when alternatives exist.

Full phased plan: `docs/analysis/2026-07-18-master-plan-grok-build-x-algorithm.md`.

## Kimi Code as a hosted motor

Kimi is a first-class CLI adapter (`bin: kimi`, package
`@moonshot-ai/kimi-code`), not an embedded Python runtime.

| Surface | Nexus behaviour |
|---------|-----------------|
| Interactive pane | `kimi` + optional `-y` via autonomous policy |
| Headless / eval | `kimi -y --output-format text -p …` |
| Auth | OAuth managed home or `KIMI_MODEL_*` transient key env |
| Plan design | Prefer **mission lane=plan** (host) over Kimi `--plan` alone |
| Explore/plan/coder roles | Builtin **Code Cell — método Kimi** (`kimi-code-cell`): workers Codex governados; Kimi permanece no Terminal/manual |

Senior analysis of [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli)
vs what to transplant:  
`docs/analysis/2026-07-18-analise-senior-kimi-cli-vs-nexus.md`.
