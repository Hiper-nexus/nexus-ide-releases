---
name: Nexus Web
description: Identidade Nexus em produto editorial e comunidade explorável.
colors:
  bg: "#080709"
  surface: "#111013"
  bar: "#0d0b0f"
  lift: "#201e25"
  ink: "#faf7f9"
  muted: "#aaa2a8"
  faint: "#928b90"
  pink: "#ff4f8b"
  whatsapp: "#25D366"
  green: "#7ee2a8"
  gold: "#e5c07b"
  line: "rgb(255 255 255 / .1)"
  strong: "rgb(255 255 255 / .2)"
typography:
  display:
    fontFamily: "Geist Variable, system-ui, sans-serif"
    fontSize: "72px"
    fontWeight: 550
    lineHeight: 1.05
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Geist Variable, system-ui, sans-serif"
    fontSize: "48px"
    fontWeight: 550
    lineHeight: 1.05
    letterSpacing: "-0.04em"
  body:
    fontFamily: "Geist Variable, system-ui, sans-serif"
    fontSize: "16px"
    lineHeight: 1.55
  label:
    fontFamily: "ui-monospace, monospace"
    fontSize: "12px"
    letterSpacing: "0.04em"
  pixel:
    fontFamily: "VT323, monospace"
    fontWeight: 400
rounded:
  compact: "4px"
  control: "8px"
  container: "12px"
spacing:
  s1: "8px"
  s2: "16px"
  s3: "24px"
  s4: "32px"
  s5: "48px"
  s6: "64px"
  section: "96px"
components:
  button-white:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bg}"
    rounded: "{rounded.control}"
    padding: "12px 24px"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px 24px"
  button-pink:
    backgroundColor: "{colors.pink}"
    textColor: "{colors.bg}"
    rounded: "{rounded.control}"
    padding: "12px 24px"
  button-whatsapp:
    backgroundColor: "{colors.whatsapp}"
    textColor: "{colors.bg}"
    rounded: "{rounded.control}"
    padding: "12px 24px"
  mission-case:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "12px 24px"
  mission-case-active:
    backgroundColor: "{colors.lift}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px 24px"
  cockpit:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.container}"
---

# Design System: Nexus Web

## Overview

**Creative North Star: "Nexus mission control and playable dev cafe"**

Fonte de identidade: DESIGN.md do NexusIDE, baseline Linear, referência de interação Bruno Simon. A identidade combina superfícies near-black, hierarquia editorial, controles legíveis e sinais funcionais em rosa. Os tokens normativos acima vêm do código atual; fontes: `src/tokens.css`, `src/product.css` e `src/community.css`.

**Key Characteristics:**
- Superfícies escuras em camadas, com divisórias discretas.
- Geist para leitura e VT323 nos sinais do mundo e da progressão.
- CTA principal branca; rosa comunica interação e estado.

## Colors

### Primary
- **Pink City (`pink`)**: interação, foco, estados ativos e progressão.

### Secondary
- **Entardecer da Pink City (`ember` `#ffb27a`, `dusk` `#ff6f91`)**: atmosfera, nunca componente. Só aparecem como luz difusa em baixa opacidade (o wash atrás do hero e a luz do bilhete do próximo sorteio) e como paleta do mundo jogável; texto, botões e bordas continuam em `pink` e neutros.
- **Concluído (`green`)**: etapas entregues, checks e exemplos de diff positivo.
- **WhatsApp (`whatsapp`)**: verde oficial `#25D366`, reservado às ações que abrem o grupo (CTA da navegação, convite da seção de prêmios e link do painel de estação quando o destino é o grupo). Ícone oficial em SVG monocromático herdando `currentColor`. Texto escuro sobre o verde mantém contraste AA; hover clareia para `#2fe374`.

### Neutral
- **Fundo (`bg`), superfície (`surface`), barra (`bar`), elevação (`lift`)**: separar página, conteúdo, chrome e seleção.
- **Texto (`ink`), apoio (`muted`), metadados (`faint`)**: hierarquia de leitura.
- **Divisória (`line`) e borda forte (`strong`)**: limites leves e contêineres estruturais.

`gold` existe como token de origem, mas não é usado nas duas folhas de superfície; não estabelece uma nova família de componentes.

**The Action and State Rule.** A CTA principal usa branco; rosa comunica interação e estado.

