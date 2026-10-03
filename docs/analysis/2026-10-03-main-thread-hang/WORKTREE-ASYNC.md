# F-764 — criação de worktree sem bloquear o Main

03/10/2026. Branch `fix/f764-async-worktree`, base `601e6321` da integração.
Esta entrega cobre o Git síncrono da criação (parte C.5 do HANDOFF).

## Mudança

`WorktreeManager.create` usa `AsyncProcessGitRunner` em todo o percurso:
snapshot de origem, configuração segura, branch existente, `worktree add`,
provas da worktree e revalidação da base. `check-ignore` e a descoberta de
dependências aninhadas também cedem o event loop. A limpeza de uma cópia CoW
parcial usa a remoção assíncrona que preserva a política de não seguir links.

O runner conserva os argv seguros, ambiente filtrado, limites de saída e timeout.
Continuam valendo as recusas por config executável, base alterada, branch/root
divergente, trabalho sujo e conflito de ownership. A reserva CAS continua
exclusiva. Depois dos awaits, a criação e a reutilização recusam uma reserva
que foi encerrada; a falha não apaga nem reativa o registro de outro dono.

O teste de GC foi ajustado: antes esperava que nenhum `setImmediate` rodasse até
o fim do spawn (consequência do bloqueio). Agora verifica que o spawn termina
mesmo com o GC pendurado, mantendo a prova de uma coleta por repositório.

## Evidência

`scripts/benchmark-worktree-create.mts` cria um repositório temporário de 2.048
arquivos e três worktrees usando Git real. Um heartbeat de 5 ms complementa
`monitorEventLoopDelay` de 1 ms: sem isso, uma criação inteiramente síncrona
termina sem nenhuma amostra do histograma e poderia aparentar atraso zero.
Setup e remoção do fixture ficam fora da medição. O script falha se a criação
não ceder ou se o intervalo do heartbeat/atraso máximo atingir 100 ms.

- **Antes (`601e6321`):** 388–488 ms sem nenhum heartbeat durante cada criação;
  o script falhou na asserção de responsividade.
- **Depois:** maior intervalo do heartbeat 6,05 ms; p99 do atraso ≤0,925 ms;
  atraso máximo ≤1,304 ms. A criação inteira ainda levou 402–471 ms, mas o
  processo pôde atender eventos durante esse tempo.
- JSON bruto: `evidence/worktree-create-before.json` e
  `evidence/worktree-create-after.json`.

Reprodução: `node --import tsx scripts/benchmark-worktree-create.mts` (Node 22).

Validação: typecheck completo passou. Seis suítes de runtime passaram (133
testes: worktree-manager, worktree-cow, git-command, worktree-runtime-registry,
worktree-ownership-coverage e worktree-removal-safety). A suíte
`tools-panes-isolated-writer.test.ts` passou com 33 testes após o ajuste da
expectativa de agendamento. Os novos testes falharam antes da correção:
Git síncrono na criação, reserva encerrada reativada e reutilização de registro
encerrado durante a prova assíncrona.

## Limites deste resultado

Não é uma medição do spawn inteiro da CLI nem do ensaio com 15 PTYs. A recuperação
inicial do registry, retomada, merge e outras operações que têm APIs síncronas
continuam fora desta mudança. A regra de lint contra novas chamadas síncronas,
proteções dos taps e validação do profile no aplicativo assinado seguem nas
outras frentes do F-764. A branch não publica nem altera o aplicativo em execução.
