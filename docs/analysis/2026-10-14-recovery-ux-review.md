# Retomada de missões e usabilidade — 14/10/2026

Pedido: recuperar corretamente depois de fechar/abrir o Nexus, tornar a retomada fácil de encontrar e eliminar controles que prometem ações recusadas pelo runtime. Evidência: interface instalada inspecionada, duas capturas enviadas pelo operador e componentes reais renderizados em perfil de teste sem acesso às sessões do operador.

## Fluxo observado

1. **Terminais — atrito alto.** A barra oferecia Dormir e Reiniciar em panes cujo ciclo de vida pertence à missão. Dormir é recusado no terminal-host; Reiniciar não executa o reinício individual anunciado. O botão Orquestrador era informativo, mas tinha aparência de ação e handler vazio. F-387 substitui as ações incompatíveis por acesso ao Quadro ou retomada canônica, com andamento e erro.
2. **Quadro geral — navegação funcional.** O cartão abre a missão, mas exige que a pessoa saiba que os controles estão dentro dele. O novo atalho no pane reduz essa dependência. Nenhuma missão real foi encerrada para testar navegação.
3. **Mapa da missão — ação principal escondida.** O cabeçalho desktop combinava título, estado, telemetria, motivo e comandos em quatro colunas com altura fixa e recorte. F-031 reserva uma linha para os comandos, com quebra em qualquer largura. Capturas de prévia em áreas de 1200px e 900px confirmam o botão inteiro dentro do cabeçalho; clique com falha simulada mostrou mensagem e manteve nova tentativa disponível.
4. **Abertura do aplicativo — bloqueio funcional reproduzido.** Uma consulta de autoridade em retry prendia o lote inteiro de restauração, mesmo com outra missão já autorizada. F-386 libera panes individualmente, preservando a validação do Main e a geração do workspace; avulsos seguem sua própria política. Teste novo visto vermelho e depois verde.

## Decisões de implementação

- A autoridade continua no Main. A interface não mata nem recria diretamente processos de missões vivas.
- Missão concluída aguardando revisão ou blocked_user comum abre o Quadro. A toolbar não infere a existência de pergunta registrada apenas do rótulo blocked_user.
- Sem liberação por timeout: o pane sem autoridade continua retido e visível.
- O cabeçalho usa os tokens do DESIGN.md. Não foi criado um tema novo.
- A assinatura da toolbar combina campos primitivos com a assinatura existente de categoria. O orçamento de zero renders por broadcast sem mudança visível e três assinaturas por pane permanece inalterado.

## Próximas oportunidades, fora desta correção

- Trocar vocabulário como “Foco Stage” e “Fim” por ações mais explícitas, com validação de uso e atalhos preservados.
- Mover hashes de branch e identidades técnicas para detalhes; usar o espaço principal para objetivo, próximo passo e eventual impedimento.
- Oferecer uma visão resumida do trabalho antes do grafo para pessoas iniciantes, mantendo o mapa como ferramenta de acompanhamento.

## Limites da evidência

As capturas da prévia usam os componentes e CSS reais, com respostas de IPC simuladas. Provam geometria, acesso ao comando e tratamento visual de falha, não a retomada de uma CLI externa real. Testes de contrato cobrem o portão de restauração; a release precisa ainda dos gates canônicos de pacote, missão, assinatura e notarização. Acessibilidade completa não foi certificada.

As imagens ficam somente em `release-artifacts/ux-review/`: `01-terminais.png`, `02-quadro.png`, `operator-mission.png`, `operator-toolbar.png`, `04-retomada-1200.png`, `05-retomada-900.png`. Capturas do operador não são incluídas nos assets públicos da release.
