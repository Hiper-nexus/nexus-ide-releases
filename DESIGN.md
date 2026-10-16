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
| `--surface-0` / `--surface-1` / `--surface-2` / `--surface-3` / `--surface-sidebar` | `#080709` / `#121115` / `#16151a` / `#201e25` / `#0b0a0d` | escala tonal de elevação e calma |
| `--border` / `--border-strong` | `rgb(255 255 255 / .08)` / `rgb(255 255 255 / .16)` | divisórias |
| `--text` / `--text-dim` / `--text-faint` | `#faf7f9` / `#aaa2a8` / `#928b90` | hierarquia de texto com AA |
| `--accent` | `#ff4f8b` | **só o que está vivo/interativo**: foco, agente ativo, item selecionado |
| `--accent-ink` | `#080709` | tinta escura sobre superfície de acento |
| `--btn-primary` / `--btn-primary-ink` | `#faf7f9` / `#080709` | **CTA primário: branco neutro, não acento** |
| `--accent-glow` | `transparent` | **morto no default** — ver abaixo |
| `--danger` | `#ff6b4a` | falha, destrutivo; distinto do rosa operacional |
| `--design` | `#2f6ae0` | segunda voz: design mode |
| `--ok` / `--live` / `--warn` / `--gold` | `#7ee2a8` / `#3ce08d` / `#e5c07b` / `#ffd166` | sinais |
| `--status-success` / `--status-danger` / `--status-warning` / `--status-merged` | `#6cb17b` / `#d8847b` / `#c09664` / `#a890d5` | status calmos em badges/textos (croma 55-60%) |
| `--status-dot-success` / `--status-dot-danger` / `--status-dot-warning` | `#35c264` / `#f7796d` / `#db932e` | status dots operacionais 6pt (croma 90%, WCAG 3:1) |
| `--diff-addition` / `--diff-deletion` | `#4ade80` / `#ef4444` | realce de adições e deleções em diff |
| `--series-1` / `--series-2` / `--series-3` / `--series-4` / `--series-5` / `--series-6` | `#3987e5` / `#d95926` / `#199e70` / `#c98500` / `#d55181` / `#9085e9` | séries categóricas de gráfico: identidade de ferramenta (Uso e custos); nunca estado nem texto |

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

Derivados do acento (`--accent-soft/strong/glow`) são `color-mix` do
`--accent` — **nunca** sobrescreva por tema. Cada tema fornece apenas sua
paleta-base, CTA e perigo; componentes consomem tokens, nunca hex de tema.

### Estado operacional — um estado, uma cor, em toda superfície

`--state-running: accent` (respira no acento) · `--state-ready/done: ok` ·
`--state-blocked: warn` · `--state-failed: danger` · `--state-pending: text-dim`.
Mission Board, inspetor, toolbar de pane, FleetChip e bordas de pane consomem SÓ estes
tokens. Estado nunca viaja só em cor: sempre com glifo/palavra
(`paneSessionView` em `src/shared/pane-session-view.ts`).

### Cores de papel — personagem, não sinal

`--role-{orchestrator,scout,architect,reviewer,executor}` são os matizes de
personagem dos avatares Nexling: quem o agente **é**, não o que está
acontecendo (isso continua em `--state-*`). Fora da paleta de tema — o avatar
carrega o próprio fundo escuro em qualquer tema. Superfícies e bordas derivam
via `color-mix` destes tokens; hex de papel em componente é dívida.

### Escalas

- Espaço: `--space-1..8` (4→64px) com meios-degraus `--space-1-5`/`--space-2-5`
  (6/10px — a densidade real do cockpit, agora token, não literal).
  Tipo: `--text-2xs..hero` (10→34px).
- Raio: `--radius-xs..2xl` (2→18px) + `--radius-round`. Cards: `--radius-card` (16px), glass: `--radius-glass` (20px).
- Sombra: `--shadow-1..3` em duas camadas e papel funcional em superfícies elevadas:
  `--shadow-card-rest`, `--shadow-card-focus`, `--shadow-card-drag` (com `--shadow-inset-hi` interno).
- Vidro e blur: `--blur-sm..3xl` (8→64px), `--glass-bg`, `--glass-border`, `--glass-blur` (24px) e `--grid-dot`.
  z-index: ladder nomeada (`--z-soft-overlay:45 … --z-confirm:1300`) — nunca valor solto.
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

