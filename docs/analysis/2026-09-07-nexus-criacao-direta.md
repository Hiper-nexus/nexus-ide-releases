# Criação direta: interface do Nexus para quem não programa

Direção do usuário em 07/09/2026: descrever o resultado, deixar o sistema trabalhar e pedir mudanças depois. Configurar equipe, escolher modelos e aprovar etapas técnicas não deve ser o caminho obrigatório.

## Mudança implementada

O Início monta o formulário real de criação. O mesmo campo usado para iniciar a missão aparece na primeira tela, inclusive quando um projeto salvo é restaurado. A tela intermediária de tutorial deixa de ser a entrada do produto.

- Um pedido amplo e uma ação principal: **Iniciar criação**.
- Projeto apresentado pelo nome; caminho disponível para inspeção.
- Equipe recomendada resumida. Personalização e fluxo manual são opcionais.
- Critérios e referências ficam recolhidos e preservam seus valores ao abrir/fechar.
- Uma única ação **Novo pedido** na navegação, acima do histórico.
- Acesso explícito a abrir projeto, terminais, quadro, memória e configurações.
- Status legíveis, sem repetir projeto e branch em cada trabalho.
- Cabeçalho com projeto/destino e utilidades agrupadas.
- Seletores da equipe se adaptam ao espaço do painel, inclusive com a navegação lateral presente.

Com projeto e IA conectados, a interação padrão é **pedido → iniciar → acompanhar a entrega**. A interface reaproveita os mecanismos existentes de preparação/início e seus contratos de autoridade. Não foi criado um novo motor nem removido o controle sobre o escopo executado.

## Comparação visual

As capturas usam componentes e CSS reais com dados fictícios, em um harness local sem main/preload/PTY ou credenciais. Elas comprovam a apresentação do formulário e da navegação, não a execução de uma missão. A baseline foi congelada de HEAD antes das alterações.

| Antes | Depois |
|---|---|
| [Início com tutorial intermediário](../qa/evidence/2026-09-07-autopilot-ui/before-home.png) | [Pedido diretamente no Início](../qa/evidence/2026-09-07-autopilot-ui/after-home.png) |
| [Formulário com todos os seletores expostos](../qa/evidence/2026-09-07-autopilot-ui/before-express.png) | [Equipe opcional adaptada a 900px](../qa/evidence/2026-09-07-autopilot-ui/team-controls-900.png) |

Foi usada como referência de composição a captura local do BridgeSpace `docs/analysis/bridgespace-3418-extract/visual/03-bridgespace-main.png`: navegação previsível, cabeçalho contido e canvas dominante. Tokens, ícones e identidade continuam sendo do Nexus, conforme `DESIGN.md`. As demais imagens encobertas pelo modal de recuperação não foram tratadas como prova das telas por trás.

## Verificação e regressões importantes

- Expandir e recolher equipe/detalhes mantém o pedido e os critérios.
- Personalizar uma CLI continua alterando o roster real enviado na preparação.
- Escolher pasta mantém o formulário e carrega o rascunho do projeto escolhido.
- Voltar das configurações preserva o trabalho; fluxo manual e Pet Studio continuam distintos.
- Restaurar um rascunho anteriormente em revisão no Início não prepara uma missão sozinho.
- Iniciar pela home precisa abrir a missão correta e limpar o rascunho consumido; erros devem permanecer visíveis. A revisão independente identificou um guard antigo de destino incompatível com a nova entrada, tratado nesta alteração.
- Teste visual em larguras de 900, 1100 e 1440px. Em 900px, largura da página e do viewport coincidiram; o formulário não apresentou rolagem horizontal. A equipe foi corrigida após uma captura revelar seletores espremidos.
- Navegação por teclado entre os disclosures com foco visível. Com movimento reduzido habilitado, o formulário apresentou `animation: none` e seu conteúdo permaneceu acessível.

Validação final: **196 testes passaram em 12 arquivos** de renderer, componentes e navegação; typecheck aprovado; auditoria de renderer com **0 executable DOM sinks**; diff-check limpo. CodeRabbit terminou sem apontamentos e a revisão independente adicional identificou e confirmou o reparo do guard de início pela home. [Resultados e hashes das fontes](../qa/evidence/2026-09-07-autopilot-ui/verification.json).

Findings: [F-332](../qa/items/F-332.md), [F-333](../qa/items/F-333.md), [F-334](../qa/items/F-334.md). As capturas `team-expanded-*` e `empty-900.png` registram etapas intermediárias de diagnóstico; `team-controls-900.png` e `empty-1440.png` mostram os estados corrigidos. O harness temporário e seu servidor foram removidos ao concluir a validação.

## Limites da entrega

Pasta de projeto e conexão com uma IA continuam sendo pré-requisitos. Escrever um pedido antes de escolher a pasta ainda depende de uma política de transferência de rascunhos; habilitar apenas o campo perderia texto ou sobrescreveria um rascunho existente.

Esta rodada valida a experiência de criação e suas integrações de renderer. Não executou uma missão real multi-CLI nem certificou autonomia de ponta a ponta. As falhas de conclusão/revisão identificadas no [comparativo de autonomia](2026-09-07-nexus-autonomia-comparativo.md) continuam com seus próprios findings. As mudanças visuais não autorizam anunciar software verificado quando o motor ainda não comprovou isso.
