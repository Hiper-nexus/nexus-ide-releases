# Handoff — Missão Terminais + travamento do Main + otimização do Nexus (03/10/2026)

Estado em 03/10/2026 ~14:20 (BRT). **Nada foi publicado ainda**: a release 0.76.191 sai uma vez só, quando tudo estiver pronto, notarizada e no GitHub.

## 1. O que aconteceu (resumo)
- O operador mandou a "Missão · Terminais" (8 pedidos: orquestração, memória de longa duração entre todas as LLMs, usar todas as CLIs, Jev/Clef, navegador interno, multiconta, "lançar uma versão").
- ~11:41 o **processo principal (Main) do Nexus travou por minutos** com ~15 CLIs ativas e a missão ficou presa. Causa provada (F-764): regexes de início de linha em `limit-detector.ts` cúbicas em tela de TUI em branco (300 ms por janela de 4 KB, a cada chunk de PTY). Ver `docs/analysis/2026-10-03-main-thread-hang/HANDOFF.md`.
- O operador fechou o Nexus. **Nenhum trabalho se perdeu**: bancos, worktrees, transcripts e patches foram preservados (seção 7). A missão em si "não precisa mais ser retomada": o que ela pedia foi trazido para o código.

## 2. Já feito e INTEGRADO (branch `missao-terminais/integracao`, 69 commits sobre `32230db8`)
| Item | O que entrega |
|---|---|
| **F-764** (já no `main` local, 6050422d) | Detecção de limite em tempo linear (301 ms → 0,13 ms); orçamento de 25 ms/varredura com backoff; histórico `logs/main-hang.ndjson` |
| F-764 diag | Profile JS automático no travamento (`.cpuprofile`, validado no Electron 43.7.4 com fuses de produção), métricas de event loop, faixa "Nexus ocupado" |
| F-766/767 | Pedido de CLI do operador respeitado (inclusive digitado tecla a tecla, "qwen3.8-max") |
| F-768 | Memória volta a gravar (aceite, entrega, ACK, helper sem missão, fim de sessão), retry persistido, motivos de descarte |
| F-769 | Memória chega a todas as LLMs; injeção em duas camadas; vault `.nexus-memory/`; alarme "última memória há N dias"; projeção do vault **assíncrona** (retain: 1.453 ms → 5 ms) |
| F-770/771/772 | Diversidade de rota, eixo de capacidade (web, somente leitura…), skill/especialidade |
| F-774 | Catálogo, preços e tabela de rotas atualizados |
| F-775 (item 1) | Pacote de continuidade na troca de conta |
| F-776 | Conselheiro de stack (linguagem certa por alvo) |
| F-777 + F-793 | Grafo da missão mostra orquestrador e todos os helpers (tela + causa: helper com ACK pendente entrava fora de `mission_panes`) |
| F-778 | Portão F-234: sync fast-forward × merge real |
| F-779 | Lane de juízes aberta a outros laboratórios |
| F-780/781 | Journal grava o nome/categoria de cada tool; WebFetch cede ao navegador do Nexus |
| F-783 | Clef recebe tráfego em modo auto |
| F-784 | Delegação paralela com teto pela memória/RAM da máquina |
| F-785/786/787 | Missão de operação, handoff mecânico revisado, telemetria de spawn |
| F-788/789/792 | Qwen e MiniMax abrem (smoke de PTY real); supervisor acusa morte no boot; cauda de boot em tempo linear (a do patch original levaria 35 s) |
| F-790 | Usa a instalação mais nova da CLI (sonda `--version` assíncrona, fora do Main) |
| F-791 | agy + Gemini sem sufixo não recebe `--effort` (não morre no boot) |
| F-794 | Writer isolado commita na própria worktree; trabalho sem commit vira salvaguarda (`refs/nexus-salvage/`) |
| F-765 | Pane com modelo recusado se recupera sozinho |
| F-796 | Toggles "Ranking de entregas" e "Recomendação de ferramenta" passam a valer |
| Segurança | Toolchain de build sem as 31 vulnerabilidades (braces-compat, http-cache-semantics-compat, brace-expansion 5.0.12, source-map-js 1.2.2) |
| Teste | Ícone do app conferido por pixels |

## 3. Já commitado em branch, FALTA integrar
- `missao-terminais/f782-773` (5 commits): **F-782** (ACK do Maestro rotula Certo/Errado a revisão do Jev), **F-773** (taxa de sucesso por CLI/modelo na nota da rota, migração 041, `nexus_route_log` persistente).
- `missao-terminais/f764-struct` (1 commit): **C.3** teto de tempo nas funções de texto dos taps do PTY.