- **UI**: `Inter` (variável, WOFF2 do TTF inteiro em `styles/fonts/`) — mesmo
  render em mac/Windows/Linux. Fallback: stack do sistema. Preload no primeiro paint.
- **Mono de UI**: `JetBrains Mono` (WOFF2 sem subset, sem preload) — badges,
  atalhos, dados e a primeira fonte do terminal. O cmap conserva o
  box-drawing: a TUI desenha essas molduras.
- **Assinatura pixel**: `VT323` — eyebrows, kickers, badges, boots, sprites.
  Está no rótulo do boot, então o WOFF2 entra no preload junto com a Inter.
  Regras: nunca corpo de texto; piso de 12px; um toque por tela, não cinco.
- Hierarquia por peso (400/500/600/650) e escala, não por famílias extras.
- Copy de produto em **PT-BR**. Labels de botão = verbo + objeto
  ("Nova missão", "Abrir Providers"). Sem jargão interno em superfície leiga:
  "orquestrador + 4 agentes", não "orq + 4 workers".

## 4. Motion

- 150–250ms, easings nomeadas (`--ease-out-quart/quint/expo`); feedback ~120ms.
- Motion comunica ESTADO (vivo, mudou, terminou), nunca decoração.
- `prefers-reduced-motion` obrigatório em todo keyframe.
- Lata de energia no pane: sequência finita de entrada, estalo, espuma e
  saída; ganho de XP usa o snapshot real. `PaneEnergyCan` controla panes com
  sessão e vagas vazias: modo sóbrio ou ocultação encerram a cena, sem replay
  ao voltar. O SVG usa a área útil para a lata ser reconhecível e nunca
  intercepta cliques. Movimento reduzido conserva a leitura estática.
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
- **Card da casa** (receita, não componente): fundo `--bg-elevated`, borda
  `--border`, `--radius-xl`, `--shadow-1` + `--shadow-inset-hi`. Sem
  `backdrop-filter` (vidro é exclusivo do scrim da camada de overlay, §4),
  sem gradiente próprio, sem hex local. Seleção/destaque via `color-mix` do
  `--accent` — o toque de acento da superfície, quando ela merece um.
- Chips da bar: altura 26px, `border-radius: 999px`, um idioma só
  (`.workspace-bar__zone--status > *`).
- Botões icon-only sempre com `aria-label` (title sozinho não basta).

## 6. Chrome e hierarquia

- WorkspaceBar: cada controle visível merece o lugar. Ação diária = **Nova
  missão** (única primária sólida). Secundário mora no `⋯` e no ⌘K.
  Gamificação (XP) fora da zona de status. "Novo workspace" é uma ação compacta
  única junto à identidade do workspace; nunca se repete no menu ▾ da marca.
- **Perfil de Operador** (gamificação): entrada permanente no rodapé da rail,
  numa faixa própria acima de Configurações (`OperatorHud variant="rail"`;
  continua à vista no modo foco), e cartão em Minha conta (`variant="card"`);
  nunca na WorkspaceBar. O diálogo segue a receita do card da casa: título de
  seção em frase (13px), acento só no poder e nos progressos, ouro só no
  dinheiro economizado, sem grade, varredura nem faixa decorativa. O cabeçalho
  diz de qual projeto vem o XP (é por pasta). Guard: `operator-profile-style.test.ts`.
- **Abas dos Terminais** (`WorkspaceTabs`): uma aba por feature — os panes
  dela e a missão que um deles começou. Linguagem de editor, não de
  dashboard: a ativa é o mesmo chão da grelha (`--bg`, sem fio embaixo) com
  fio de 2px de acento em cima; as demais são texto `--text-dim` sobre
  `--bg-bar`. Sem cartão, sem sombra. Estado da missão vai no glifo
  (`--state-*`) e na palavra (tooltip + nome acessível), nunca só em cor.
  Visão geral (ícone `grid`) fica antes das abas; "ver ao lado" divide a tela
  em duas grelhas com o nome de cada metade. O "+" é o mesmo picker do
  "+ Pane", ancorado na barra e abrindo para baixo.
