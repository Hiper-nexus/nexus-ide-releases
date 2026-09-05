# Auditoria de uso — Squads, router, skills e Ralph

Escopo: recursos questionados pelo usuário, rastreados entre interface, IPC, configuração, execução e testes. Não é uma declaração de que todo código sem uso do monorepo foi identificado.

| Recurso | Evidência | Decisão |
|---|---|---|
| Ralph loop | A preferência `missionDriverActiveMode` só era consumida pela própria tela; runtime antigo removido em agosto | Controle e preferência removidos; configurações legadas continuam carregando |
| GoalDriver | Bootstrap iniciava timer de 30s com gatilhos vazios e efeitos sem implementação; só testes forneciam trabalho | Três módulos, testes exclusivos e bootstrap/shutdown removidos |
| Squads | Cadastro persistente e consumidores por voz/MCP existem; fluxo visual Nova Missão não tinha seletor | Dados/backend preservados; adicionada ação Usar integrantes. Instruções globais não são transportadas pelo contrato atual |
| Router | Chamada real pelo IPC classificou landing page + segurança e sugeriu `impeccable`/`bridgesecurity` em 1,25 s | Manter: há efeito operacional comprovado |
| Skills | Política por papel/objetivo, filtragem por permissões, espelhamento para CLI e sugestão no prompt têm consumidores reais | Manter esses caminhos; não confundir instalação/sugestão com leitura ou aplicação comprovada |
| Disciplina sênior / Design profissional | Opções injetam instruções em `worker-handoff-contract.ts` | Manter como orientações, corrigindo textos que prometiam garantia automática |

## Router e skills

A prova do router está em `docs/qa/evidence/2026-09-04-feature-usage/router-live.json`. Não foi uma resposta inventada pelo renderer: foi chamada pela API real `window.nexus.mission.routeIntent` no DEV.

O fluxo observado é:

1. Router devolve classificação e sugestões de um vocabulário pequeno.
2. O preparo valida `routingAdvice` e limita as sugestões ao conjunto autorizado da equipe.
3. A política de skills do Main define permissões por papel, objetivo e modo da missão.
4. `skill-mirror.ts` materializa as skills permitidas na estrutura esperada pela CLI.
5. `mission-fast-lane.ts` acrescenta uma orientação para consultar as instruções sugeridas.

81 testes de router, política, hints e espelhamento passaram nesta auditoria. Isso prova os mecanismos testados, **não prova que uma LLM leu e aplicou corretamente uma skill numa missão específica**. A missão de biblioteca da revisão anterior não deve ser usada como evidência de aplicação de Impeccable. O catálogo geral de skills também não equivale ao vocabulário automático do router.

## Squads

O caminho por voz `open_squad` já copiava agentes para o preparo. O contrato atual recebe um roster, sem transportar a identidade e as instruções globais do squad salvo. `open_squad_picker` dizia abrir um seletor, mas levava à etapa de equipe sem seletor. Além disso, um squad novo tinha apenas coordenador e executor, embora a missão normal exija revisor independente.

A ação Usar integrantes foi implementada, preserva o objetivo e não inicia a missão. Novos squads incluem coordenador, executor e revisor. Antigos sem papel necessário abrem a etapa de equipe com aviso de ajuste, sem alteração silenciosa. Pet Studio mantém a entrada dedicada. O seletor por voz agora abre o catálogo real. A interface explica que instruções globais do catálogo não são transportadas por essa ação, e que permissões/skills seguem a política do Main.

## Por que alguns nomes antigos permanecem

O gate `ContextWorkflowService.isMissionDriverComplete` tem consumidor real em `tools-domain.ts`. Migrations e receipts carregam histórico e validações operacionais. Remover o toggle órfão e o timer vazio não justifica apagar esses mecanismos por conterem o nome antigo “driver”.

Registros da limpeza: F-308 e F-129. Alterações locais; sem atualização do app instalado.

## Validação da limpeza

- Ralph/GoalDriver: 31 testes focados, typecheck e auditoria do renderer aprovados. Foram retirados 552 linhas dos três módulos inertes e 318 linhas de testes exclusivos; a quantidade inclui código sem função operacional, não redução de funcionalidade ativa.
- Squads: 146 testes focados aprovados. No DEV real, Landing Page → Usar integrantes abriu a preparação com os cinco integrantes, mantendo papéis, CLIs, modelos e instruções individuais iguais aos dados salvos. Nenhuma missão foi iniciada. Evidência em `docs/qa/evidence/2026-09-04-feature-usage/squad-members-live.json`.
- Router/skills: 81 testes de classificação, política de autorização e espelhamento aprovados; resposta real do router registrada. Leitura/aplicação correta por uma LLM numa missão específica permanece fora dessa prova.

Registros adicionais: F-309. Sem commit ou publicação; o aplicativo instalado não foi atualizado.
