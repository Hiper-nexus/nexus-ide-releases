# handoff-d41cad7e-611e-468c-a3fe-08c3fdd36081 | Claude | partial
[verificação visual pendente] Revisão independente de fix/squad-ui (10 commits) e fix/squad-io (6 commits): nenhum REPROVADO; 13 APROVADOS e 3 APROVADOS COM RESSALVA (F-1449 recipe-save/import atômico, F-1434 e F-1448 em LOW). Sem conflito textual entre squad-ui, squad-io, squad-prep, squad-win e worker-account-failover; ordem sugerida prep → io → ui.

## nexus.visualVerification
{
 "required": true,
 "verified": false,
 "reason": "A tarefa visual ainda precisa de uma captura do navegador do Nexus feita por este worker nesta execução."
}

## texto
# Revisão independente — fix/squad-ui e fix/squad-io (release 0.76.251)

Somente leitura em `C:\Users\Administrador\Documents\Projetos\nexus-ide`. Conflitos simulados com `git merge-tree <base> A B` (forma legada; não escreve refs nem worktree). Testes não executados; veredito por leitura de diff, QA item e código vizinho.

## Tabela commit → veredito

| Commit | Item | Veredito |
|---|---|---|
| cc70bff7f (nas duas branches) | F-1434 Git Bash manda winpid; toda recusa diz o motivo | APROVADO COM RESSALVA (LOW) |
| 04e82fc20 (nas duas branches) | F-1435 órfão de PID reciclado não vira descendente | APROVADO |
| 99a083d78 | F-1436 prepare recusado mostra a causa real | APROVADO |
| 311ec6c00 | F-1437 coordenador que não coordena barrado na UI | APROVADO |
| 4c9097b0f | F-1438 exatamente um coordenador no editor; saída na Equipe | APROVADO |
| 25d4515d5 | F-1439 Modelo do editor mostra o que será salvo | APROVADO |
| 747d2c0e3 | F-1440 Expresso confere ferramenta de todos os papéis | APROVADO |
| b631f4bd3 | F-1441 editor recusa nome repetido e apara espaços | APROVADO |
| 8929c010e, 0e9af7e01 | fixtures com `orchestratorCapable` (test-only) | APROVADO |
| d60bc2a3f | F-1448 export só do usuário; import ignora ids do app | APROVADO COM RESSALVA (LOW) |
| 20d023297 | F-1449 salvar/importar recusam squad inutilizável; describe refeito | APROVADO COM RESSALVA (MEDIUM) |
| 1b7eed6e6 | F-1450 `nexus_mission_create` confere `squadId` | APROVADO |
| d3fa86922 | F-1451 UTF-16/BOM na importação e migração | APROVADO |

Causa raiz e diff batem com o item de QA em todos os commits. Os testes novos falhariam sem a correção (F-1435 esperaria `[20,30,50,51]`; F-1437/38/40/41/48/49/50/51 afirmam o comportamento novo via `toThrow`/`not.toHaveBeenCalled`/mensagem). Verifiquei no código: `Date.parse` aceita o `ToString('o')` do `Get-CimInstance` (7 dígitos) e o `ps lstart` em inglês; `TextDecoder('utf-16be')` existe no Node 22; os códigos de `POOL_REFUSALS` casam com `heavy_command_${code}` de `heavy-command-permit.ts:48`; `pane-boot-diagnosis.ts:23` ainda reconhece a última linha; `isAppOwnedSquadId` entra também em `assertPreparedImportIntegrity`; Pet Studio tem 1 agente (coordenador) e passa na regra F-1449; `prepareMissionRuntimeSquadSave` não passa por `prepareSquadSave`.

## Achados por severidade

