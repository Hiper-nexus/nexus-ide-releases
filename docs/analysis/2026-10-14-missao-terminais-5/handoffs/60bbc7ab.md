# handoff-60bbc7ab-e074-460f-a31e-576c69f4afaa | Codex | partial
Revisão dos seis commits concluída: 04e82fc20 reprovado por regressão HIGH POSIX/DST; uma ressalva LOW e duas lacunas anteriores. Probes executados; suíte integral e UI renderizada não verificadas.

## texto
Revisão somente leitura de main 152c77e823 → fix/windows-heavy-pid-squads@04e82fc201 e fix/squad-io@d3fa86922a. São seis commits distintos: os dois de PID também são ancestrais de squad-io. Nenhum arquivo alterado; WIP em src/main/orch/stack-advisor-manifest.ts preservado. Três camadas independentes: Blind Hunter, Edge Case Hunter e Acceptance Auditor.

| Commit / QA | Veredito |
|---|---|
| cc70bff7f / F-1434 | APROVADO COM RESSALVA: R2 LOW. A conversão MSYS→Win32 corresponde à causa; testes novos distinguem a implementação anterior. |
| 04e82fc20 / F-1435 | REPROVADO: R1 HIGH, reproduzido contra main. |
| d60bc2a3f / F-1448 | APROVADO: exporta catálogo próprio e ignora IDs gerenciados sem sobrescrevê-los; confirmação mantém hashes/CAS. |
| 20d023297 / F-1449 | APROVADO COM RESSALVA: regras de coordenador/12 integrantes corretas; fechar a lacuna de nomes duplicados na integração com squad-prep. |
| 1b7eed6e6 / F-1450 | APROVADO COM RESSALVA: resolve ID/nome único e recusa desconhecido; permanece a corrida anterior durante a baseline. |
| d3fa86922 / F-1451 | APROVADO: decoder/BOM convergem na importação e migração; probes confirmaram os formatos prometidos. |

Achados novos, por severidade:

1. **R1 — HIGH — 04e82fc20 — src/main/pty/pty-descendant-termination.ts:237.** O filtro temporal também atua sobre POSIX, cujo ps lstart contém hora local sem offset. Em America/New_York, pai criado em 2026-11-01T05:50Z aparece como 01:50; filho criado depois, em 06:10Z, aparece como 01:10 após a volta do DST. Date.parse interpreta o filho como anterior e o exclui. Reproduzi em memória usando a função das refs e OwnedCommandProcesses real: main coleta [20,30], ambas as branches coletam [20]; após pai20 sair, mantendo filho30 vivo no inventário, main retorna live e ambas retornam gone. src/main/orch/native-heavy-command.ts:133 libera a reserva ao receber gone: outro comando pesado entra enquanto o primeiro ainda tem processo vivo. Os testes novos usam timestamps ISO absolutos e não detectam essa regressão POSIX. Corrigir a comparação para usar identidade temporal absoluta ou restringir esse filtro ao inventário Windows; adicionar regressão de DST antes de integrar.

2. **R2 — LOW — cc70bff7f — resources/heavy-command/request.cjs:33.** O callback HTTP perdeu o catch externo e accepted acessa result.allow sem validar objeto. HTTP 200 com corpo JSON null agora lança TypeError sem motivo controlado, contrariando “toda recusa diz o motivo”. Probe do callback exato: main encerra com 78; branch deixa escapar a exceção; respostas de concessão e recusa normais continuam corretas. Validar objeto não nulo antes dos campos e testar esse formato inválido.

Lacunas anteriores, sem atribuí-las como regressões destes commits:

- **MEDIUM, integração de squads:** squad-store.ts:903–911 normaliza importação e verifica coordenador/quantidade, mas não nomes únicos. Um maestro e dois executores Dev com IDs distintos importam; squad-prep passa a recusar esses nomes na preparação. F-1446 transfere explicitamente a validação de importação para esta frente. A integração deve aplicar também essa regra e testar atomicidade.
- **MEDIUM, F-1450:** tools-domain.ts:401 resolve o catálogo antes do await da baseline (:402), sem revalidá-lo antes de missions.create (:453). Excluir o squad durante a captura ainda permite gravar ID inexistente. Já era possível na base; a correção cobre catálogo estático. Falta de selo na criação também é anterior e está declarada no QA.

Conflitos e merge:

- squad-io × squad-prep coincidem em squad-store.ts, squad-store.test.ts, ModuleSections.tsx e SettingsSquads.capabilities.test.tsx. O merge-tree de leitura não mostrou marcadores de conflito, mas a lacuna semântica de nomes exige resolução.
- squad-ui e squad-win compartilham os mesmos dois commits de PID, sem alterações adicionais nos arquivos de squad-io. Não reaplicar esses commits por cherry-pick.
- worker-account-failover@c104757ca e companion-qr@f74eb091f não coincidem com os arquivos desta revisão. Na última leitura, maestro-account-failover e cross-account-resume ainda apontavam para main; seus futuros commits não foram avaliados.
- Ordem recomendada, após corrigir R1: base PID corrigida → squad-io → squad-prep, fechando nomes duplicados → squad-ui → squad-win. Failover/companion podem seguir em paralelo, com revisão própria.

Validações: diff --check limpo nas duas branches; probes em memória de PID reciclado, regressão DST com liveness, seis limites de roster, seis resoluções de squad, oito casos de encoding/BOM e callback HTTP. Inspecionados funções, chamadores e testes. Não executei a suíte integral das branches nem validei UI renderizada; a tentativa com compilador TypeScript expirou após 300 s na fila heavy do pane. Validação executável integral permanece pendente; não há aprovação de release. Nenhum checkout, worktree, stash, reset, commit ou push realizado.

## context.blockers
[
 "Validação integral das branches pendente; tentativa com TypeScript expirou após 300 s na fila heavy do pane."
]

## context.nextSteps
[
 "Corrigir R1 e adicionar teste de DST com filho vivo após a saída do pai.",
 "Fechar a validação de nomes duplicados na integração squad-io/squad-prep.",
 "Executar suítes das branches integradas e verificar a UI renderizada antes da release."
]

## texto
Handoff enviado: `04e82fc20` reprovado por regressão HIGH em POSIX/DST. Relatório inclui ressalvas, conflitos, ordem de merge e validações pendentes. Nenhum arquivo alterado.
