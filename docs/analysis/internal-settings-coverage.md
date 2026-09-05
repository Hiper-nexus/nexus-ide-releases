# Revisão integral dos menus de Configurações

31 destinos da navegação percorridos no NexusIDE Dev, além de Perfil e mascote, das sete abas de Voz, das três abas de Providers, das três abas de Harness e do editor de equipe. A revisão preserva nomes próprios e dados fornecidos pelos catálogos. Capturas e árvores de acessibilidade foram conferidas na sessão de revisão; os testes não substituem essa observação.

| Rota | Menu | Revisão |
|---|---|---|
| `account` | Minha conta | Orientações de conta e equipe simplificadas; plano e estados reais preservados. |
| `voice` | Voz | Página e sete abas internas percorridas; rótulos, logos e diagnóstico recolhível. |
| `appearance` | Aparência | Introdução e opções em português; tema atual preservado. |
| `terminal` | Terminal | Métricas técnicas recolhidas; configurações usuais visíveis. |
| `shortcuts` | Atalhos | Atalhos compartilhados com descrições claras. |
| `providers` | Providers | Três abas percorridas; logos e custo/disponibilidade em português. |
| `usage-quota` | Uso e cotas | Conferida no Dev; cotas desconhecidas continuam distintas de zero. |
| `ranking` | Comparar modelos | Comparação em português; notas de demonstração identificadas; logos mantidos. |
| `squads` | Equipes | Modelo atual compacto; catálogo e opções avançadas recolhidos; nomes legíveis em janela menor; editor com logos. |
| `harness` | Harness | Catálogo e três abas percorridos; agrupamento e detalhes progressivos preservados. |
| `mcps` | MCPs | Ações traduzidas, logos nos destinos e matriz técnica recolhida; nenhuma sincronização executada. |
| `tools` | Ferramentas | Documentação completa recolhida por ferramenta; busca mantida. |
| `media` | Mídia | Serviços com logos e conexão recolhida; status compacto; falhas de chave e carregamento recuperáveis. |
| `agents` | Agentes | Catálogo percorrido; busca, finalidade e detalhes já organizados preservados. |
| `skills` | Instruções | Catálogo percorrido; instruções, filtros e detalhes já organizados preservados. |
| `llms` | Ferramentas de IA | Logos nas ferramentas instaladas e disponíveis; modelos extensos continuam recolhidos. |
| `media-catalog` | Modelos de mídia | Modelo padrão visível; lista completa recolhida; logos e tipos de mídia. |
| `marketplace` | Marketplace | Introdução e tipos em português; catálogo e filtros percorridos sem instalar recursos. |
| `design-systems` | Referências de design | Finalidade clara; importação identificada como proposta; falhas recuperáveis. |
| `recipes` | Fluxos de trabalho | Formulário técnico, requisitos e pendências recolhidos; contagem preservada. |
| `plugins` | Plugins | Lista percorrida; logos para integrações reconhecidas; detalhes de arquivo recolhidos. |
| `hooks` | Eventos | Lista percorrida; nomes técnicos de registros preservados, detalhes recolhidos. |
| `rules` | Regras | Busca e filtro por equipe; janela menor e busca sem resultados conferidas. |
| `diagnostics` | Diagnóstico | Terminologia simplificada; estado e diagnóstico continuam disponíveis. |
| `system` | Sistema | Estado da atualização legível; verificações técnicas recolhidas; erro com nova tentativa. |
| `vision` | Captura de tela | Consentimento explicado em português; controle com nome acessível; nenhum acesso concedido. |
| `audit` | Auditoria | JSON e origem da consulta recolhidos; eventos e estados preservados. |
| `labs` | Experimental | Todos os recursos do registro têm título e descrição; teste cobre ausência de tradução. |
| `remote` | Remoto | Servidores e acesso local identificados; termos simplificados; identidade da IA junto do seletor. |
| `companion-relay` | Acesso pelo celular | Finalidade e recurso desligado explicados sem detalhes do transporte. |
| `connectors` | Conectores | Finalidade e manutenção do acesso explicadas sem termos do protocolo. |
| Perfil | Perfil e mascote | Painel percorrido; termos de progresso simplificados; editor de equipe também conferido com botão de fechar legível. |

## Verificação

- 414 testes em 46 arquivos passaram na rodada final (Configurações, editores, voz e motor).
- Typecheck e auditoria de sinks do renderer passaram; `git diff --check` sem erros.
- Revisão independente do diff: sem achados críticos/importantes; diagnóstico de serviços de voz preservado em detalhes após um apontamento menor.
- Conferência em janela larga e menor; ajuste adicional do filtro de Regras e dos nomes de Equipes após observação. Busca sem resultados e restauração da lista de Regras exercitadas no app.
- Navegação somente leitura: não houve sincronização MCP, alteração de credenciais, assinatura, permissão de captura ou ativação de acesso remoto. Esses serviços externos não foram reconfigurados para testar a aparência.

## Contrato de design no motor

`missionDesignContext` usa o resolvedor canônico: DESIGN.md na raiz tem prioridade sobre `.context/docs/design-system.md`. O ponto compartilhado de abertura de agentes aplica `withWorkspaceDesignRule` também quando a carta opcional de Design profissional está desligada; a resolução considera o checkout de execução. A instrução exige leitura antes de editar UI e identificação da referência e da verificação visual na entrega. O catálogo complementa o contrato, e proposta ainda não aplicada não é tratada como autoridade.

Isso estabelece a regra entregue ao agente, com teste da passagem pelo prompt inicial nativo do worker. Não é uma prova de que uma LLM arbitrária obedeceu em toda execução; o resultado de uma missão ainda deve ser verificado contra o contrato.