## Typography

Geist Variable sustenta a leitura e a hierarquia editorial; ui-monospace identifica metadados e terminais. VT323 é funcional nos sinais do mundo e da progressão, e reaparece na página do produto como sinal de HUD: o eyebrow do hero (`DEV CAFÉ ABERTO · AGENTES EM MISSÃO`), os numeradores de seção (`01 / MISSÃO` … `07 / DOWNLOAD`, 22px, rosa) e o `PRESS START` do convite à comunidade. É sempre uma linha curta em caixa alta; nunca corpo de texto.

O display do produto usa a definição acima, reduzindo a 60px no breakpoint intermediário e 36px no mobile pela regra específica de `body.product-page`. Headline de seção reduz a 36px; títulos secundários usam 24–36px. A comunidade usa título de 60px, reduzido a 48px; o sinal pixel principal usa 80px, reduzido a 64px. O corpo de apoio varia entre 12–18px, e metadados compactos do cockpit/HUD entre 7–12px. FAQ limita o texto a 70ch.

## Layout

Produto em `nexuside.app`; comunidade em `comunidade.nexuside.app`. A separação de host é requisito explícito. O brief de superfície está em `docs/site-redesign-brief.md`: principal Persuade, comunidade Experience.

Produto: hero editorial com o reel portrait original do usuário inteiro, seguido de cockpit ilustrativo e seções por mecanismo, com a seção de planos entre o manifesto e os downloads. `/conta/` e `/admin/` seguem a mesma identidade, com `noindex` e acesso somente no domínio do produto. O hero desktop divide colunas (1.25fr/1fr), limita a página a 1600px e o reel a 420px. Seções usam até 1440px; mobile empilha as colunas, usa margens de 24px e reel de até 320px. O filme foi composto em 9:16 para Reels e TikTok e reserva o terço de baixo para a interface desses apps; no site esse terço seria um vazio, então o quadro mostra o recorte 5:7 onde a ação acontece (`object-fit: cover`, posição vertical 35%) e a tela cheia mostra o filme inteiro. O respiro vertical de cada seção é 64px (128px entre seções), 48px no breakpoint intermediário e no mobile; blocos de texto e ilustração em duas colunas alinham pelo topo, sem padding vertical próprio, e a ilustração dos companheiros acompanha a rolagem (sticky) enquanto o texto ao lado for mais longo. O FAQ repete a linha de introdução das seções (título à esquerda, apoio à direita) e distribui as perguntas em duas colunas estáveis, o app à esquerda e comunidade, teste e assinatura à direita; no mobile, o texto vem antes da ilustração.

Comunidade: mapa dirigível como primeira tela, canvas ocupando o palco, apresentação que sai ao iniciar, HUD, estações, missões e XP. O palco usa 100svh com piso de 640px no desktop e 840px no mobile; em telas baixas pode ultrapassar o viewport. A navegação textual e os links do grupo permanecem fora do canvas. HUD mobile aparece ao iniciar, com botões de toque de 48px. Breakpoints reais: 1150px no produto, 1000px na comunidade e 760px em ambos. Ritmo de espaço segue a escala normativa acima.

## Elevation & Depth

Profundidade vem de fundos tonais, bordas e sombras difusas localizadas: reel (`0 24px 72px rgb(0 0 0/.4)`) e cockpit (`0 24px 70px rgb(0 0 0/.3)`). O HUD usa near-black translúcido sobre o mundo, enquanto o conteúdo fora do jogo usa superfície opaca.

## Shapes

Controles e panes têm curvas suaves (8px); cockpit, reel, painéis de estação e contêineres de ilustração usam 12px. Marcadores e pequenas teclas usam 4px. Órbitas da ilustração de voz e sinais pontuais são circulares. Bordas mantêm a separação sem deslocamento duro de sombra.

## Components