**MEDIUM — F-1449 (20d023297)**
1. `nexus_recipe_save` quebra o próprio contrato. `src/main/orch/tools-domain.ts:3103-3115` ainda declara só `id` e `name` obrigatórios e monta `agents: args.agents ?? existing?.agents ?? []`. Um recipe novo sem `agents` vira roster vazio e `prepareSquadSave` (`squad-store.ts:489-495`) recusa com `precisa de exatamente um coordenador ... e tem 0`. O teste de paridade passa porque o fixture tem um orquestrador. Cenário: agente chama `nexus_recipe_save {id, name}` → erro em vez de persistir. Atualizar inputSchema/description do recipe ou exigir roster ali.
2. Importação atômica contra arquivo antigo. `prepareSquadsImportCandidate` recusa o arquivo inteiro se UM squad tem 0/2+ coordenadores ou >12 integrantes. Até 0.76.245 o editor salvava dois coordenadores (é o que F-1438 corrige), então um export legítimo da versão anterior com um squad assim bloqueia todos os squads do usuário, e o F-1448 acabou de ser feito para não recusar o arquivo todo. Sugestão: ignorar com aviso (como `skippedIds`) ou importar e deixar o editor corrigir, como já se faz na migração legada.
3. Constante duplicada. `MISSION_ROSTER_MAX_AGENTS = 12` nasce em `src/shared/squad-roster-rules.ts:4` enquanto `src/renderer/orch/mission-roster-customize.ts:20` já a tinha; `TeamStep.tsx` segue lendo a do renderer. Se uma mudar, Main e Equipe divergem.

**LOW — F-1434 (cc70bff7f)**
4. `request.cjs:179`: `res.on('end', () => accepted(...))` perdeu o `try/catch`. Se o Main responder JSON válido que não é objeto (`null`), `result.allow` lança TypeError → saída 1 com stack em vez de `nexus-heavy:` + 78. Não acontece com o Main atual.
5. Cobertura: o 1.º teste de `heavy-shell-admission-pid.test.ts` só prova a regressão no Windows (no Linux `BASHPID == child.pid` passa sem a correção); o ramo `swapBound` de `#memoryBudget` não tem teste (`maxSwapUsedMB: 0` no fixture).

**LOW — F-1435 (04e82fc20)**
6. `pty-descendant-termination.ts:233`: `ps lstart` é hora local sem fuso; na hora de retorno do horário de verão um filho real pode parsear como anterior ao pai e ficar fora da varredura (vaga solta cedo / kill incompleto por 1 h ao ano). A fencing existente em `:294-298` já assume o mesmo; não é regressão nova.

**LOW — F-1448 (d60bc2a3f)**
7. O `skippedIds` só vale depois de `squadsFileSchema.parse` do arquivo inteiro (`squad-store.ts:~896`): um interno de versão antiga que não passe mais no schema atual ainda recusa o arquivo com erro cru do zod. `{squads: []}` agora devolve sucesso sem modal ("Importados 0 squads"); aceitável, mas é mudança de comportamento.

**LOW — F-1436 (99a083d78)**
8. `toUserFacingMissionRecovery` trunca em 180 caracteres (`user-facing-mission-error.ts`, `truncateAtWord`); uma recusa do Main que liste vários papéis sai cortada com `…`.

**Sem achado, verificado:** F-1437 — a UI ignora `squadCliPolicy`, mas sob Hardened o Main é mais estrito (`supportsEnforceableReadOnlyNativeAuthority` só claude/codex), então não há bloqueio falso; F-1439 — já existe `<option>` de fallback para modelo salvo fora da lista; F-1440 — `inventoryReadyForReview` garante `status === 'ready'` antes da checagem nova; F-1450 — `PreEffectRefusalError` lançado direto é padrão já usado em `tools-panes.ts:1531`; F-1451 — IPC passa `selected.bytes` (Buffer) e o `rawSha256` é calculado sobre os bytes, logo UTF-16 funciona fora do teste também. Segurança: nenhuma recusa imprime token, corpo ou endereço remoto (`reason` saneado por `[^\w.-]`, `message` por controle/600 chars).

## Conflitos previstos

