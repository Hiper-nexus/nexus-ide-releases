# DESIGN.md — Sistema de design do NexusIDE

Régua oficial da interface. `PRODUCT.md` diz **o quê/para quem**; este arquivo diz
**como a UI se constrói**. Se os dois divergirem, o código + este documento
vencem — e o outro se corrige. Validador: `scripts/design-system-sensor.mjs`.

## 1. Identidade

Sci-fi operacional refinado: centro de comando denso em sinal, calmo em ruído.
Dark-first, acento Pink City reservado ao que está VIVO, tipografia neutra
(Inter) com assinatura pixel (VT323) usada com parcimônia. Nunca gamer-RGB,
nunca SaaS de cards brancos, nunca IDE corporativo de 40 ícones na toolbar.

## 2. Tokens (fonte única: `src/renderer/styles/base.css` `:root`)

### Cor — doutrina aviônica

| Token | Valor (`nexus-pink-city`, default) | Uso |
|---|---|---|
| `--bg` | `#080709` | fundo raiz |
| `--bg-elevated` | `#111013` | panes, cards |
| `--bg-bar` | `#0d0b0f` | barras/chrome |
| `--border` / `--border-strong` | `rgb(255 255 255 / .08)` / `rgb(255 255 255 / .16)` | divisórias |
| `--text` / `--text-dim` / `--text-faint` | `#faf7f9` / `#aaa2a8` / `#928b90` | hierarquia de texto com AA |
| `--accent` | `#ff4f8b` | **só o que está vivo/interativo**: foco, agente ativo, item selecionado |
| `--accent-ink` | `#080709` | tinta escura sobre superfície de acento |
| `--btn-primary` / `--btn-primary-ink` | `#faf7f9` / `#080709` | **CTA primário: branco neutro, não acento** |
| `--accent-glow` | `transparent` | **morto no default** — ver abaixo |
| `--danger` | `#ff6b4a` | falha, destrutivo; distinto do rosa operacional |
| `--design` | `#2f6ae0` | segunda voz: design mode |
| `--ok` / `--live` / `--warn` / `--gold` | `#7ee2a8` / `#3ce08d` / `#e5c07b` / `#ffd166` | sinais |

A base é **near-black neutra**, não azul-negro nem rosa tingido. Cor é sinal,
nunca wallpaper. As bordas são branco translúcido de propósito: um fio de
opacidade compõe corretamente sobre qualquer camada da pilha (bar, elevated,
modal) em vez de exigir um hex por camada.

### Por que Pink City, e por que o CTA é branco (0.28.1)

Até a 0.20 o acento era ciano `#3dd9ff`; entre 0.21 e 0.28.0 o default era
Nexus Dark com índigo `#7c86ff`. Pink City assumiu o default em 0.28.1 para
alinhar o produto ao cockpit operacional observado, sem colorir suas
superfícies: rosa aparece só em foco, seleção e estado vivo. `nexus-dark`
permanece selecionável e com sua paleta anterior intacta.

A regra que sustenta a identidade: **a ação primária é a coisa mais clara da
tela (branco neutro), e o acento fica reservado para ESTADO.** Se o CTA voltar
a derivar de `--accent`, o rosa deixa de comunicar estado e vira decoração.

O ciano permanece apenas em `LEGACY_NEXUS_CYAN_PALETTE` para integrações
legadas. Não é default nem opção do picker atual.

Derivados do acento (`--accent-soft/strong/hover/glow`) são `color-mix` do
`--accent` — **nunca** sobrescreva por tema. Cada tema fornece apenas sua
paleta-base, CTA e perigo; componentes consomem tokens, nunca hex de tema.

### Estado operacional — um estado, uma cor, em toda superfície

`--state-running: accent` (respira no acento) · `--state-ready/done: ok` ·
`--state-blocked: warn` · `--state-failed: danger` · `--state-pending: text-dim`.
Mission Board, inspetor, toolbar de pane, FleetChip e bordas de pane consomem SÓ estes
tokens. Estado nunca viaja só em cor: sempre com glifo/palavra
(`paneSessionView` em `src/shared/pane-session-view.ts`).

### Escalas