- **Botões:** branca, outline escura e rosa compartilham padding de 12px/24px, altura mínima de 48px e peso 600. Hover desloca −3px, active escala .98; outline clareia a superfície. Foco recebe contorno rosa de 2px com offset de 5px (a variante WhatsApp usa contorno escuro). A variante WhatsApp só existe em ações que abrem o grupo; a CTA branca continua para todo o resto. Navegação e demo têm variantes menores.
- **Navegação:** wordmark à esquerda, links de 14px e CTA à direita; links clareiam no hover. Mobile oculta links intermediários e preserva CTA e marca.
- **Missão ilustrativa:** seleção de caso, etapas, panes e revisão; caso ativo usa fundo elevado e números rosa. O rótulo de demo permanece visível. Não executa agentes nem ativa microfone.
- **Minha conta (entrar):** os botões de login levam a marca do provedor (G em quatro cores no branco, marca do GitHub em `currentColor` no escuro), empilhados com a mesma largura (até 380px) e 52px de altura; abaixo, três linhas curtas dizem o que a conta libera (teste sem cartão, o mesmo login no aplicativo, acompanhamento da cobrança), sem número fixado no HTML. A mensagem de estado é uma linha quieta com ponto pulsante e só erro e sucesso ganham caixa. O botão de assinar desabilitado é tracejado, não cinza chapado.
- **Planos:** seção `#planos` entre o manifesto e os downloads, com dois blocos de hierarquia diferente: o período de teste como porta de entrada (borda superior, CTA outline) e o Nexus Pro como oferta principal (superfície em painel, preço em destaque tipográfico, CTA branca). `src/plans/` define os estados `consultando`, `disponivel`, `indisponivel` e `erro`; a linha de status usa `aria-live`, verde quando o servidor confirma e rosa quando a contratação está indisponível. Preço, dias e limites nunca aparecem fixados no HTML.
- **Voz:** palco com barra de janela, orbe de três anéis e núcleo, sete barras de nível e a fase em VT323. O visitante vê a fala transcrita, as hesitações riscadas em rosa e o prompt entregue a um pane. O estado final já vem no HTML; a reprodução é opcional, começa por clique e nunca ativa o microfone. Com redução de movimento, o clique mostra o estado final sem animar. Estilos em `src/voice.css`, lógica pura em `src/voice/script.js`.
- **Companheiros:** Shot e Redline usam ilustrações em HTML e SVG de autoria do site, rotuladas como ilustração. O Shot desenha a janela de revisão em HTML (barra de título, vídeo 16:9 com recorte da captura real do NexusIDE, barra de corte com os cabos rosa e o marcador que percorre o trecho, botões com os rótulos do app) e mostra a folha de contato real e a pasta gerada; a legenda diz que são recortes de capturas reais. Antes era um print do app com faixa preta e texto ilegível na escala do site. O painel do Redline mostra dados de exemplo; verde indica folga e rosa indica uso alto ou conta em espera.
- **Reel original:** o filme original, recortado no quadro do site e inteiro em tela cheia, com poster, controles nativos e controle explícito de áudio; a preferência por redução de movimento impede autoplay programático.
- **Mundo e HUD (Nexus Data Café):** diorama low-poly de um data center ao entardecer, visto de cima e de trás do personagem; paredes norte e oeste altas, sul e leste baixas (corte de diorama). O dev anda numa grade de células e a colisão empurra o disco para fora dos sólidos, então ele contorna quinas e nunca entra num objeto. Interação por proximidade com anel rosa no chão e botão de segurar (E, toque ou mouse) com barra de progresso; ações bloqueadas explicam o porquê. 18 racks, um por LLM do Nexus, com letreiro (ícone e nome num atlas), neon na cor da marca, LEDs em InstancedMesh (apagados, verdes correndo, vermelhos piscando em incidente), ventoinhas no topo e losango de alerta. Loop: GPU na doca → instalar no rack → incidentes aleatórios crescem com o tamanho do data center → reiniciar; o café é energia e o dev cansado anda devagar e boceja. Tickets do NOC em ordem de prioridade, XP com curva suave, títulos (Estagiário a Principal) e selos. Som 100% sintetizado em WebAudio, ligado só após gesto, com botão de som sempre visível no HUD, mudo e volume persistentes e uma trilha leve que fica abaixo dos efeitos. O HUD mostra o relógio e os pontos do turno, a missão atual com barra de progresso em verde e, durante uma sequência, o medidor de combo em rosa; a lista de missões e o recorde ficam no painel de tickets. O painel de LED do sorteio (parede norte, já no primeiro quadro: alterna Claude 20x e Codex 20x, gira o ganhador, moldura com luzes correndo e uma ficha 3D girando em cima), o chip fixo do prêmio no HUD e a TV da live abrem painéis com o convite do grupo e o canal; antes de começar a câmera passeia com o painel em quadro e, ao começar, espia o painel por 2,5 s (pulável). Com `prefers-reduced-motion`, LEDs e alertas ficam estáticos, sem balanço de câmera nem bocejo, partículas reduzidas. XP e progresso ficam no navegador e não alteram chances de sorteio. Código em `src/datacafe/` (módulos puros testados: grade, interação, energia, racks, tickets, progresso, áudio); montado na comunidade em tela cheia e na página principal sob demanda.
- **Sorteio (bilhetes):** na comunidade, os prêmios são dois bilhetes com canhoto picotado (linha tracejada e dois furos na borda), não cards iguais. O próximo a sair é maior, tem a luz do entardecer em baixa opacidade, o selo rosa `PRÓXIMO A SAIR` e o letreiro do ganhador em VT323, que gira e fecha em `PODE SER VOCÊ` só enquanto está na tela; o seguinte fica em neutros, com o letreiro em `? ? ? ? ?`. O canhoto diz a meta real do grupo (200 e 500 pessoas). A página nunca mostra contagem de membros nem progresso, porque o site não conhece o número do grupo. Com redução de movimento o letreiro fica parado na frase. O convite verde do grupo aparece já na introdução da seção. Regra pura em `src/sorteio/draw.js`.
- **O prêmio é a estrela (01/10):** o texto do prêmio vem de uma fonte única, `src/sorteio/prizes.js` (Claude 20x aos 200, Codex 20x aos 500, nunca contagem atual), e a home, a comunidade e o jogo leem dela; `src/sorteio/copy.test.js` reprova a página que se afastar. Na comunidade o título da seção abre pelo prêmio ("Uma conta Claude 20x vai para alguém do grupo"), a primeira tela do jogo traz um bilhete picotado `CONTA CLAUDE 20x` com a meta, um letreiro corrido em VT323 (`prize-marquee`, duas cópias do mesmo grupo, pausa no hover) separa o jogo da seção, o bilhete do próximo prêmio se inclina até 7° sob o ponteiro com brilho que segue o dedo (`src/sorteio/tilt.js`, só com mouse), as marcas dos dois prêmios flutuam e os bilhetes saem da impressora uma vez (clip-path de cima para baixo, observado pelo quadro e nunca pelo bilhete recortado). Na home, logo depois do topo, um bilhete horizontal com o prêmio, o convite verde do grupo e o canhoto com o letreiro do ganhador; o link Comunidade da navegação leva um selo `sorteio` com ponto pulsante. Peças compartilhadas em `src/prize.css`, `src/sorteio/marquee.js` e `src/sorteio/reel.js`. Com redução de movimento o letreiro vira frases estáticas, os bilhetes ficam visíveis e nada flutua.
- **Topo vivo da home:** atrás do hero, o piso do data center em perspectiva (grade rosa a 30%, deslocada exatamente um quadrado por ciclo, só `transform`), sete brasas subindo em tempos diferentes, o título entrando em três linhas com 100 ms de intervalo e o filme que acompanha o ponteiro por no máximo 14 px. Tudo desligado com redução de movimento.
- **Ícones de plataforma:** SVGs autorados de monitor e janela nos downloads. Providers e mascotes preservam assets Nexus de origem; mídia e fontes mantêm sua procedência.

Movimento do DOM usa transform/opacity, com o easing registrado no sidecar. Redução de movimento desliga transições/animações do DOM e scroll suave; dirigir o mundo é uma ação explícita do visitante.

**The Explicit Play Rule.** A exploração começa pela ação do visitante; os links da comunidade continuam disponíveis fora do canvas.

## Do's and Don'ts

### Do:
- Do preservar a identidade Nexus e os assets originais.
- Do preferir capturas reais do produto (janela do NexusIDE, janela de revisão do Shot, folha de contato, frame da Pink City) a ilustrações em CSS; a legenda diz a data e o que foi desfocado.
- Do manter foco visível, nomes acessíveis e acesso textual fora do canvas.
- Do identificar a missão demonstrada como ilustrativa.

### Don't:
- Don't publicar captura com dado pessoal legível (e-mail de conta, nome de projeto de cliente): desfocar antes de exportar.
- Don't apresentar XP local como chance de sorteio ou prova de participação no grupo.
- Don't substituir o reel original por uma gravação ou promessa de produto não comprovada.
