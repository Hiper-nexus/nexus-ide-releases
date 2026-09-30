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
- **Concluído (`green`)**: etapas entregues, checks e exemplos de diff positivo.

### Neutral
- **Fundo (`bg`), superfície (`surface`), barra (`bar`), elevação (`lift`)**: separar página, conteúdo, chrome e seleção.
- **Texto (`ink`), apoio (`muted`), metadados (`faint`)**: hierarquia de leitura.
- **Divisória (`line`) e borda forte (`strong`)**: limites leves e contêineres estruturais.

`gold` existe como token de origem, mas não é usado nas duas folhas de superfície; não estabelece uma nova família de componentes.

**The Action and State Rule.** A CTA principal usa branco; rosa comunica interação e estado.

## Typography

Geist Variable sustenta a leitura e a hierarquia editorial; ui-monospace identifica metadados e terminais. VT323 é funcional nos sinais do mundo e da progressão, com uso pontual também na ilustração de voz e no convite à comunidade.

O display do produto usa a definição acima, reduzindo a 60px no breakpoint intermediário e 36px no mobile pela regra específica de `body.product-page`. Headline de seção reduz a 36px; títulos secundários usam 24–36px. A comunidade usa título de 60px, reduzido a 48px; o sinal pixel principal usa 80px, reduzido a 64px. O corpo de apoio varia entre 12–18px, e metadados compactos do cockpit/HUD entre 7–12px. FAQ limita o texto a 70ch.

## Layout

Produto em `nexuside.app`; comunidade em `comunidade.nexuside.app`. A separação de host é requisito explícito. O brief de superfície está em `docs/site-redesign-brief.md`: principal Persuade, comunidade Experience.

Produto: hero editorial com o reel portrait original do usuário inteiro, seguido de cockpit ilustrativo e seções por mecanismo. O hero desktop divide colunas (1.25fr/1fr), limita a página a 1600px e o reel a 360px. Seções usam até 1440px; mobile empilha as colunas, usa margens de 24px e reel de até 320px, preservando aspect 9/16.

Comunidade: mapa dirigível como primeira tela, canvas ocupando o palco, apresentação que sai ao iniciar, HUD, estações, missões e XP. O palco usa 100svh com piso de 640px no desktop e 840px no mobile; em telas baixas pode ultrapassar o viewport. A navegação textual e os links do grupo permanecem fora do canvas. HUD mobile aparece ao iniciar, com botões de toque de 48px. Breakpoints reais: 1150px no produto, 1000px na comunidade e 760px em ambos. Ritmo de espaço segue a escala normativa acima.

## Elevation & Depth

Profundidade vem de fundos tonais, bordas e sombras difusas localizadas: reel (`0 24px 72px rgb(0 0 0/.4)`) e cockpit (`0 24px 70px rgb(0 0 0/.3)`). O HUD usa near-black translúcido sobre o mundo, enquanto o conteúdo fora do jogo usa superfície opaca.

## Shapes

Controles e panes têm curvas suaves (8px); cockpit, reel, painéis de estação e contêineres de ilustração usam 12px. Marcadores e pequenas teclas usam 4px. Órbitas da ilustração de voz e sinais pontuais são circulares. Bordas mantêm a separação sem deslocamento duro de sombra.

## Components

- **Botões:** branca, outline escura e rosa compartilham padding de 12px/24px, altura mínima de 48px e peso 600. Hover desloca −3px, active escala .98; outline clareia a superfície. Foco recebe contorno rosa de 2px com offset de 5px. Navegação e demo têm variantes menores.
- **Navegação:** wordmark à esquerda, links de 14px e CTA à direita; links clareiam no hover. Mobile oculta links intermediários e preserva CTA e marca.
- **Missão ilustrativa:** seleção de caso, etapas, panes e revisão; caso ativo usa fundo elevado e números rosa. O rótulo de demo permanece visível. Não executa agentes nem ativa microfone.
- **Reel original:** vídeo inteiro com poster, controles nativos e controle explícito de áudio; a preferência por redução de movimento impede autoplay programático.
- **Mundo e HUD:** rover com aceleração, fricção e colisão; câmera acompanha. Controles de pausa/reposição, fallback WebGL, teclado e toque. Enter em controles filhos preserva a ativação nativa. XP e progresso são locais e não alteram chances de sorteio nem comprovam entrada no grupo.
- **Ícones de plataforma:** SVGs autorados de monitor e janela nos downloads. Providers e mascotes preservam assets Nexus de origem; mídia e fontes mantêm sua procedência.

Movimento do DOM usa transform/opacity, com o easing registrado no sidecar. Redução de movimento desliga transições/animações do DOM e scroll suave; dirigir o mundo é uma ação explícita do visitante.

**The Explicit Play Rule.** A exploração começa pela ação do visitante; os links da comunidade continuam disponíveis fora do canvas.

## Do's and Don'ts

### Do:
- Do preservar a identidade Nexus e os assets originais.
- Do manter foco visível, nomes acessíveis e acesso textual fora do canvas.
- Do identificar a missão demonstrada como ilustrativa.

### Don't:
- Don't apresentar XP local como chance de sorteio ou prova de participação no grupo.
- Don't substituir o reel original por uma gravação ou promessa de produto não comprovada.