- Espaço: `--space-1..8` (4→64px). Tipo: `--text-2xs..hero` (10→34px).
- Raio: `--radius-xs..2xl` (2→18px) + `--radius-round`. Cards ≤ `--radius-xl`.
- Sombra: `--shadow-1..3` em duas camadas (contato curto + difusão larga) e
  `--shadow-inset-hi` (filete de luz interno) aplicado com elas em superfícies
  elevadas — menus, modais, painéis. z-index: ladder nomeada
  (`--z-soft-overlay:45 … --z-confirm:1300`) — nunca valor solto.
- `--bar-height: 44px`, `--toolbar-height: 30px`.

### Camada de overlay — a escada inteira, ancorada no topo

Overlay não mora dentro da árvore do grid. Se morar, herda três coisas do pai
e não pode recusar nenhuma: contexto de empilhamento, `overflow` e
`transform`. O sintoma real desta casa: `UpdateModal` e o painel de
notificações eram montados dentro da `.workspace-bar` — `z-index: 1300` e `80`
lidos dentro de um chrome com `--z-app-chrome: 55`, ou seja, números altos sem
efeito. A ladder existia; o lugar é que estava errado.

Solução estrutural (`src/renderer/overlay/overlay-layer.tsx` +
`styles/overlay-layer.css`): uma raiz de portal irmã de `#root`, direto no
`<body>`, com `--z-overlay-root` e `isolation: isolate`.

**A ladder segue sendo a fonte única de ordem.** `--z-overlay-root` não é um
degrau novo — é o valor que leva a escada inteira ao topo, aplicado num nó só,
que nenhum componente escreve. Como a raiz isola o contexto, dentro dela
`--z-toast` … `--z-confirm` voltam a ordenar entre iguais. É assim que "nunca
valor solto" continua verdadeiro com um número alto no sistema: ele aparece
uma vez, nomeado, na camada — e não em componente nenhum.

**Só o tier duro é portalado** (`--z-hard-modal` … `--z-confirm`: ⌘K,
cheatsheet, confirm, update, popover de notificações). O tier mole —
toast (44), scrims/menus de workspace (45/46) e chrome (55) — fica na árvore
da app **de propósito**, porque a ladder INTERCALA essas camadas com o chrome:
chrome acima dos scrims transitórios (clicar em voz/config não pode acertar um
backdrop e descartar estado), toast abaixo do scrim (nunca cobrir nem capturar
uma confirmação). Um teto único achataria
essas invariantes.

| Token | Valor | Uso |
|---|---|---|
| `--z-overlay-root` | `100000` | raiz de portal `.overlay-layer`; único nó que o usa |
| `--overlay-scrim` | `rgba(4, 6, 10, 0.55)` | fundo do scrim de overlay |
| `--overlay-blur` | `16px` | vidro do scrim (`0px` desliga no sistema todo) |
| `--overlay-saturate` | `160%` | saturação do vidro do scrim |

**Hex fora de `:root` é dívida**: use o token ou o `color-mix` dele. Fallbacks
de `var()` devem ter o valor ATUAL do token (ex.: `var(--bg, #0a0e15)` —
há fallbacks defasados catalogados para follow-up; ao tocar num arquivo,
corrija os dele).

## 3. Tipografia

- **UI**: `Inter` (variável, bundled em `styles/fonts/`) — mesmo render em
  mac/Windows/Linux. Fallback: stack do sistema.
- **Mono de UI**: `JetBrains Mono` (bundled) — badges, atalhos, dados.
- **Assinatura pixel**: `VT323` — eyebrows, kickers, badges, boots, sprites.
  Regras: nunca corpo de texto; piso de 12px; um toque por tela, não cinco.
- Hierarquia por peso (400/500/600/650) e escala, não por famílias extras.
- Copy de produto em **PT-BR**. Labels de botão = verbo + objeto
  ("Nova missão", "Abrir Providers"). Sem jargão interno em superfície leiga:
  "orquestrador + 4 agentes", não "orq + 4 workers".

## 4. Motion

- 150–250ms, easings nomeadas (`--ease-out-quart/quint/expo`); feedback ~120ms.
- Motion comunica ESTADO (vivo, mudou, terminou), nunca decoração.
- `prefers-reduced-motion` obrigatório em todo keyframe.
- **Nunca** animar box-shadow/border em `.pane`: repinta o canvas do xterm e
  lê como flicker. Estado do pane muda cor de borda com transição estática.