## 4. EM ANDAMENTO (agentes trabalhando em worktrees próprios, `~/.nexus-worktrees/terminais-*`)
| Branch | Escopo |
|---|---|
| f765-775b | **F-775 item 2** (quando todas as contas de uma CLI esgotam, seguir para a próxima CLI — missão E "+ Pane", automático) + M4 (git assíncrono no planejador do failover, F-822) |
| f780-781 | **F-797** (navegador do Nexus ao alcance dos workers) + nome da skill, categoria shell-http, regra no brief de orquestrador não-Claude |
| f782-773 | M7 (F-823): regex de admissão do handoff que rebaixa entrega boa; simetria PTY/MCP |
| async-io | Janela do Codex sem `--dangerously-bypass-hook-trust` no boot; B1 (`codex --version` síncrono no spawn) |
| f764-struct | Blindagem do Main: chunks de PTY em lote, backpressure (`pty-flood`), tempo por tap, intervals com orçamento, lint contra `*Sync`, semáforo de comando pesado |
| resilience | **F-795** (handoff guardado em spool se o Main travar; gate não bloqueia leitura quando o Main está inalcançável) |
| memoria2 | Correções da revisão (vault em disco opt-in, raiz fixa, limite de taxa, restrição M1) + **F-798..F-801** (backfill, escritores de regra/preferência, dedup/expiração, recall por raio de impacto) + pesquisa externa (ai-memory/graphify/Obsidian) |
| plus-pane | **F-802**: Nexus inteligente também no "+ Pane" para TODAS as CLIs (matriz CLI × canal) |
| fix-intent | **C1 (crítico)**: missão do "+ Pane" nasce com `maxWorkers: 0`; A5, M5, B4 (F-810..F-813) |
| fix-gate | A2 (merge --abort/merge-base bloqueados no main), B2 (git assíncrono), testes herméticos (F-814..F-816) |
| fix-router | Política da lane de juízes (Argon só com acesso provado), M2, M3, B3, B5 (F-817..F-821) |
| (sem branch) | Auditoria de cobertura (cada lacuna dos relatórios 02–07 × F-item) em `~/nexus-incident-2026-10-03/coverage-audit.md` — o que vier **sem cobertura** vira item novo |

## 5. Revisão adversarial da integração (reject) — situação
Relatório: `~/nexus-incident-2026-10-03/review-ec8524a8.md` (1 crítico, 5 altos). Todos têm dono na seção 4. Exige **nova revisão independente do diff final** antes de publicar (veredito "approve").

## 6. Falta para publicar (nesta ordem)
1. Integrar o que falta (seções 3 e 4), com testes focados após cada merge e resolução de conflitos semânticos (já houve um: F-765 × F-792 no supervisor).
2. Despachar o que a auditoria de cobertura apontar como não coberto.
3. Segunda revisão adversarial do diff final.
4. Texto final do CHANGELOG e de `src/shared/release-notes.ts` (rascunho no scratchpad).
5. Merge da integração em `main` (não é fast-forward); `npm ci` no repositório principal; `npm run typecheck`; suíte completa (`npx vitest run`); `npm run security:renderer-sinks`.
6. Recriar a tag local `v0.76.191` no HEAD final (a atual aponta para 6050422d e **nunca foi enviada**; o gate exige tag = HEAD).
7. `NEXUS_RELEASE_NODE=/opt/homebrew/opt/node@22/bin/node PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run release:mac` (Mac **desbloqueado**: notarização usa o keychain). O gate de segurança usa o npm 12.0.0 do `packageManager`.
8. No app **assinado**: `node scripts/smoke-packaged-app.mjs --verify-hang-probe --app <caminho do .app>` (prova o profile automático no binário de release; não está ligado como gate).
9. Publicação no GitHub (push de `main` e da tag + release com DMG/ZIP) — o passo `publish` do `release:mac`.
10. Depois: `npm run rebuild:node`, abrir o app novo e conferir.

## 7. Onde está cada coisa
- Backup completo do incidente: `~/nexus-incident-2026-10-03/` (bancos, `provider-state`, `project-runtime`, `ephemeral`, patches por worktree, briefs, relatórios). **Pode ser apagado depois de confirmado o release** (usa clones APFS).
- Relatórios: `integration-report.md`, `review-ec8524a8.md`, `coverage-audit.md` (quando pronto).
- Worktrees para limpar após a release: `~/.nexus-worktrees/terminais-*`, `sec-toolchain`, `review-ec8524a8` e as branches `missao-terminais/*` e `chore/toolchain-advisories-2026-10`.
- Estado da missão antiga no banco: `running` (nunca concluída). Ao abrir o app novo, escolher **Encerrar** (não retomar) os panes dela; o operador disse que a missão em si não precisa mais.

## 8. Regras que valem para quem continuar
- **Nunca `git stash`** com worktrees paralelos (stash é global; já houve troca de alterações entre agentes).
- Node 22 (`/opt/homebrew/opt/node@22/bin`); `typecheck` com lock (`scratchpad/tsc.lock`); vitest focado com `--maxWorkers=2` e HOME no scratch (não escrever no `~/.nexus` real).
- Regex sobre texto de terminal/agente: linear + teste de tempo adversarial (16 KB, 50 ms). Nada de I/O/processo síncrono novo no Main.
- Commits terminam com `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` e `Claude-Session: https://claude.ai/code/session_013AueNZNp4XgECpK7VT7Nr3`.

## 9. Só o operador pode fazer
- Gerar uma **chave nova do Qwen** (DashScope): a atual dá 401. Sem ela a CLI abre, mas não responde.
- Se quiser o OpenCode: ligar `enabled` dele em `~/.nexus/providers.json` (está desligado).
- Deixar o Mac desbloqueado durante a notarização.

## 10. Não verificado (honestidade)
- App empacotado/assinado real (só testes e smokes); fluxo de turno de modelo real nos CLIs novos (Qwen sem chave).
- Windows/Linux dos itens F-788/789/790 (helpers só macOS/posix).
