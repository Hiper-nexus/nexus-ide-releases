# Nexus: usabilidade, presença e release macOS

Pedido: tornar o produto mais fácil para pessoas sem experiência técnica,
melhorar descoberta/configuração/retomada e dar vida à gamificação, incorporando
as melhorias da versão Windows na próxima release Mac.

## Base preservada

- Candidata existente `release/mac-076273-monitor`, base Windows 0.76.272
  (`d8359c414`), com F-388 e F-389 já integrados. Não alterar o checkout principal.
- Preservar contas, missões, panes, worktrees e o app instalado do operador.
- DESIGN.md manda: identidade Pink City, ações primárias neutras, texto legível,
  motion com significado, modo sóbrio e movimento reduzido respeitados.

## Entregas e critérios de aceite

1. **Configuração por intenção.** Entrada orienta conectar IA e personalizar o
   ambiente; ações levam às telas existentes, sem duplicar credenciais ou estado.
   Busca encontra expressões comuns em português, mantém aliases técnicos e
   informa como sair de resultados vazios. Deep links continuam precisos.
2. **Orientação e navegação.** Revisar início, rail, equipe e ações de panes:
   títulos compreensíveis, próxima ação visível, hierarquia e alvos clicáveis.
   Caminhos avançados preservados, sem sobrecarregar o fluxo iniciante.
3. **Missões e retomada.** Estado e recuperação legíveis, acesso perto da missão,
   ações sem clipping em janelas pequenas. Nunca religar missão pelo renderer
   fora da autoridade do Main. Verificar fluxo com perfil isolado.
4. **Gamificação viva.** Lata reconhecível, entrada/estalo/gole com sequência
   perceptível e finita; XP verdadeiro, nada inventado. Sem bloquear entrada,
   sem repintar o terminal, sem animação fora de vista, sóbrio ou movimento
   reduzido. Validar abertura, ganho de XP, interrupção e desmontagem.
5. **Validação visual.** Capturas do renderer real em tamanhos de desktop,
   teclado, movimento reduzido, tema claro/escuro e controles acionáveis.
   Artefatos identificados como teste, não sessões reais do operador.
6. **Release Mac.** Revalidar upstream/versão, resolver os quatro bloqueios
   registrados pela auditoria 272, testes focados e completos, typecheck,
   renderer sinks, E2E, build assinado/notarizado e publicação pelo fluxo
   canônico. Não confundir candidata local com release publicada.

## Sequência

Configuração e busca → gamificação → navegação/retomada → inspeção visual →
revisão independente → gates e release. O objetivo permanece aberto até todas
as entregas estarem verificadas; concluir um componente não conclui a missão.

## Evidência inicial

- Configurações abrem em assinatura/conta; conectar IA exige descobrir outra aba.
- Busca atual compara a frase inteira com cada campo, não combina palavras.
- Lata do pane desenha corpo de apenas 13×26,4 px num SVG de 64×76 px;
  grande parte da área está vazia. Abertura já tem motion finito e XP real:
  reaproveitar esse mecanismo, não criar um segundo.

Status: implementação em andamento; sem nova publicação nesta rodada.

## Primeira onda implementada (15/10)

- F-390: entrada Configuração rápida e busca por intenção.
- F-391: lata maior e animada, respeito ao modo sóbrio/visibilidade, incluindo
  painel vazio; sequência de XP mantém fonte real.
- F-392: Missões na navegação, pendências na faixa fixa e caminho de retomada
  junto da missão no histórico e no Quadro.
- 263 testes em 18 arquivos passaram; typecheck e renderer sinks passaram.
  Revisão independente sem bloqueador após corrigir o agrupamento CSS.
- Capturas/vídeo em `release-artifacts/nexus-ui/`. Renderer real, com dados e
  fronteira de APIs simulados; não são prova do aplicativo instalado.

Ainda faltam: experiência mais expressiva no nascimento do agente (hoje apenas
um chip Subindo), restante da navegação/ações dos panes e equipe, validação no app
isolado, testes/gates da candidata e publicação Mac. Não marcar objetivo completo.
Monitor segue consultando; `holdUntil` até 15/10 21:12 UTC impede revisão/publicação
paralela. Liberar ao concluir a candidata (ou renovar se ainda houver trabalho),
sem desativar o LaunchAgent.