### Motion da camada de overlay — dois easings, um papel cada

| Token | Valor | Uso |
|---|---|---|
| `--ease-spring-in` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | **só ENTRADA** de painel de overlay |
| `--ease-overlay-smooth` | `cubic-bezier(0.22, 0.8, 0.2, 1)` | todo o resto: saída, scrim, transição |
| `--dur-overlay-modal` | `180ms` | entrada de modal (dentro da faixa 150–250ms) |
| `--dur-overlay-pulse` | `2.2s` | pulso de estado vivo dentro de overlay |

`--ease-spring-in` tem overshoot (segundo control point `1.56` > 1): é a
**única** curva com bounce do sistema e a exceção deliberada à regra "nunca
bounce/elastic" que rege o resto. Existe por um motivo estreito — a matéria
chegando e assentando na entrada de um overlay — e três limites que não se
negociam:

1. **Só entrada.** Saída, hover, transição de estado e qualquer coisa
   contínua usam `--ease-overlay-smooth`, que não passa de 1.
2. **Só transform.** Aplicado à opacidade o overshoot passaria de 1, o
   navegador clamparia e o trecho interessante da curva viraria platô. Por
   isso os painéis entram com DUAS animações (transform em spring, opacidade
   em smooth), não uma.
3. **Só dentro da camada de overlay.** Nunca em `.pane`, nunca em rail,
   nunca em conteúdo de canvas.

O pulso de 2.2s (`--dur-overlay-pulse`, classe `.overlay-live`) só marca
trabalho em curso na própria superfície — e, como todo keyframe da casa, tem
`prefers-reduced-motion: reduce → animation: none`.

### Vidro do scrim — onde o `backdrop-filter` pode morar

`blur(16px) saturate(160%)` vai no **scrim da camada de overlay**, nunca em
`.pane` nem em ancestral do canvas do xterm — a regra acima vale para filtro
tanto quanto para animação. Na camada, o filtro é composição sobre o quadro já
pintado do app, e o pane não entra na árvore de pintura do overlay.

O custo residual é honesto e não some por estrutura: um `backdrop-filter` de
tela cheia reamostra a cada frame em que o que está por baixo repinta, e um
terminal streamando repinta sempre. Por isso o vidro fica **só nos scrims de
modal curto e focal** (⌘K, cheatsheet, update), onde o operador já não está
lendo o terminal, e **nunca nos dimmers de vida longa** (wizard/settings), que
podem ficar abertos com a frota trabalhando atrás. `--overlay-blur: 0px`
desliga o vidro no sistema inteiro; `prefers-reduced-transparency: reduce`
já o desliga sozinho e compensa em opacidade.

## 5. Componentes-primitivos (reusar, não reinventar)

- `ActionCard` / `EmptyState` (`components/ActionCard.tsx`, `ui-actions.css`) —
  todo empty state ensina + tem ação primária. "Nada aqui" sem CTA é bug.
- `ConfirmDialog` — confirm/alert nativos são proibidos na interface. A única
  exceção é a revisão de autoridade main-owned imediatamente antes de iniciar
  uma missão, que usa confirmação nativa compacta e recibo auditável.
- `PixelIcon` — set proprietário 11×11; ícone novo entra nele, não glifo Unicode
  solto (🎬 ★ ↻ são dívida).
- Chips da bar: altura 26px, `border-radius: 999px`, um idioma só
  (`.workspace-bar__zone--status > *`).
- Botões icon-only sempre com `aria-label` (title sozinho não basta).

## 6. Chrome e hierarquia

- WorkspaceBar: cada controle visível merece o lugar. Ação diária = **Nova
  missão** (única primária sólida). Secundário mora no `⋯` e no ⌘K.
  Gamificação (XP) fora da zona de status. "Novo workspace" é uma ação compacta
  única junto à identidade do workspace; nunca se repete no menu ▾ da marca.
- Frota em linguagem clara: "2 trabalhando · 1 morto" (nunca "zzz"/"x").
- Pane comunica estado pela borda: busy = acento, morto = danger, hibernado =
  tracejado dim; foco = acento + glow contido.
- Densidade: monitoramento denso é OK (terminal, telemetria); **CTAs de
  produto são grandes** (≥32px de alvo; primário ≥40px).

## 7. Cross-platform (mac / Windows / Linux)

