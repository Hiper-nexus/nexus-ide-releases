# Configuração de painéis: orientação nas duas etapas reais

- Escopo: TerminalGridDialog, TerminalGridPanels e terminal-setup.css. Launcher, App, app-shell.css e backend não foram alterados nesta tarefa.
- A etapa 1 explica pasta e painéis, mantém o atalho Abrir sem IA e dá foco inicial a Escolher pasta.
- A etapa 2 explica CLIs no contexto de ferramentas de IA, permite misturar IA e terminal comum e preserva modelo/conta por painel.
- O resumo antes da abertura informa pasta, quantidade e distribuição entre com/sem IA. Estado indisponível não é contado como uma IA pronta.
- Espera distingue a janela de escolha de pasta da abertura dos painéis. A confirmação existente para encerrar sessões de outra pasta permanece.

## Evidência

`red.log` mostra as três regressões falhando antes da implementação. `tests.log` registra 15 testes focados aprovados, incluindo os fluxos preexistentes de modelo/conta, navegação, preservação de sessões, limites e confirmação. Typecheck e renderer sinks estão nos logs correspondentes.

As imagens foram renderizadas com **AppShell e TerminalGridDialog reais**, em arquivo local isolado, com providers e pasta de exemplo. Não acessam o DEV nem abrem um PTY de produção.

- `layout.png`: 1440×900, primeiro uso sem pasta.
- `mixed.png`: 1440×900, um painel Codex e dois sem IA.
- `small-height.png`: 960×560, corpo rolável e resumo/ação sempre visíveis.
- `compact.png`: 560×640, escolhas e resumo em largura compacta.

Todas foram inspecionadas visualmente. Em 960×560, o painel ocupa x16/y16 até y544; o rodapé ocupa y423–543, e o botão principal y487–527. A largura do documento não supera o viewport. A seleção de pasta, avanço e escolha do Codex foram exercitados na prévia. Não se afirma que esta prévia valida autenticação ou execução real de agentes.