- Frota em linguagem clara: "2 trabalhando · 1 morto" (nunca "zzz"/"x").
- **Quem trabalha agora** (rail, abas dos Terminais e cabeçalho da missão): a
  frase "N trabalhando agora" fica sempre à vista, nunca atrás de um recolher.
  O agente `busy` leva o nome em texto pleno e o glifo `status-busy` respirando
  em acento (`--state-running`), sem fundo e sem faixa na borda (§16); a
  palavra "Trabalhando" mora no resumo do bloco e no nome acessível; dois ou
  mais ao mesmo tempo ganham a marca "em paralelo" (texto de acento, não selo).
  Aguardando, dormindo, encerrado e sem sessão ficam em tom secundário
  (`--text-dim`/`--text-faint`, logo esmaecido), sempre com a palavra do estado
  na linha. A ordem das linhas é a do layout e não muda com o estado (linha
  que pula a cada busy↔idle é clique no alvo errado); o pulso é só opacity
  (`state-breathe`), mora nas folhas (chip dos Terminais, glifo da missão e do
  agente) e para em `prefers-reduced-motion`. A regra de "trabalhando" é uma só
  (`src/renderer/lib/agent-roster.ts`, sobre `displayStates`): rail, abas e
  cabeçalho nunca contam diferente. Título OSC que é pasta de worktree, caminho
  ou id nunca aparece como tarefa.
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
- Controles nativos (no Windows o canvas do SO é claro): `color-scheme` da raiz
  acompanha o fundo real do tema (`light` só sob `nexus-light`, inclusive tema
  importado ou criado no editor); `select option/optgroup` e o estado autofill
  têm fundo e tinta por token em `base.css`; todo select fechado tem regra de
  token (`.settings-input`, `.wizard__mini-select`, `.confirm__orch-template-select`
  …): classe sem regra cai no controle do SO (F-380).

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

Temas do VS Code importados (`styles/vscode-theme-import.ts`, persistidos em
`ui.importedThemes`) viram as mesmas 14 vars + paleta xterm, só hex opaco:
alpha composto sobre a superfície, texto/acento/perigo ≥4,5:1 sobre `--bg`,
`--bg-elevated` e `--bg-bar` (luminosidade OKLCH ajustada, matiz mantido),
CTA neutro de Nexus Dark/Light — nunca `button.background` nem o acento. A
rampa `--surface-*` sai do próprio fundo (`generateSurfaceRamp`) e
`data-theme` aponta para `nexus-pink-city`/`nexus-light` conforme o fundo.

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

- **Rail compacto e hierárquico.** Largura persistente de `250px` (faixa
  permitida: 200–280px). Agentes aparecem aninhados apenas quando existem. Desde
  15/10 workspace e missão deixaram o padrão card Orca e são linhas de uma
  lista plana, uma por item, sem card próprio (§16); a seleção é só fundo.
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

## 12. Configurações para quem não conhece o motor

- Cada menu começa com um título reconhecível e uma frase sobre sua finalidade.
- Ações e escolhas comuns ficam visíveis. Catálogos de modelos, JSON, caminhos,
  variáveis de ambiente, métricas internas e edição avançada ficam em detalhes
  recolhíveis; listas longas têm busca ou filtro.
- Use nomes em português na navegação e preserve os termos antigos como aliases
  de busca. Nomes próprios de modelos, serviços e arquivos não são traduzidos.
- Identifique ferramentas e modelos de IA com `ProviderLogo`. Prefira logos
  oficiais locais, com procedência registrada, sem buscar imagens em rede ao
  renderizar a tela. Estado deve continuar escrito ao lado da identidade.
- Distingua instalado, conectado, autorizado e disponível. Importar uma
  referência cria uma proposta; só a versão aplicada é contrato do projeto.
- A regra de leitura do contrato visual é permanente no motor. O botão Design
  profissional adiciona orientação de acabamento, mas não desativa essa regra.

### Organização das configurações

A navegação principal agrupa as funções em sete áreas por finalidade. Cada
área apresenta apenas suas seções; busca global encontra os destinos individuais.
Não voltar à lista de dezenas de destinos na barra lateral. A biblioteca Meus
pets tem acesso permanente e não depende de o mascote flutuante estar ligado.
Catálogo de modelos de mídia e conexão dos serviços são funções distintas,
com um caminho direto entre elas.

