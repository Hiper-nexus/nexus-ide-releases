# Nota de release: a missão deixa de refazer trabalho já feito

Rascunho pronto para o corpo da release, no estilo das recentes. O número sai
no ato da publicação (`git fetch && gh release list`, pega o próximo livre):
outra sessão publicou da 0.76.382 à 0.76.406 em duas horas e número escolhido
antes envelhece.

---

Uma landing page feita num pane único saía em cerca de 1 h; a mesma coisa como
missão levava 2–3 h, com o Nexus "fazendo teste, voltando, fazendo teste,
voltando", recusando a entrega e recomeçando do zero — e reclamando que não
fez o teste visual, tendo navegador e Jev dentro dele. Esta release ataca isso.

**O que mudou na missão:**

- **A verificação mecânica válida não é mais jogada fora.** O resultado de
  typecheck, auditoria e portão de regressão era descartado por um prazo de
  5 min mesmo com o candidato idêntico byte a byte — inclusive enquanto o juiz
  independente ainda lia aquele mesmo candidato. Agora ele é preservado
  enquanto houver um juiz comprovadamente lendo, com teto para candidato
  abandonado. Num repositório com suíte grande isso é a diferença entre rodar
  a suíte uma vez ou duas: a deste repositório leva 10 min 22 s.

- **A devolução não recomeça o trabalho do zero.** Todo worker de missão era
  fechado assim que entregava, antes de o Maestro ler. Quando o veredito era
  "refaça", não havia mais pane: a nota caía numa encarnação nova e, sem
  conversa retomável, num pane novo com o brief ORIGINAL — e a captura de tela
  anterior deixava de valer, então o teste visual era refeito. Agora o worker
  espera o aceite, e "refaça" chega ao pane morno, que já sabe o que tentou.

- **A entrega visual não é mais cobrada duas vezes.** O portão visual pede uma
  captura do navegador; a revisão de evidência, logo antes, pedia saída de
  teste — que numa página não existe — e devolvia a entrega por falta de
  verificação. As duas cobranças não podiam ser satisfeitas juntas. Agora a
  captura verificada conta como evidência quando tudo que mudou é asset inerte
  (folha de estilo, imagem, fonte). Quando a entrega executa — um `.html`
  carrega JavaScript —, a exigência fica, mas o pedido deixa de ser impossível:
  em vez de "cole a saída de testes", o Nexus pede o que ali é obtível, o
  console do navegador sem erro ou o comando que subiu o preview.

- **A doutrina ensina a aceitar, não só a devolver.** Nas três portas o único
  gesto ensinado era recusar, e cada recusa custa uma rodada inteira de modelo.

- **O turno de abertura não é mais gasto num quadro vazio.** Num objetivo de
  uma linha o Maestro gastava a primeira rodada listando entregas inexistentes.

- **A janela do aceite é amostrada e tem teto.** Ela era medida uma vez, no
  fim: um Maestro ocupado até o último segundo tinha 1 segundo para pedir
  ajuste. Agora a janela recomeça quando ele fica livre, e um Maestro ocupado
  sem parar não segura o pane indefinidamente.

**O que a medição mostra, e o que ela não mostra.** Com o mesmo trabalho no
mesmo motor e sem modelo nenhum dos dois lados, um pane só leva 7,47 s e a
missão 11,82 s: a cerimônia custa 4,35 s (1,58×), medido em três repetições
com desvio de 0,09 s. Quatro segundos não viram duas horas — logo a lentidão
nunca esteve no motor, e sim nas rodadas de modelo a mais que ele provocava. É
isso que estas mudanças tiram. **Não há cronômetro de ponta a ponta com modelo
real:** a comparação de 1 h contra 2–3 h é relato de campo, não medição desta
release, e quanto cada mudança economiza numa missão real ainda não foi medido.

Diagnóstico completo, com arquivo e linha, em
`docs/analysis/2026-10-21-missao-lenta.md`.
