# DESIGN.md — Sistema de design do NexusIDE

Régua oficial da interface. `PRODUCT.md` diz **o quê/para quem**; este arquivo diz
**como a UI se constrói**. Se os dois divergirem, o código + este documento
vencem — e o outro se corrige. Validador: `scripts/design-system-sensor.mjs`.

## 1. Identidade

Sci-fi operacional refinado: centro de comando denso em sinal, calmo em ruído.
Dark-first, um acento ciano para o que está VIVO, tipografia neutra (Inter) com
assinatura pixel (VT323) usada com parcimônia. Nunca gamer-RGB, nunca SaaS de
cards brancos, nunca IDE corporativo de 40 ícones na toolbar.

## 2. Tokens (fonte única: `src/renderer/styles/base.css` `:root`)

### Cor — doutrina aviônica

| Token | Valor (nexus-dark) | Uso |
|---|---|---|
| `--bg` | `#0a0e15` | fundo raiz |
| `--bg-elevated` | `#101623` | panes, cards |
| `--bg-bar` | `#0c1119` | barras/chrome |
| `--border` / `--border-strong` | `#1d2637` / `#2c3a55` | divisórias |
| `--text` / `--text-dim` | `#d7dfec` / `#8a94aa` | texto (dim ≥5:1, WCAG AA — não baixar) |
| `--accent` | `#3dd9ff` | **só o que está vivo/interativo**: ação primária, foco, agente ativo |
| `--accent-ink` | `#051019` | tinta sobre CTA sólido de acento |
| `--danger` | `#ff7a90` | falha, destrutivo |
| `--design` | `#2f6ae0` | segunda voz: design mode |
| `--ok` / `--live` / `--warn` / `--gold` | `#7ee2a8` / `#3ce08d` / `#e5c07b` / `#ffd166` | sinais |

Derivados do acento (`--accent-soft/strong/hover/glow`) são `color-mix` do
`--accent` — **nunca** sobrescreva por tema; temas trocam só `--accent`.

### Estado operacional — um estado, uma cor, em toda superfície

`--state-running: accent` (respira em ciano) · `--state-ready/done: ok` ·
`--state-blocked: warn` · `--state-failed: danger` · `--state-pending: text-dim`.
Rail, OpsBoard, toolbar de pane, FleetChip e bordas de pane consomem SÓ estes
tokens. Estado nunca viaja só em cor: sempre com glifo/palavra
(`paneSessionView` em `src/shared/pane-session-view.ts`).

### Escalas

- Espaço: `--space-1..8` (4→64px). Tipo: `--text-2xs..hero` (10→34px).
- Raio: `--radius-xs..2xl` (2→18px) + `--radius-round`. Cards ≤ `--radius-xl`.
- Sombra: `--shadow-1..3`. z-index: ladder nomeada
  (`--z-soft-overlay:45 … --z-confirm:1300`) — nunca valor solto.
- `--bar-height: 44px`, `--toolbar-height: 28px`.

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

## 5. Componentes-primitivos (reusar, não reinventar)

- `ActionCard` / `EmptyState` (`components/ActionCard.tsx`, `ui-actions.css`) —
  todo empty state ensina + tem ação primária. "Nada aqui" sem CTA é bug.
- `ConfirmDialog` — confirm/alert nativos são proibidos.
- `PixelIcon` — set proprietário 11×11; ícone novo entra nele, não glifo Unicode
  solto (🎬 ★ ↻ são dívida).
- Chips da bar: altura 26px, `border-radius: 999px`, um idioma só
  (`.workspace-bar__zone--status > *`).
- Botões icon-only sempre com `aria-label` (title sozinho não basta).

## 6. Chrome e hierarquia

- WorkspaceBar: cada controle visível merece o lugar. Ação diária = **Nova
  missão** (única primária sólida). Secundário mora no `⋯` e no ⌘K.
  Gamificação (XP) fora da zona de status. "Novo workspace" fica no menu ▾ da
  marca (dois "Novo …" lado a lado confundem).
- Frota em linguagem clara: "2 trabalhando · 1 morto" (nunca "zzz"/"x").
- Pane comunica estado pela borda: busy = ciano, morto = danger, hibernado =
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

`ui-theme.ts`: nexus-dark (default), nexus-light, dracula, solarized-dark.
Tema = 10 vars de paleta; derivados seguem via color-mix. Tema claro ajusta
sinais (`--ok` etc.) para segurar AA. Modo pixel (`data-theme-pixel='on'`)
zera raios e promove VT323 a `--font-ui` — opt-in, ortogonal ao tema.

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
