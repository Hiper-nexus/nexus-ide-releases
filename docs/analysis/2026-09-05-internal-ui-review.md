# Revisão das páginas internas — 5 de setembro de 2026

A revisão atua em dois problemas: legibilidade/navegação e fidelidade dos estados apresentados. Uma página vazia, uma cota desconhecida ou um recurso instalado não deve ser apresentado como erro de login, consumo zero ou integração operacional.

## Alterações

| Área | Resultado | Evidência |
|---|---|---|
| Estrutura compartilhada de Configurações | Conteúdo usa o canvas disponível; títulos e orientações legíveis; navegação compacta mantém todas as páginas; retorno e perfil permanecem acessíveis | F-312, SettingsWorkspace.test.tsx, capturas 2026-09-05-settings |
| Uso e cotas | Conta, conexão e serviço fornecedor identificados; ausência de percentual explícita; precisão de frações; origem/horário por entrada; erro com retry sem barras antigas | F-315, UsageQuotaSection.test.tsx, quota-display.test.ts |
| Harness | Inventário por finalidade, busca e filtros, detalhes técnicos recolhíveis; fluxos e ACP separados; erro inicial ACP recuperável | F-314, capturas 2026-09-04-harness |
| Projeto, Quadro e Memória | Hierarquia e ações diretas, estados vazios/erros úteis, layout que cabe em canvas de 490 px | F-313, capturas 2026-09-04-product-pages |
| Minha conta | Falha inicial de consulta deixa de prender em carregamento; retry antes de exibir planos; texto sem caminho interno de licença | AccountSection.test.tsx |
| CLIs e plugins | Falha ao enumerar ferramentas não monta catálogo falso vazio; loading, erro e retry no frame | SettingsWorkspace.test.tsx |

## Verificação e limites

Prévias usam componentes reais com dados fictícios, sem consultar credenciais, cobrança ou serviços de IA. Foram inspecionados estados com dados, vazio, carregando e erro; temas claro/escuro; larguras de janela de 740, 1100 e 1440 px, além das capturas específicas das demais páginas. Em Harness, a adaptação considera a largura do próprio conteúdo.

A estrutura compartilhada beneficia todas as rotas de Configurações. Isso não significa que todas as integrações de cada página foram executadas de ponta a ponta. O catálogo representa recursos disponíveis, não prova de sua aplicação por uma LLM em uma missão. A correção de seleção de credenciais e de concorrência de quota no Main tem revisão independente em F-401; consultas reais ficam suspensas até essa revisão terminar.

Não houve publicação, atualização do app instalado ou alteração de plano de assinatura.

Uma segunda revisão identificou perda de foco quando o título provisório de CLIs/plugins era substituído. F-319 registra a correção: o título carregado recebe foco somente se o foco anterior se perdeu com a remoção do elemento, sem interferir em uma interação posterior do usuário. A suíte SettingsWorkspace cobre as duas situações. F-317 e F-318 separam os bugs de enumeração de CLIs e de consulta da conta.

## Conferência final no DEV

Após 255 testes Main/quota/auth isolados, typecheck, renderer sinks e replay independente dos quatro problemas de segurança/concorrência, a versão de desenvolvimento foi reiniciada. Em 5/9, a consulta real retornou Claude 0% em 5h e11% semanal, Codex71% semanal com 5h desconhecido, GLM1% em5h/11% semanal/1% MCP mensal. Esses valores são observações daquele momento, não saldo atual garantido. Das16 conexões listadas,13 não retornaram cota confirmada; permanecem desconhecidas, sem inferir zero ou falha de login.

O resumo e a página priorizam cotas confirmadas (F-321), mantendo as demais conexões disponíveis. No Harness real,115 recursos foram listados; busca sem resultado e Limpar filtros foram exercitados. A página Agentes também foi conferida com catálogo local real. Capturas `dev-*` em `docs/qa/evidence/2026-09-05-settings/` representam o DEV; as demais prévias usam fixtures.

Catálogos (F-316) concluídos com64 testes: carregamento/erro/vazio, retry, filtros e detalhes progressivos. Limite remanescente: o scanner Main ainda pode converter erro de filesystem em lista vazia; o renderer só distingue falhas que o IPC reporta.