- squad-ui × squad-io, squad-ui × squad-prep, squad-win × ambas, worker-account-failover × ambas: nenhum arquivo em comum além de cc70bff7f/04e82fc20, que são os MESMOS SHAs nas quatro `fix/squad-*` e em `fix/windows-heavy-pid-squads` (merge dedupe).
- squad-io × squad-prep: `squad-store.ts`, `squad-store.test.ts`, `ModuleSections.tsx`, `SettingsSquads.capabilities.test.tsx` mudados nos dois lados, **0 hunks conflitantes** na simulação. Semântica compõe: F-1446 (nomes únicos em `assertManagedSavePolicy`) roda antes da regra de roster F-1449 em `prepareSquadSave`; o import não passa por `assertManagedSavePolicy`, então o teste F-1449 com dois "Maestro" continua válido; todos os fixtures novos de squad-prep têm um coordenador.
- squad-ui F-1441 (editor: trim + case-insensitive) × squad-prep F-1446 (Main: trim, case-sensitive): compatíveis, UI mais estrita.
- squad-ui F-1436 edita `containsMachineResidue` em `src/renderer/lib/user-facing-mission-error.ts:~190`; o planejado F-1470 (`fix/maestro-account-failover`) toca o mesmo arquivo — basear F-1470 em main já com squad-ui.
- Fora do escopo mas afeta a release: `fix/win-hook-endpoint-undefined` conflita com o próprio main (c2c2273ff F-745 em `installer-utils.ts`), precisa de rebase. `fix/maestro-account-failover`, `fix/cross-account-resume` e `fix/companion-qr` estão vazias (HEAD = main) no momento da revisão.

## Ordem de merge recomendada

1. `fix/squad-prep` (regras do Main no store).
2. `fix/squad-io` (fast-forward limpo sobre prep; rodar `squad-store.test.ts`, `tools-domain-mcp-parity.test.ts` e `orch-ipc-authority.test.ts` depois do pouso).
3. `fix/squad-ui` (renderer, independente; rodar `MissionSetup.test.tsx`, `SquadEditor.test.tsx`, `squad-edit.test.ts`).
4. `fix/squad-win`, `fix/worker-account-failover` em qualquer ordem; `fix/win-hook-endpoint-undefined` só após rebase.
5. F-1470/F-1473/F-1472 nascem do main resultante.

Antes de cortar a release, decidir os itens 1 e 2 (F-1449): são os únicos que mudam comportamento documentado ou bloqueiam dado válido de versões anteriores.

## context.accomplished
[
 "Revisão dos 16 commits (10 squad-ui, 6 squad-io, 2 compartilhados) contra os itens de QA F-1434..F-1441 e F-1448..F-1451",
 "Verificação de contexto: parse de datas Windows/POSIX, códigos do pool, saneador de erro, Pet Studio, recipe save, IPC de import, política Hardened",
 "Simulação read-only de conflitos entre squad-ui, squad-io, squad-prep, squad-win, worker-account-failover e win-hook",
 "Memória retida (mem-0025da90) com as pegadinhas da área"
]

## context.blockers
[]

## context.nextSteps
[
 "Decidir F-1449: atualizar contrato do nexus_recipe_save (ou default de roster) e trocar a recusa atômica do import por skip-com-aviso para arquivos antigos",
 "Unificar MISSION_ROSTER_MAX_AGENTS numa fonte (shared)",
 "Basear F-1470 em main já com fix/squad-ui (user-facing-mission-error.ts)",
 "Rebase de fix/win-hook-endpoint-undefined sobre main (conflito com F-745)"
]

## texto
Handoff enviado (handoff-d41cad7e). O Nexus marcou `partial` por exigir captura visual; esta tarefa foi revisão de código somente leitura e nenhuma UI foi exercitada, então fica registrado como não verificado visualmente. Resultado: nenhum REPROVADO; ressalva MEDIUM apenas no F-1449 (contrato do `nexus_recipe_save` e import atômico de arquivos antigos); sem conflito textual entre as branches squad-*; ordem sugerida prep → io → ui.
