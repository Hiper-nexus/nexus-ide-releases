# Revisão da interface Harness

O catálogo usa grupos de finalidade (Investigar, Implementar, Revisar, Sem classificação), filtros com labels e campos padrão, detalhes do recurso recolhíveis e descrições com IA opcionais. A contagem de classificação não é apresentada como prontidão ou cobertura operacional. Loading, falha, ausência de recursos e ausência de resultados têm estados distintos.

As três áreas permanecem: Recursos instalados, Fluxos prontos (reusa RecipesSection) e Conexão de agentes. A conexão ACP preserva seleção de transporte, catálogo real de presets, teste, definições próprias e remoção. JSON fica sob Adicionar agente personalizado. MCP permanece acessível pela rota real de configuração; permissões e backend não foram alterados.

## Verificação

- 12 testes passaram; `tests.log` registra as suítes. Há avisos do canvas ausente do jsdom vindos das dependências de catálogo; não foram considerados prova visual.
- Typecheck passou; renderer sinks encontrou 0 sinks executáveis.
- Antes/depois e tema claro foram capturados e vistos em 1826×853, com SettingsWorkspace real e dados fictícios. A casca da prévia reserva o espaço do rail do aplicativo, sem controlar o DEV.
- Também foram vistos inventário e ACP em 960×560 e 560×720, com rolagem da própria área de Configurações. Medidas no compacto: sem overflow horizontal no documento, filtros ou linhas; ações ACP dentro de suas linhas e editor personalizado inicialmente recolhido.
- Busca sem resultado e Limpar filtros foram exercitados. Erro inicial ACP foi simulado e recuperado por Tentar novamente. Todos esses callbacks usaram somente fixtures em memória.
- RecipesSection foi preservado sem reescrita. Não se declara que esta prévia validou todos os fluxos de backend, execução ACP ou credenciais reais.