- Atalhos: label via `formatShortcut('mod','K')` de
  `src/renderer/lib/platform.ts` (⌘ no mac, Ctrl em win/linux). `⌘` literal em
  JSX/string é dívida — exceto branch mac-only documentado.
- Handlers: sempre `e.metaKey || e.ctrlKey`.
- Janela: `hiddenInset` no mac, frame nativo nos demais (`src/main/window.ts`).
- Fontes bundled (Inter/JetBrains Mono/VT323) — não depender de fonte do OS.
- Scrollbar própria global (idioma único, sem depender do nativo).

## 8. Temas

`ui-theme.ts`: `nexus-pink-city` (default), `nexus-dark`, `nexus-light`,
`dracula`, `solarized-dark`. Tema = 14 vars de paleta, aplicadas **inline no
`<html>` por `applyUiTheme`**; os blocos `[data-theme]` do `base.css` são
fallback estático parcial (pré-JS) — o inline vence. Derivados de acento
seguem via `color-mix`. Troca ao vivo deve substituir todos os tokens sem
herdar fallback/valor inline do tema anterior. A paleta xterm de Pink City é
deliberadamente a mesma paleta escura não tingida de Nexus Dark. Tema claro
ajusta sinais (`--ok` etc.) para segurar AA. Modo pixel
(`data-theme-pixel='on'`) zera raios e promove VT323 a `--font-ui` — opt-in,
ortogonal ao tema.

## 9. Do / Don't rápido

- **Do**: sinal operacional sempre visível; empty state com ação; linguagem
  clara PT-BR; tokens; reduced-motion; aria-label.
- **Don't**: hex fora de token; `!important` sem comentário do porquê; modal
  como primeira resposta (exhaust inline antes); acento como decoração;
  jargão ("orq", "zzz") em superfície leiga; animação em `.pane`.

## 10. Provenance

Fontes OFL: VT323, Inter, JetBrains Mono (licença em
`third_party/licenses/OFL-1.1.txt`, provenance em
`third_party/provenance/fonts-inter-jetbrains.json`). Componentes Orca
(design mode): `third_party/provenance/orca-*.json`.

## 11. Referência estrutural — Overclock desktop

Fonte observada localmente em 2026-08-07: `/Applications/Overclock.app`
(1.3.x), do primeiro boot à missão em execução. Capturas de auditoria são
artefatos locais temporários; não entram no produto nem no repositório.

Reproduzir composição, densidade e fluxo — nunca marca, logo, copy, sprites ou
outros assets do Overclock:

- **Rail compacto e hierárquico.** Largura persistente de `184px` (faixa
  permitida: 160–200px). Workspace/missão é a linha principal; agentes aparecem
  aninhados apenas quando existem. Seleção usa fill sutil + borda de 1px; os
  demais itens não ganham card próprio.
- **Canvas é o protagonista.** Terminal, editor ou entrega ocupam o restante.
  Inspector é secundário: inline apenas quando canvas + inspector cabem;
  empilhado em 1100px. Painéis de contexto são sob demanda.
- **Chrome quieto.** Canvas near-black contínuo, barra e divisórias finas,
  texto técnico mono denso. Sem mosaico de cards, gradiente decorativo ou
  toolbar de ícones redundantes.
- **Pink City é sinal.** Rosa só marca foco, seleção e trabalho vivo. CTA
  primário é branco neutro; pronto = verde, atenção = âmbar, falha = vermelho.
  Estado sempre inclui glifo/palavra, nunca depende apenas da cor.
- **Missão primeiro, linguagem leiga.** A jornada padrão mostra objetivo,
  equipe recomendada, revisão explícita, execução e entrega. Worktree, CLI,
  modelo, budget, receipts e PREVC ficam na camada avançada.
- **Motion de continuidade.** Seleção e painéis usam 150–220ms com
  `--ease-out-quart`; conteúdo preserva posição durante atualizações. Novos
  agentes entram com opacity + translateY de no máximo 4px. Nada pulsa salvo
  estado running e nada anima dimensões de terminal.

Adaptação Nexus: manter Inter, VT323 pontual, contratos de autoridade, copy
PT-BR e terminal real. O objetivo é entrar no Nexus e reconhecer imediatamente
a composição operacional observada sem copiar propriedade visual de terceiros.