Sem destino explícito, Configurações abre em **Configuração rápida**: conectar
uma IA é a ação principal; aparência, texto, microfone, uso, equipe e diagnóstico
são ações por intenção. Cada uma navega à implementação existente. Links para
seções específicas não passam pelo guia. Busca combina palavras comuns entre
campos e aliases; não exige que o cliente conheça o nome técnico da tela.

Na navegação do app, **Missões** abre **Missões e tarefas** (o Quadro). Pendências
ficam na faixa fixa antes do histórico, nunca nas utilidades roláveis. Missões
dormindo ou bloqueadas tecnicamente mostram **Abrir para retomar**: é navegação
para a recuperação autorizada, não uma ordem de religar sessões.

Contas de IA fala em ferramentas e contas; “instalada”, “ativada” e “conectada”
são estados distintos. Operações em lote começam recolhidas. O menu Ações do
painel explica as operações em texto visível, com altura natural e rolagem na
janela baixa; nunca achatar os itens para caber. Preparação identifica o agente
sem usar “Subindo” como única explicação.


## 13. Criação direta e navegação por resultado

- **Início é o formulário real de criação.** Um título, uma frase, o pedido e
  `Iniciar criação`. Sem tutorial intermediário, stepper ou aprovação de equipe
  no caminho padrão. O fluxo manual é uma opção dentro da personalização.
- **Pedido protagonista.** Campo confortável para descrever a ideia; projeto
  pelo nome humano, caminho disponível para inspeção. Equipe resumida e
  detalhes/referências recolhidos. Expandir opções não muda nem apaga o pedido.
- **Uma entrada persistente.** `Novo pedido` aparece uma vez na rail. Início,
  abertura de projeto e demais destinos precedem o histórico rolável. Limpeza
  permanece recolhida junto às utilidades do projeto.
- **Hierarquia legível.** Títulos dos trabalhos em 13px, numa linha só; o
  estado vai no glifo e, quando o trabalho pede algo da pessoa, em 12px numa
  linha própria (§16). Não repetir o nome do projeto nem a branch em cada
  trabalho. O cabeçalho identifica projeto/destino e agrupa utilidades à direita.
- **Espaço disponível governa layout.** A equipe responde à largura do canvas,
  não apenas à janela. Nomes e seletores não podem se sobrepor ao reduzir a
  janela ou abrir painéis. Alvos secundários de pelo menos 32px no desktop.
- **Autonomia deve corresponder ao mecanismo.** A interface remove decisões
  técnicas obrigatórias; estados de execução, revisão e entrega continuam
  baseados no motor. Um redesign não certifica sozinho a qualidade do código.

### Início: ação ancorada, atalho e anexos à vista (pedido do operador, 16/10)

Código: `ExpressMissionStart.tsx`, `MissionAttachmentPicker.tsx` e
`mission-setup.css`; o guard é `ExpressMissionStart.test.tsx`.