A alteração final de ordenação de cotas passou em40 testes renderer/helper, typecheck e sinks0, sem alterar Main. A verificação visual real não mostrou overflow horizontal em1280×820. O app instalado em/Applications continua separado e não foi atualizado por esta revisão.

O teste final pelo atalho da barra lateral revelou abertura incorreta de Minha conta. F-322 corrige a ligação para Uso e cotas;54 testes App/WorkspaceRail passaram, typecheck/sinks0 e clique real confirmaram a rota correta. O NexusIDE Dev ficou aberto nessa página para inspeção.

## Continuação: linguagem e detalhes progressivos

Alterações em andamento no worktree:

- Mídia: conexão e chave de acesso em linguagem simples; modelos, variável de ambiente e ferramenta MCP ficam em detalhes recolhidos; removida indicação editorial fixa de modelos favoritos.
- Captura de tela (antes Vision): explicação de envio à nuvem, autorização limitada à sessão e instruções de permissão sem termos internos de IPC/token. O controle de consentimento ganhou nome acessível explícito.
- Experimental (antes Labs): cada recurso explica seu efeito; removidos IDs técnicos da apresentação principal, preservados em `data-flag-id`; estados de bloqueio e personalização continuam visíveis.

Estas alterações ainda não têm conferência visual no aplicativo. Os testes de componentes não substituem essa conferência. A revisão global de todas as seções, o inventário de logos e a verificação do uso de design em todos os caminhos de missão permanecem abertos. Não interpretar as melhorias compartilhadas ou as tabelas anteriores como conclusão dessas três obrigações.

### Conferência no Dev e segunda revisão de Mídia

O Dev foi iniciado com CDP local em 9337 (sessão de execução 96346). A navegação nativa confirmou Mídia com seis serviços e Experimental com os recursos reais. A captura inicial mostrou que os formulários de conexão ainda dominavam Mídia: passaram a ser recolhidos em Gerenciar conexão/Conectar serviço, com botões compactos. Logos locais de Google, OpenAI, Replicate e ElevenLabs foram adicionados pelo componente compartilhado; a árvore de acessibilidade confirmou os seis serviços identificados por imagem e conexões recolhidas após HMR.

Mídia também recebeu recuperação de erro de leitura e de atualização de chave: não relata remoção quando o IPC falha, libera o botão após rejeição e permite tentar novamente. Três testes focados cobrem detalhes recolhidos, retry de leitura e falhas de remoção.

Experimental revelou seis IDs sem tradução no catálogo real; os textos foram completados e um teste verifica cobertura de todos os BUILTIN_FEATURE_FLAGS. A captura via automação apresentou atraso em relação à árvore de acessibilidade; a conferência visual final das alterações mais recentes ainda não está encerrada. Não houve criação de missão nem salvamento/remoção de credenciais durante a navegação.

### Referências de design e vínculo com missões

Design Systems foi renomeado para Referências de design. A introdução explica finalidade e revisão da proposta; IDs, caminho de destino e fonte ficam em detalhes. Busca e importação recuperam falhas de transporte (F-324).

F-130 corrige o caminho rápido de missões para reconhecer o contrato aplicado em `.context/docs/design-system.md`, usando o resolvedor compartilhado; DESIGN.md na raiz continua prioritário. 53 testes Main passaram, incluindo regressão que falhava antes da alteração. Isso prova resolução e inclusão no prompt, não obediência da LLM nem cobertura de todos os caminhos de delegação. Essa verificação global continua pendente.

## Cobertura integral após continuação

A cobertura atual por destino está em `internal-settings-coverage.md`, com os 31 menus, Perfil e submenus percorridos. Foram revisados também Voz, Aparência, Terminal, Atalhos, Providers, comparação, Equipes/editor, MCPs, os catálogos, automação, Diagnóstico, Sistema, Auditoria e acesso remoto. A rodada final passou 414 testes em 46 arquivos, typecheck e auditoria do renderer. Uma revisão independente não encontrou regressões críticas/importantes; seu apontamento sobre diagnóstico de voz foi corrigido e testado. F-131 registra a regra permanente de leitura do contrato no caminho compartilhado dos agentes. O catálogo de modelos e configurações avançadas foi recolhido em Equipes, e a janela menor motivou correções de filtros e truncamento de nomes.