- **A ação nunca sai da tela.** `Iniciar criação` mora no dock (§15), irmão da
  área rolável, e não no fim da página: o apoio (terminais, primeiros passos)
  rola por cima dele. O dock leva a pasta e a equipe ("confeitaria-da-ana · 4
  agentes · Claude · Codex") e a dica do atalho. Pré-requisito sem IA conectada,
  resposta direta e erro moram juntos, acima do botão que respondem. Sem pasta o
  botão diz "Escolher pasta para iniciar", porque só abre o seletor.
- **⌘/Ctrl+Enter inicia de qualquer ponto do formulário; Enter nunca inicia.** O
  editor lê Mod-Enter como quebra de linha, então o `<form>` captura a tecla
  antes dele (`onKeyDownCapture`, nunca durante o IME). Enter e Shift+Enter
  seguem quebrando linha, e Enter no critério de pronto não envia o formulário.
  O rótulo vem de `formatShortcut('mod', 'enter')`.
- **Validação junto do campo.** Pedido vazio explica logo abaixo do campo
  (`role="alert"`, `aria-invalid`, `aria-describedby`), leva o foco para ele e
  some quando a pessoa escreve. O rótulo "Seu pedido" foca o editor (um
  contenteditable não é rotulável). A dica de como escrever é visível, não só
  para leitor de tela.
- **Exemplos ensinam sem apagar.** Quatro pedidos (criar, corrigir, entender o
  projeto, publicar) sob a legenda "Comece por um exemplo:". Clicar troca o
  texto (contrato F-1170), mas, se havia texto digitado, "Desfazer" o devolve.
  "Entender o projeto" cai na lane de leitura (`consult`): conferido por teste.
- **Anexos à vista.** O `MissionAttachmentPicker` compacto fica logo abaixo do
  pedido, fora de qualquer recolher, e diz o que aceita ("Imagem, áudio, PDF ou
  texto."). É a superfície de miniaturas e anexos pendentes: não duplique outra
  faixa de anexos perto do campo.
- **Um botão branco só.** Os atalhos do checklist de primeiros passos descem para
  neutro elevado nesta tela (a ação primária é a coisa mais clara, §2). Títulos,
  alvos (32px) e texto do apoio seguem a escala do restante da tela.
- **Foco inicial segue no título.** Mover para o editor quebraria os atalhos 1 a 6
  do Início (valem com o foco fora de campos); decisão do operador pendente.

## 14. Sala de racks da missão (grafo do Quadro)

Pedido do operador (02/10): cada CLI/LLM é um rack e as relações são cabos
com energia passando. Código: `components/mission/MissionGraph.tsx`,
`MissionAgentCard.tsx`, `mission-graph-cabling.ts` e `mission-board.css`.

- **Rack.** Chassi em `--surface-2` com trilhos `--surface-1` e parafusos, a
  ferramenta (`ProviderLogo` + `cli · modelo` em mono), o LED **e** a palavra
  do estado (nunca só cor), a régua de atividade e o visor da unidade atual
  em `--surface-0`. Sem unidade, o visor fica apagado com texto mudo. O
  coordenador é o núcleo, mais largo, com o painel de portas embaixo.
- **Cabo.** Capa `--surface-3` grossa, núcleo de 1,5px com o traço do tipo
  de relação (a legenda) e conector nas duas portas. Cada cabo tem porta
  própria, ordenada pela outra ponta para não cruzar na saída.
- **Energia é estado, não enfeite.** Pulso e pacotes só no cabo vivo:
  missão rodando e a ponta de trabalho (quem recebe a delegação; quem
  entrega ou revisa) trabalhando. Parado, o cabo fica quieto e tinge pelo
  estado dessa ponta. Os pacotes são glifos de forma (`λ`, `fn`, `{ }`,
  `0x`…), nunca texto da missão, e ficam fora da árvore de acessibilidade.
- **Motion.** A varredura dos LEDs e o pulso valem só para `working`.
  `prefers-reduced-motion` tira o movimento e os pacotes. O cabo vivo segue
  marcado pela cor e pelo conector aceso. Pink City só para vivo e
  selecionado.

## 15. Passos da missão com lista longa (Equipe e Revisão)

Pedido do operador (14/10): a barra "Voltar / Continuar" boiava no meio da
lista de papéis, cortando um cartão ao meio. Código: `TeamStep.tsx`,
`MissionSetupRosterRow.tsx` e `mission-setup.css`.

- **A barra de ações nunca cobre conteúdo.** Passo com lista que pode passar da
  janela usa `.mission-setup__step--docked` (Revisão: `--review`): quem rola é
  `.mission-setup__step-scroll`, e `.mission-setup__step-dock` é irmão dela,
  opaco (`--bg`) e separado por fio de 1px. `position: sticky; bottom: 0` dentro
  do scroller do passo é proibido: ele respeita o `padding-bottom` do scroller e
  deixa a barra boiando sobre a lista. Passo curto (Missão) segue com o rodapé
  sticky de `.mission-setup__step > .mission-setup__step-actions`.
- **Motivo do bloqueio mora no dock**, abaixo do botão que ele descreve
  (`aria-describedby`), e não no fim da lista.
- **Cartão de papel (variante cheia).** Hierarquia: nome e papel, depois o
  estado, depois a configuração. O cabeçalho é uma grade (avatar, nome e papel,
  estado, remover) igual em todo cartão; a coluna de remover é reservada mesmo
  quando o papel não pode sair, então o estado não muda de lugar. Ferramenta,
  Modelo e Esforço ficam numa grade de três trilhos (uma coluna abaixo de 600px
  de canvas). Rótulo de campo em caixa normal, sem eyebrow em caixa alta.
- **Remover é botão só de ícone** (`PixelIcon trash`) com `aria-label` e `title`
  "Remover <papel>", alvo de 32px (maior no toque). Ordem de foco do cartão:
  controles, remover, detalhes. Depois de remover, o foco vai para o resumo dos
  detalhes do vizinho, nunca para o Remover dele. A variante `--compact`
  (Expresso) não muda.
- **Lista e dock partilham a calha de rolagem** (`scrollbar-gutter: stable` nos
  dois): a barra clássica come largura da lista, e sem a mesma reserva no dock o
  botão primário passava ~11px da borda dos cartões.
- **Canvas estreito (até 600px):** o estado desce para a linha do papel, à
  direita, e o nome do papel quebra em vez de virar reticências; os selects
  seguem o token de alvo (maior no toque).
- **Problema no papel:** selo "Precisa de ajuste" e o motivo, em `--danger`, no
  cartão, ligado ao select de Ferramenta por `aria-describedby`. A contagem de
  integrantes é `role="status"`, então adicionar, remover e presets são
  anunciados. O painel de Configurações técnicas é neutro: acento é estado, não
  tinta de painel.

## 16. Rail em lista plana, um grupo por projeto

Pedido do operador (15/10): o rail estava pesado (cartão do projeto, da missão e
do agente, mais chips e bordas) e, com mais de um projeto vivo, virava uma pilha
de cartões. A referência de organização é a lista densa e plana de um app de
chat: ações no topo, grupos por projeto, uma linha por item. Código:
`WorkspaceRail.tsx`, `RailAgentRoster.tsx` e `app-shell.css`; o guard é
`workspace-rail-style.test.ts` (sem hex, sem caixa-alta, sem faixa lateral, só o
pulso de "ao vivo" repete).

- **Topo em linhas.** Marca e "Reportar bug" sem caixa, busca, "Novo pedido"
  como a primeira linha da lista (o mais num círculo, peso 600; segue com ≥40px)
  e os destinos numa coluna só (Início, Projeto, Terminais, Quadro, Memória).
  Sem grade de duas colunas e sem fio entre as faixas; só o rodapé tem fio em
  cima. O contador de panes dos Terminais é número solto; selo âmbar fica para
  o que pede a pessoa.
- **Em andamento é todo projeto com trabalho vivo, ao mesmo tempo.** O aberto
  agora e cada vizinho com missão ativa (`projectRailWorkspaces`) têm
  cabeçalho próprio, com as missões embaixo. O nome é texto de 12px/600 em
  `--text-dim`; o aberto vai em `--text` com a palavra "atual" no degrau mais
  baixo, sem selo nem faixa. Projetos se separam por respiro, nunca por moldura.
  O caminho só ocupa a linha quando dois projetos têm o mesmo nome; nos demais
  vai no tooltip e no nome acessível. A contagem de agentes só existe para o
  projeto aberto (o renderer não tem os panes dos vizinhos).
- **Recentes é o histórico e nasce recolhido.** Abre sozinho só quando o grupo de
  cima está vazio, isto é, não há projeto aberto (senão o rail ficaria sem
  projeto para abrir). O projeto aberto conta como "acima" mesmo ocioso, sem
  missão nem pane (o grupo então se chama "Projeto atual", não "Em andamento"):
  com ele na tela, Recentes nasce recolhido. A escolha da pessoa fica salva
  (`loadRecentWorkspacesOpen`) e a seleção nunca some atrás do recolher.
- **Missão é uma linha.** Glifo de estado (PixelIcon: a forma muda com o estado,
  não só a cor), título em 13px com reticências e idade. A palavra do estado
  ganha uma linha própria só quando a missão pede algo da pessoa (pronta para
  iniciar, aguardando instrução, bloqueada, falha, entrega para revisar); nas
  demais ela vive no nome acessível e no tooltip. Selecionada é fundo de acento
  a 6%, sem borda (o hover guarda a mesma tinta). Remover aparece no hover/foco,
  em alvo de 32px.
- **Agentes aninhados** recuam para o texto do título da missão: glifo de estado,
  logo, nome e a palavra do estado (omitida em quem trabalha, que o resumo "N
  trabalhando agora" já diz). A tarefa ocupa uma linha, duas em quem trabalha; a
  CLI só aparece quando não há tarefa ou o logo é só a letra de reserva. Sem
  fundo, sem faixa, sem borda.
- **Movimento.** O pulso (opacity, `state-breathe`) mora nas folhas: chip dos
  Terminais, glifo da missão e glifo do agente. O ponto do cabeçalho do projeto
  e do resumo do bloco é marcador parado.
- **Rodapé enxuto.** "Limpar projeto" é uma linha de texto sempre à vista (F-528;
  o vermelho só acende no hover e a confirmação não mudou), seguida de "Precisa
  de você", memória sob pressão, cotas e Perfil de Operador sem cartão.
  Configurações, atalhos e o estado local dividem uma faixa de 32px. Título de
  seção nunca em caixa-alta.
- **Alvo.** Os controles da lista `TARGETS` de `workspace-rail-style.test.ts`
  declaram alvo de pelo menos 32px, e as linhas e os disclosures sobem para 44px
  em `pointer: coarse`: busca, "Novo pedido", linhas de destino, projeto e
  missão, o botão de recolher Recentes e o resumo de agentes (que mediam 24px),
  "Mostrar mais", recolher o projeto, remover e os atalhos em ícone. **Três
  controles NÃO chegam a 32px e ficam fora do guard:** o cabeçalho do card de
  Cotas (~14px; recolhido, o corpo das barras também alterna com o mouse,
  expandido só o cabeçalho recolhe), "Abrir uso e cotas" (~22px, só com o card
  expandido) e "Reportar bug" (~22px, na faixa da marca, que não incha). Subir
  qualquer um muda o layout do rodapé ou da faixa: é dívida conhecida, não regra
  cumprida.
- **Contraste do texto.** O texto de hierarquia (`--text`, `--text-dim`,
  `--text-faint`) segura 4,5:1 sobre `--bg-bar`, onde o rail pousa, nos sete
  temas: o `--text-faint` do `nexus-light` media 4,36:1 ali e subiu para 4,63.
  Sobre a linha selecionada a tinta de acento é 6% (a 12% eram 7 pares abaixo de
  4,5:1, ex.: `solarized-dark` `--text` 4,27; o teto medido é 7,3% no
  `nexus-light` e 9,1% no `solarized-dark`) e o hover guarda a mesma tinta. Dentro
  da linha selecionada o `--text-faint` vale `--text-dim` (idade, "atual",
  caminho, atividade, contador): o faint do `nexus-light` não passa sobre a
  tinta (4,27). O guard mede os três degraus sobre essa linha, em repouso e no
  hover, nos sete temas, sem lista de exceção.

## 17. Uso e custos (painel no registro do "Usage" do T3)

Pedido do operador (15/10): ver o custo por ferramenta como no painel Usage do
T3 e o gasto mensal real com planos. Pedido de 16/10: filtrar por dia, intervalo,
ferramenta e modelo, e destacar quantos tokens estamos usando no decorrer do
tempo. Código: `components/usage/UsageOverview.tsx`, `UsageDailyChart.tsx`,
`MonthlySpendCard.tsx`, `lib/usage-overview.ts`, `shared/usage-analytics.ts` (a
conta) e `styles/usage-overview.css`.

- **Composição.** No topo de Uso e cotas: o cabeçalho com a medida (Custo |
  Tokens) e o período (7/30/90 dias | Personalizado); uma faixa de filtros (Dia,
  Ferramenta, Modelo; De/Até no Personalizado; "Limpar filtros" só quando há
  filtro); à esquerda o total em destaque e a lista de ferramentas (ponto de cor,
  `ProviderLogo`, nome, sessões, valor e "% · o outro número"), que é a legenda
  do gráfico; à direita o gráfico diário. Embaixo, Totais (cinco números) e
  Detalhamento (Modelo | Dia). Abaixo, o cartão Gasto mensal real.
- **Uma conta só, filtros que fecham.** Tudo sai de `summarizeUsage` sobre as
  linhas do rollup (dia local × ferramenta × modelo) e as sessões que o main lê do
  SQLite do projeto: 7/30/90 dias, intervalo, dia, ferramenta e modelo recalculam
  total, lista, gráfico, Totais e Detalhamento pelas mesmas linhas, então a soma
  das partes fecha com o todo (guard: `usage-analytics.test.ts`,
  `UsageOverview.test.tsx`). Sessão não soma entre dias: uma que atravessa a
  meia-noite conta uma vez no intervalo e uma vez em cada dia. Modelo só vale
  junto com a ferramenta dele (o nome sozinho pode repetir). Filtro ou dia que
  ficou sem dado no período novo sai do estado (não volta sozinho depois). Evento
  sem consumo (mensagem sintética) não vira ferramenta nem modelo.
- **Campos de data.** O campo nativo dispara `input` a cada dígito (o 1º dígito do
  ano vira `0002-…`): o valor cru fica no campo e só uma data completa e dentro de
  [min, max] sobe para o painel; De e Até se limitam entre si por `min`/`max` (nunca
  empurram a outra ponta no meio da digitação) e, ao sair, o que não valeu volta ao
  valor que vale. A faixa de filtros tem a mesma estrutura com e sem consumo, para
  editar o intervalo não desmontar o campo nem perder o foco; botão que some leva o
  foco para o campo mais perto (Dia ou gráfico), nunca para o body.
- **Medida vale para o painel inteiro.** Em Custo, o destaque é o dólar e os
  tokens ficam escritos ao lado (resumo, lista, pico e média do gráfico); em
  Tokens, o destaque é a contagem e o custo vai ao lado. Lista e tabela ordenam
  pela medida e "% do custo" vira "% dos tokens". Unidade sempre escrita junto do
  número (`2.17B tokens`, nunca `2180M`), dólar com milhar (`$1,018.73`), em todas
  as seções da página.
- **Período e dia.** O período dá o eixo do gráfico e a janela dos números. O dia
  fixado (clique no gráfico, na tabela por dia, no campo Dia, ou Enter no gráfico)
  estreita os números para ele; o gráfico segue mostrando o período, com o dia
  realçado em acento (é o item selecionado) e o botão "Ver o período inteiro".
  Esc fecha a leitura e depois solta o dia. Dia sem consumo explica e oferece
  "Limpar filtros"; nunca mostra zero. A tela relê o rollup quando o dia vira com
  ela aberta; o rollup do main também é relido ao fim do minuto quando chegou
  evento depois do último cálculo ("atualiza com o uso, no máximo uma vez por
  minuto"). O mesmo conteúdo reenviado a cada ~1 s mantém o mesmo objeto no
  store: a tela não recalcula nem redesenha à toa.
- **Gráfico.** Uma curva por ferramenta, sobrepostas; com mais de uma, um fio
  neutro soma o dia. Acima: total, pico e média por dia COM uso do período (dia
  sem registro não rebaixa a média), cada um com a outra medida escrita embaixo.
  Sobre o desenho: ponto em cada dia com uso (o dado é diário), anel no pico, linha
  pontilhada da média e a leitura do dia em texto. Sem hex: a cor da série chega
  como `--usage-series`; o rótulo da média leva contorno na cor do cartão.
- **Cor de série é identidade.** `--series-1..6` seguem a ferramenta, nunca a
  posição no ranking (Claude é sempre o mesmo matiz); acima de seis, "Outros"
  em `--text-faint`. A cor chega ao CSS como `--usage-series`; texto e
  números ficam nos tokens de texto. No tema claro três séries ficam abaixo de
  3:1 sobre branco: o rótulo escrito e a tabela compensam.
- **Honestidade do número.** O custo é equivalente de API pública, não fatura,
  e o texto diz isso. Só Claude Code, Codex e MiMo Code registram tokens; a
  cópia diz que as outras ferramentas não entram na conta. Sem leitura, o painel
  explica e oferece ação; nunca mostra zero. Economia em `--gold` só quando é
  dinheiro poupado; quando os planos custam mais que a API, o cartão diz "Acima
  da API" em tom neutro.
- **Acessibilidade.** Grupos com nome (Medida, Período, Filtros do painel,
  Intervalo de datas, Detalhar por), campos com rótulo visível, `aria-pressed` nos
  alternadores, total em região `aria-live`, gráfico focável com resumo em texto
  (setas, Home/End, Enter, Esc) e tabela com legenda. A tabela rola dentro do
  cartão em canvas estreito; o cartão nunca rola de lado.
- **Edição inline.** Cada plano tem atalhos (`$20`, `$100`, `$200`, `$500`) e
  campo em USD na própria linha; Enter ou sair do campo grava, Esc desfaz, e
  valor inválido explica no lugar. Todo número usa `tabular-nums`; alvos de
  32px (44px em `pointer: coarse`).
