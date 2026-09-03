# BridgeSpace 3.4.18 — Design System (engenharia reversa)

> Extraído do frontend empacotado do BridgeSpace 3.4.18 (BridgeMind) — Tauri + React + Tailwind CSS v4.2.1.
> Fontes: `frontend/assets__index-D74TX2y4.css` (bundle principal, 275 KB, contém `@layer theme` + tokens `:root`),
> `frontend/assets__MainApp-g-5nXeZH.css` (componentes `jp-*`, `bsp-*`, `bnm-*`, `bap-*`, `bvs-*`, `git-*`, `browser-*`),
> `frontend/assets__index-DBr7BaOJ.css` (swarm UI `sw-*`), `frontend/assets__index-6nqAVf4W.css` + `assets__index-DCl43jvw.css` (canvas `bc-*`),
> `frontend/assets__WelcomeScreen-Cao7wkEc.css`, registry de temas em `frontend/assets__index-D0sLjlYW.js`,
> terminal em `frontend/assets__SimpleTerminal-M-KTTCPg.js`, bootstrap em `frontend/index.html`.
> Todos os valores citados são literais do bundle. Este documento é suficiente para recriar o visual sem abrir o app.

---

## 1. Fundação — Tailwind v4.2.1

O bundle abre com `/*! tailwindcss v4.2.1 */`. **Não usa `@theme`** — os tokens de design são emitidos dentro de
`@layer theme { :root, :host { ... } }` (formato compilado do Tailwind v4), seguidos de `@layer base` (preflight padrão),
componentes custom e utilities. O preflight é o stock do Tailwind v4 (reset de margin/padding, `box-sizing: border-box`,
`border: 0 solid`, fontes herdadas em form controls etc.).

Regra base custom relevante:

```css
button, [role=button], [role=tab], [role=menuitem], [role=menuitemradio],
[role=menuitemcheckbox], [role=switch], a, summary, select, label[for],
input[type=checkbox], input[type=radio] { cursor: pointer }
```

### 1.1 Bloco `:root, :host` (layer theme) — verbatim

```css
:root, :host {
  /* — Tipografia — */
  --font-sans: "Plus Jakarta Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, monospace;

  /* — Paleta utilitária (oklch, subset do Tailwind default) — */
  --color-red-200: oklch(88.5% .062 18.334);
  --color-red-300: oklch(80.8% .114 19.571);
  --color-red-400: oklch(70.4% .191 22.216);
  --color-red-500: oklch(63.7% .237 25.331);
  --color-orange-400: oklch(75% .183 55.934);
  --color-orange-500: oklch(70.5% .213 47.604);
  --color-amber-200: oklch(92.4% .12 95.746);
  --color-amber-300: oklch(87.9% .169 91.605);
  --color-amber-400: oklch(82.8% .189 84.429);
  --color-amber-500: oklch(76.9% .188 70.08);
  --color-yellow-300: oklch(90.5% .182 98.111);
  --color-emerald-400: oklch(76.5% .177 163.223);
  --color-emerald-500: oklch(69.6% .17 162.48);
  --color-cyan-400: oklch(78.9% .154 211.53);
  --color-cyan-500: oklch(71.5% .143 215.221);
  --color-sky-400: oklch(74.6% .16 232.661);
  --color-blue-300: oklch(80.9% .105 251.813);
  --color-blue-400: oklch(70.7% .165 254.624);
  --color-blue-500: oklch(62.3% .214 259.815);
  --color-blue-600: oklch(54.6% .245 262.881);
  --color-blue-700: oklch(48.8% .243 264.376);
  --color-indigo-400: oklch(67.3% .182 276.935);
  --color-violet-400: oklch(70.2% .183 293.541);
  --color-violet-500: oklch(60.6% .25 292.717);
  --color-purple-400: oklch(71.4% .203 305.504);
  --color-purple-500: oklch(62.7% .265 303.9);
  --color-fuchsia-500: oklch(66.7% .295 322.15);
  --color-rose-400: oklch(71.2% .194 13.428);
  --color-zinc-100: oklch(96.7% .001 286.375);
  --color-zinc-200: oklch(92% .004 286.32);
  --color-zinc-300: oklch(87.1% .006 286.286);
  --color-zinc-400: oklch(70.5% .015 286.067);
  --color-zinc-500: oklch(55.2% .016 285.938);
  --color-zinc-600: oklch(44.2% .017 285.786);
  --color-zinc-700: oklch(37% .013 285.805);
  --color-zinc-800: oklch(27.4% .006 286.033);
  --color-zinc-900: oklch(21% .006 285.885);
  --color-zinc-950: oklch(14.1% .005 285.823);
  --color-black: #000;
  --color-white: #fff;

  /* — Espaçamento / containers — */
  --spacing: .25rem;              /* base 4px; tudo é calc(var(--spacing) * N) */
  --container-xs: 20rem;  --container-sm: 24rem;  --container-md: 28rem;
  --container-lg: 32rem;  --container-xl: 36rem;  --container-2xl: 42rem;
  --container-3xl: 48rem; --container-4xl: 56rem; --container-5xl: 64rem;

  /* — Escala de texto — */
  --text-xs: .75rem;   --text-xs--line-height: calc(1 / .75);
  --text-sm: .875rem;  --text-sm--line-height: calc(1.25 / .875);
  --text-base: 1rem;   --text-base--line-height: 1.5;
  --text-lg: 1.125rem; --text-lg--line-height: calc(1.75 / 1.125);
  --text-xl: 1.25rem;  --text-xl--line-height: calc(1.75 / 1.25);
  --text-2xl: 1.5rem;  --text-2xl--line-height: calc(2 / 1.5);
  --text-3xl: 1.875rem;--text-3xl--line-height: 1.2;

  /* — Pesos / tracking / leading — */
  --font-weight-normal: 400; --font-weight-medium: 500; --font-weight-semibold: 600;
  --font-weight-bold: 700;   --font-weight-extrabold: 800; --font-weight-black: 900;
  --tracking-tighter: -.05em; --tracking-tight: -.025em; --tracking-normal: 0em;
  --tracking-wide: .025em;    --tracking-wider: .05em;   --tracking-widest: .1em;
  --leading-tight: 1.25; --leading-snug: 1.375; --leading-relaxed: 1.625;

  /* — Radius — */
  --radius-sm: .25rem;  --radius-md: .375rem; --radius-lg: .5rem;
  --radius-xl: .75rem;  --radius-2xl: 1rem;

  /* — Easing — */
  --ease-out: cubic-bezier(0, 0, .2, 1);
  --ease-in-out: cubic-bezier(.4, 0, .2, 1);

  /* — Animações Tailwind padrão — */
  --animate-spin: spin 1s linear infinite;
  --animate-ping: ping 1s cubic-bezier(0, 0, .2, 1) infinite;
  --animate-pulse: pulse 2s cubic-bezier(.4, 0, .6, 1) infinite;

  /* — Blur — */
  --blur-sm: 8px; --blur-md: 12px; --blur-xl: 24px; --blur-2xl: 40px; --blur-3xl: 64px;

  /* — Defaults de transição — */
  --default-transition-duration: .15s;
  --default-transition-timing-function: cubic-bezier(.4, 0, .2, 1);
  --default-font-family: var(--font-sans);
  --default-mono-font-family: var(--font-mono);

  /* — Aliases Tailwind → tokens semânticos (bg-surface, text-text-primary, border-border etc.) — */
  --color-surface: var(--surface);
  --color-surface-hover: var(--surface-hover);
  --color-surface-active: var(--surface-active);
  --color-background: var(--background);
  --color-panel: var(--panel);
  --color-border: var(--border);
  --color-border-hover: var(--border-hover);
  --color-border-active: var(--border-active);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-text-primary: var(--text-primary);
  --color-text-secondary: var(--text-secondary);
  --color-text-muted: var(--text-muted);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-muted: var(--muted);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-info: var(--info);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-danger: var(--danger);
  --color-selection: var(--selection);
  --color-elevated-surface: var(--elevated-surface);
  --color-overlay: var(--overlay);

  /* — Animações custom — */
  --animate-fade-in: fade-in .3s ease-out;
  --animate-slide-up: slide-up .2s ease-out;
  --animate-pulse-subtle: pulse-subtle 2s ease-in-out infinite;
}
```

> `--font-display` é referenciado por componentes (`--jp-display: var(--font-display, var(--font-sans, …))`)
> mas **não é definido** no bundle — cai sempre no fallback `--font-sans`.

---

## 2. Tokens semânticos — `:root` (tema dark default / fallback)

O tema default é definido em CSS puro (antes de qualquer JS de tema rodar), com **fallbacks simples** seguidos de
**progressive enhancement via `@supports (color: color-mix(in lab, red, red))`**. Verbatim, na ordem do bundle:

```css
:root {
  /* Superfícies */
  --surface: #161921;
  --surface-hover: #1e222d;
  --surface-active: #252a36;
  --background: #0c0e14;
  --panel: #101318;

  /* Bordas */
  --border: #252a36;
  --border-hover: #30384a;
  --border-active: #3b82f6a6;            /* azul primário 65% alpha */

  /* Texto */
  --text-primary: #e8ecf4;
  --text-secondary: #8b92a8;
  --text-muted: #545b72;

  /* Aliases estilo shadcn */
  --foreground: var(--text-primary);
  --card: var(--surface);
  --card-foreground: var(--text-primary);
  --popover: var(--elevated-surface);
  --popover-foreground: var(--text-primary);

  /* Ações */
  --primary: #3b82f6;                    /* blue-500 */
  --primary-foreground: #fff;
  --secondary: var(--surface);
}
@supports (color: color-mix(in lab, red, red)) {
  :root { --secondary: color-mix(in srgb, var(--surface) 86%, white 8%) }
}
:root {
  --secondary-foreground: var(--text-primary);
  --muted: var(--surface);
}
@supports (color: color-mix(in lab, red, red)) {
  :root { --muted: color-mix(in srgb, var(--surface) 78%, transparent) }
}
:root {
  --muted-foreground: var(--text-secondary);
  --accent: var(--primary);
}
@supports (color: color-mix(in lab, red, red)) {
  :root { --accent: color-mix(in srgb, var(--primary) 12%, var(--surface)) }
}
:root {
  --accent-foreground: var(--text-primary);
  --destructive: var(--danger);
  --destructive-foreground: #fff;
  --input: var(--background);
}
@supports (color: color-mix(in lab, red, red)) {
  :root { --input: color-mix(in srgb, var(--background) 88%, white 12%) }
}
:root {
  --ring: var(--focus-ring);
  --radius: .75rem;

  /* Estado / feedback */
  --info: #22d3ee;        /* cyan-400  */
  --success: #22c55e;     /* green-500 */
  --warning: #eab308;     /* yellow-500*/
  --danger: #ef4444;      /* red-500   */

  /* Papéis de agentes */
  --agent-coordinator: #3b82f6;
  --agent-builder: #22d3ee;
  --agent-scout: #22c55e;
  --agent-reviewer: #eab308;

  --selection: var(--primary);
}
@supports (color: color-mix(in lab, red, red)) {
  :root { --selection: color-mix(in srgb, var(--primary) 20%, transparent) }
}
:root { --elevated-surface: var(--surface) }
@supports (color: color-mix(in lab, red, red)) {
  :root { --elevated-surface: color-mix(in srgb, var(--surface) 80%, var(--text-primary) 10%) }
}
:root {
  --overlay: #00000080;
  --focus-ring: var(--primary);
}
@supports (color: color-mix(in lab, red, red)) {
  :root { --focus-ring: color-mix(in srgb, var(--primary) 40%, transparent) }
}
```

### 2.1 Tokens de terminal (chrome ao redor do xterm)

```css
:root {
  --terminal-font: "Plus Jakarta Sans", "Avenir Next", "Segoe UI", sans-serif;
  --terminal-mono: "JetBrains Mono", "Iosevka Term", "SF Mono", Menlo, Monaco, monospace;
  --terminal-gap: 0;
  --terminal-radius: 0;
  --terminal-border: transparent;
  --terminal-toolbar-bg: var(--surface);
  --terminal-panel-bg: var(--background);
  --terminal-panel-shadow: none;
  --terminal-active-shadow: none;
  --terminal-chip-bg: transparent;
  --terminal-chip-border: transparent;
  --terminal-drop-bg: var(--background);
}
@supports (color: color-mix(in lab, red, red)) {
  :root { --terminal-drop-bg: color-mix(in srgb, var(--background) 70%, transparent) }
}
.theme-light .terminal-panel { --terminal-drop-bg: #ffffffd1 }
.theme-black .terminal-panel { --terminal-drop-bg: #000000d1 }
```

### 2.2 Tokens de scrollbar

```css
:root {
  --scrollbar-thumb: var(--border);
  --scrollbar-thumb-hover: var(--primary);
  --scrollbar-thumb-active: var(--info);
  --scrollbar-track: transparent;
}
```

### 2.3 Outras regras globais

```css
body { background: var(--background); min-height: 0; position: relative }
::selection { background: color-mix(in srgb, var(--primary) 32%, transparent); color: var(--text-primary) }
.theme-transitioning * { transition: none !important }   /* aplicada no <html> durante a troca de tema */
```

Utilities custom notáveis do bundle principal:

```css
.gradient-text { background: linear-gradient(135deg, var(--color-primary), var(--color-info));
  -webkit-text-fill-color: transparent; -webkit-background-clip: text; background-clip: text }
.animate-in { animation: .15s ease-out forwards dropdown-in }
.fade-in-0 { --tw-enter-opacity: 0 }
.zoom-in-95 { --tw-enter-scale: .95 }
.slide-in-from-top-2 { --tw-enter-translate-y: -.5rem }
```

---

## 3. Sistema de temas

**Não há `prefers-color-scheme` nem `[data-theme]` no CSS.** A troca de tema é 100% JS (engine própria):

1. O id do tema persiste em `localStorage["bridgemind-theme"]`.
2. O `ThemeProvider` aplica: `document.documentElement.classList.add("theme-<id>")`,
   `setAttribute("data-theme-id", id)`, `style.colorScheme = mode` (`"dark"`/`"light"`).
3. Cada token do tema é injetado como **custom property inline** em `<html>`:
   `documentElement.style.setProperty("--" + key, value)` para cada chave de `theme.tokens`
   (ex.: `--surface`, `--background`, `--primary`…), sobrescrevendo os defaults do `:root`.
4. Durante a troca, adiciona `.theme-transitioning` (desliga todas as transições por 2 frames via `requestAnimationFrame` duplo).
5. `toggleTheme()` alterna apenas entre `["black", "light"]` (os dois temas nativos).
6. Temas com `warpBackground`/`backgroundImage` ganham a classe `theme-bg-passthrough` no shell e
   uma camada de fundo dedicada:

```css
#bridgespace-theme-bg { position: fixed; inset: 0; z-index: 0; pointer-events: none;
  background: var(--background, #000) }
#bridgespace-theme-bg > .theme-bg-fill  { position: absolute; inset: 0;
  background: var(--theme-bg-fill, var(--background, #000)) }
#bridgespace-theme-bg > .theme-bg-image { position: absolute; inset: 0;
  background-image: var(--theme-bg-image, none); background-size: cover;
  background-position: center; opacity: var(--theme-bg-image-opacity, 0);
  transition: opacity .2s ease, background-image 0ms }
.bridgespace-shell.theme-bg-passthrough { background: transparent !important }
```

Variáveis `--theme-*` geridas pelo engine: `--theme-bg-fill`, `--theme-bg-flat`, `--theme-bg-image`,
`--theme-bg-image-opacity`, `--theme-accent-fill`, `--theme-accent-flat`, `--theme-cursor`,
`--theme-detail-{main-text|sub-text|hint-text|disabled-text|foreground-button|accent-button|button-hover|button-click|keybinding-row-overlay|welcome-tips-completion-overlay}-opacity`, `--primary-foreground`.

### 3.1 Bootstrap anti-flash (inline no `index.html`)

```html
<!-- html, body: background #000000; color #FAFAFA (default dark antes do primeiro paint) -->
<script>
  var id = localStorage.getItem('bridgemind-theme') || '';
  var LIGHT_IDS = ['light','warp-light','solarized-light','gruvbox-light','marble','pink-city','snowy','received-referral-reward'];
  if (LIGHT_IDS.indexOf(id) !== -1) {
    document.documentElement.style.colorScheme = 'light';
    document.documentElement.style.background = '#FFFFFF';
    // injeta: html,body{background:#FFFFFF;color:#1A1D26}
  }
</script>
```

O splash de boot mostra spinner de 32px (`border: 2px solid currentColor; border-top-color: transparent`,
`animation: bspin 1s linear infinite`) na cor `#3b82f6`, com faixa superior de 28px reservada aos traffic lights do macOS.

### 3.2 Formato de tema — `bridgespace.theme` v1

Registry built-in (23 temas) em `index-D0sLjlYW.js`, cada um:

```js
{
  format: "bridgespace.theme", version: 1,
  id: "black", name: "Black", builtIn: true, mode: "dark",
  tokens: { surface, "surface-hover", "surface-active", background, panel,
            border, "border-hover", "border-active",
            "text-primary", "text-secondary", "text-muted",
            primary, info, success, warning, danger,
            "agent-coordinator", "agent-builder", "agent-scout", "agent-reviewer" },
  terminal: { background, foreground, cursor, cursorAccent,
              selectionBackground, selectionForeground,
              black, red, green, yellow, blue, magenta, cyan, white,
              brightBlack, brightRed, brightGreen, brightYellow,
              brightBlue, brightMagenta, brightCyan, brightWhite },
  editor: { background, foreground, cursor, selection, activeLine, gutter,
            gutterText, gutterActiveText, matchingBracket, lineNumber, lineNumberActive,
            keyword, string, number, comment, function, variable, type,
            operator, tag, attribute, property },
  // opcionais (temas estilo Warp):
  warpBackground: { type: "solid" | "vertical-gradient" | "horizontal-gradient", color|top/bottom|left/right, mid? },
  warpAccent:     { idem },
  backgroundImage:{ asset: "<arquivo>", opacity: 0-100 },
  cursor: "#hex",
  details: "darker" | "lighter" | { type: "custom", values: { mainText, subText, hintText, disabledText,
           foregroundButton, accentButton, buttonHover, buttonClick, keybindingRowOverlay,
           welcomeTipsCompletionOverlay } }   // valores 0-100 → viram opacidades CSS
}
```

### 3.3 Temas built-in (id — bg / surface / primary)

| id | Nome | mode | background | surface | primary |
|---|---|---|---|---|---|
| `black` | Black | dark | `#000000` | `#0a0a0a` | `#FFFFFF` |
| `light` | Light | light | `#FAFBFC` | `#F0F2F5` | `#2563EB` |
| `warp-dark` | Dark | dark | `#000000` | `#0D0D0D` | `#19AAD8` |
| `warp-light` | Light | light | `#FFFFFF` | `#F3F3F3` | `#00C2FF` |
| `dracula` | Dracula | dark | `#282A36` | `#333540` | `#FF79C6` |
| `solarized-light` | Solarized Light | light | `#FDF6E3` | `#F5EFDD` | `#66B5A9` |
| `solarized-dark` | Solarized Dark | dark | `#002B36` | `#0D3540` | `#CB4B16` |
| `gruvbox-dark` | Gruvbox Dark | dark | `#282828` | `#32312F` | `#FC802D` |
| `gruvbox-light` | Gruvbox Light | light | `#FBF1C7` | `#F1E8C0` | `#AD3B14` |
| `cyber-wave` | Cyber Wave | dark | `#001319` | `#0D1F25` | `#3E3C81` |
| `willow-dream` | Willow Dream | dark | `#114848` | `#1D5151` | `#EB8880` |
| `fancy-dracula` | Fancy Dracula | dark | `#313340` | `#3C3D4A` | `#AFC4F9` |
| `phenomenon` | Phenomenon | dark | `#121212` | `#1E1E1E` | `#2E5D9E` |
| `jellyfish` | Jellyfish | dark | `#1B1718` | `#272324` | `#538682` |
| `koi` | Koi | dark | `#211719` | `#2C2325` | `#FF3131` |
| `leafy` | Leafy | dark | `#000000` | `#0D0D0D` | `#55972D` |
| `marble` | Marble | light | `#E3E3E3` | `#D7D7D7` | `#585858` |
| `pink-city` | Pink City | light | `#FBEFF6` | `#EEE3E9` | `#E10087` |
| `snowy` | Snowy | light | `#EEF2F5` | `#E2E6E9` | `#647E90` |
| `red-rock` | Red Rock | dark | `#262325` | `#312E30` | `#9F4147` |
| `dark-city` | Dark City | dark | `#0C2932` | `#18343C` | `#E9072D` |
| `solar-flare` | Solar Flare | dark | `#1B1C18` | `#252623` | `#34895C` |
| `adeberry` | Adeberry | dark | `#1D2022` | `#272B2D` | `#6C96B4` |

Os temas `warp-*`, `dracula`, `solarized-*`, `gruvbox-*` etc. são portados do catálogo de temas do terminal Warp
(campos `warpBackground`/`warpAccent`/`details`). 18 deles trazem bloco `terminal` completo.

Tema nativo **black** (referência completa de tokens):

```js
tokens: { surface: "#0a0a0a", "surface-hover": "#141414", "surface-active": "#1a1a1a",
  background: "#000000", panel: "#050505", border: "#1f1f1f", "border-hover": "#2a2a2a",
  "border-active": "rgba(255, 255, 255, 0.45)", "text-primary": "#EBEBEB",
  "text-secondary": "#999999", "text-muted": "#666666", primary: "#FFFFFF",
  info: "#7B8794", success: "#4ADE80", warning: "#FACC15", danger: "#EF4444",
  "agent-coordinator": "#FFFFFF", "agent-builder": "#7B8794",
  "agent-scout": "#4ADE80", "agent-reviewer": "#FACC15" }
```

Tema nativo **light**: `surface #F0F2F5, surface-hover #E5E8ED, surface-active #DCE2EA, background #FAFBFC,
panel #F5F6F8, border #D1D5DC, border-hover #BCC5D2, border-active rgba(37,99,235,.65),
text-primary #1A1D26, text-secondary #4B5563, text-muted #9CA3AF, primary #2563EB, info #0891B2, success #16…`.

---

## 4. Tipografia

- **Sans/UI**: `"Plus Jakarta Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- **Mono/código**: `"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, monospace`
- **Mono do terminal**: `"JetBrains Mono", "Iosevka Term", "SF Mono", Menlo, Monaco, monospace`
- As fontes são referenciadas por nome (sem `@font-face` e sem Google Fonts no bundle extraído — dependem de
  instalação local/bundle nativo, com fallback de sistema).

Padrões recorrentes de composição (medidos nos componentes):

| Uso | font | size | weight | extras |
|---|---|---|---|---|
| Título de seção (settings) | sans | 12px | 600 | `letter-spacing: .08em; text-transform: uppercase` |
| Label micro (toggles) | mono | 10px | — | `letter-spacing: .1em; text-transform: uppercase; color: text-muted` |
| Tag/chip de terminal | sans | 9px | 650 | `text-transform: uppercase; letter-spacing: .06em` |
| Corpo | sans | 12–13px | 400–500 | `line-height: 1.4–1.5` |
| Descrição secundária | sans | 11.5px | 400 | `line-height: 1.4; color: text-muted` |
| Meta/rodapé | mono | 10.5px | — | `letter-spacing: .06em; color: text-muted` |
| Título de painel | sans | 11px | 650 | `letter-spacing: .01em; color: text-secondary` |
| Boot splash | sans | 14px | — | opacity .6 |

---

## 5. Componentes

### 5.1 Família `jp-*` — tela de Settings (em `MainApp-g-5nXeZH.css`)

Wrapper define tokens locais derivados por `color-mix`:

```css
.jp-settings {
  --jp-mono: var(--terminal-mono, ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace);
  --jp-display: var(--font-display, var(--font-sans, ui-sans-serif, system-ui, sans-serif));
  --jp-body: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
  --jp-edge: color-mix(in srgb, var(--border) 60%, transparent);
  --jp-edge-strong: color-mix(in srgb, var(--border) 90%, transparent);
  --jp-ink: var(--text-primary);
  --jp-ink-soft: var(--text-secondary);
  --jp-ink-muted: var(--text-muted);
  flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0;
  background: var(--background); color: var(--jp-ink); font-family: var(--jp-body);
}
.jp-settings-scroll { flex: 1 1 auto; overflow-y: auto; padding: 18px 18px 8px;
  display: flex; flex-direction: column; gap: 22px }
.jp-settings-section { display: flex; flex-direction: column; gap: 10px }
.jp-settings-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px }
```

**Toggle switch** (checkbox escondido + track/thumb; 30×16px, thumb 12px, desloca 14px):

```css
.jp-settings-toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none }
.jp-settings-toggle input { position: absolute; width: 1px; height: 1px; clip-path: inset(100%); overflow: hidden }
.jp-settings-toggle-track { position: relative; width: 30px; height: 16px; border-radius: 999px;
  background: color-mix(in srgb, var(--text-muted) 22%, transparent);
  border: 1px solid var(--jp-edge);
  transition: background .14s ease, border-color .14s ease; flex-shrink: 0 }
.jp-settings-toggle-thumb { position: absolute; top: 1px; left: 1px; width: 12px; height: 12px;
  border-radius: 50%; background: var(--jp-ink-soft);
  transition: transform .16s ease, background .16s ease }
.jp-settings-toggle input:checked + .jp-settings-toggle-track {
  background: color-mix(in srgb, var(--primary) 55%, transparent);
  border-color: color-mix(in srgb, var(--primary) 60%, transparent) }
.jp-settings-toggle input:checked + .jp-settings-toggle-track .jp-settings-toggle-thumb {
  transform: translate(14px); background: var(--jp-ink) }
.jp-settings-toggle input:focus-visible + .jp-settings-toggle-track {
  outline: 2px solid color-mix(in srgb, var(--primary) 60%, transparent); outline-offset: 2px }
```

**Row de skill** (card de lista): `padding: 8px 10px; border: 1px solid var(--jp-edge); border-radius: 6px;
background: color-mix(in srgb, var(--surface) 50%, transparent)`; hover eleva border para `--jp-edge-strong` e
surface para 70%; checkbox usa `accent-color: var(--primary)`. Estado desabilitado: `opacity: .5` + `cursor: not-allowed`.

**Textarea**: `min-height: 140px; padding: 10px 12px; font: mono 12px/1.5; border-radius: 6px;
background: color-mix(in srgb, var(--surface) 50%, transparent); border: 1px solid var(--jp-edge)`;
focus: `border-color: color-mix(in srgb, var(--primary) 55%, transparent)`; erro (`.jp-settings-textarea--over`):
`border-color: color-mix(in srgb, var(--danger, #e06262) 60%, transparent)`.

**Botão primário "Done"** (padrão do botão de ação do sistema):

```css
.jp-settings-done { appearance: none;
  border: 1px solid color-mix(in srgb, var(--primary) 45%, transparent);
  background: color-mix(in srgb, var(--primary) 18%, transparent);
  color: var(--jp-ink); font-size: 12px; font-weight: 500;
  padding: 6px 16px; border-radius: 6px; cursor: pointer;
  transition: background .14s ease, border-color .14s ease }
.jp-settings-done:hover { background: color-mix(in srgb, var(--primary) 30%, transparent);
  border-color: color-mix(in srgb, var(--primary) 65%, transparent) }
```

**Link-button**: transparente, 11.5px `text-muted`, hover `color: text-primary` +
`background: color-mix(in srgb, var(--text-muted) 12%, transparent)`; disabled `opacity: .4`.
**Footer**: `border-top: 1px solid var(--jp-edge); padding: 10px 18px 14px`.
**Footnote**: `border-top: 1px dashed var(--jp-edge)`.

### 5.2 Família `bnm-*` — modal de notificação (padrão de dialog)

```css
.bnm-backdrop { position: fixed; inset: 0; z-index: 70; display: flex; align-items: center;
  justify-content: center; padding: 24px;
  background: color-mix(in srgb, var(--background) 62%, transparent);
  backdrop-filter: blur(10px) saturate(.75); -webkit-backdrop-filter: blur(10px) saturate(.75);
  animation: bnm-fade .16s ease-out }
.bnm-card { position: relative; width: min(400px, 100%); padding: 22px 22px 20px;
  border: 1px solid var(--border); border-radius: 16px; background: var(--panel);
  box-shadow: 0 32px 80px -24px #0009, 0 0 0 1px color-mix(in srgb, var(--danger) 10%, transparent);
  animation: bnm-pop .22s cubic-bezier(.22, 1, .36, 1) }
.bnm-close { position: absolute; top: 12px; right: 12px; width: 26px; height: 26px;
  border: none; border-radius: 7px; background: transparent; color: var(--text-muted) }
.bnm-close:hover { background: var(--surface-hover); color: var(--text-primary) }
.bnm-btn { padding: 7px 14px; border: 1px solid var(--border); border-radius: 8px;
  background: transparent; color: var(--text-secondary); font-size: 12px; font-weight: 600;
  transition: background-color .12s ease, color .12s ease }
.bnm-btn:hover { background: var(--surface-hover); color: var(--text-primary) }
.bnm-btn--primary { border-color: transparent; background: var(--primary); color: var(--primary-foreground) }
.bnm-btn--primary:hover { background: color-mix(in srgb, var(--primary) 88%, var(--primary-foreground)) }
.bnm-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--primary) 60%, transparent); outline-offset: 1px }
```

### 5.3 Botões ícone — `bap-btn` / `bsp-icon-btn`

```css
.bap-btn { display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; border-radius: 6px;
  background: transparent; color: var(--text-secondary);
  transition: background .12s ease, color .12s ease }
.bap-btn:hover { background: var(--surface-hover); color: var(--text-primary) }
.bap-btn--active { color: var(--primary);
  background: color-mix(in srgb, var(--primary) 12%, transparent) }
.bsp-icon-btn { width: 24px; height: 24px; border-radius: 6px; … }   /* mesmo padrão, menor */
/* focus-visible compartilhado: outline 2px color-mix(primary 60%) offset 1px */
```

### 5.4 Sidebar / terminal — `bsp-*`

```css
.bsp-sidebar { flex: 0 0 var(--bsp-rail-w, clamp(292px, 24vw, 360px));
  border-right: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel) 68%, var(--background)) }
.bsp-rail-foot { padding: 8px 12px; gap: 8px; border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel) 82%, var(--background)) }
.bsp-term { flex: 0 0 var(--bsp-term-basis, 54%); min-width: 300px;
  border-left: 1px solid var(--border); background: var(--background) }
.bsp-term-head { min-height: 38px; padding: 0 8px 0 14px; border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel) 58%, var(--background)) }
.bsp-term-tag { padding: 2px 6px; border: 1px solid var(--border); border-radius: 5px;
  color: var(--text-muted); background: var(--surface); font-size: 9px; font-weight: 650;
  text-transform: uppercase; letter-spacing: .06em }
.bsp-term-viewport { padding: 10px; overflow: hidden }
```

**Avatar de agente** (`bsp-agent`): quadrado 34×34 `border-radius: 9px` (foco: 42×42, radius 11), cor derivada do
accent do agente: `color: color-mix(in srgb, var(--bsp-agent-accent) 74%, var(--text-primary))`,
`background: color-mix(in srgb, var(--bsp-agent-accent) 11%, var(--surface))`.

**Status dot** (`bsp-dot`): 10px (7px inline), `border: 2px solid var(--panel)`; mapa de status:
`--running → var(--success)`, `--idle → var(--warning)`, `--done → var(--info)`, `--error → var(--danger)`,
`--spawning/--unknown → var(--text-muted)`.

### 5.5 Swarm UI — `sw-*` (`index-DBr7BaOJ.css`)

Tokens locais da família:

```css
--sw-ease-standard: cubic-bezier(.4, 0, .2, 1);
--sw-ease-glide: cubic-bezier(.16, 1, .3, 1);
--sw-ease-spring: cubic-bezier(.34, 1.56, .64, 1);
--sw-radius-chip: 11px;
--sw-radius-panel: 16px;
--sw-shadow-rest:  inset 0 1px 0 0 color-mix(in srgb, #fff 6%, transparent),
                   0 10px 24px -12px rgba(0,0,0,.5), 0 2px 8px -5px rgba(0,0,0,.4);
--sw-shadow-focus: inset 0 1px 0 0 color-mix(in srgb, #fff 7%, transparent),
                   0 18px 44px -14px rgba(0,0,0,.6), 0 6px 16px -8px rgba(0,0,0,.45);
--sw-shadow-drag:  0 28px 70px -22px rgba(0,0,0,.65), 0 10px 26px -10px rgba(0,0,0,.5);
```

**Botão tonal** (`sw-btn`): `padding: 6px 10px; border-radius: 8px; border: none; font-size: 10px; font-weight: 600;
background: color-mix(in srgb, var(--sw-accent, var(--primary)) 12%, transparent);
color: var(--sw-accent, var(--primary))`; hover sobe para 22%; focus usa `box-shadow: 0 0 0 1px color-mix(… 50%)`;
variante `--danger` usa `var(--danger)` a 10%/20%.

**Chip de agente** (`sw-chip`): radius 11px, `--sw-chip-border: color-mix(accent 28%)`, hover `translateY(-1px)`,
selecionado/focado ganha anel externo `box-shadow: 0 0 0 1.5px color-mix(accent 60%), 0 0 28px -6px color-mix(accent 45%)`
(`.sw-chip:after` com `inset: -4px`). Status running/spawning intensifica borda (70%) e tint (12%).

**Command bar** (`sw-cmdbar__panel`) — o componente mais "glass" do app:

```css
.sw-cmdbar__panel { border-radius: 16px;
  background: color-mix(in srgb, var(--surface) 78%, transparent);
  border: 1px solid var(--border);
  backdrop-filter: blur(26px) saturate(1.3); -webkit-backdrop-filter: blur(26px) saturate(1.3);
  box-shadow: inset 0 1px color-mix(in srgb, #fff 7%, transparent), … }
.sw-cmdbar__panel:focus-within {
  border-color: color-mix(in srgb, var(--primary) 55%, var(--border));
  box-shadow: inset 0 1px color-mix(in srgb, #fff 7%, transparent),
              0 24px 60px -18px #0009,
              0 0 0 3px color-mix(in srgb, var(--primary) 16%, transparent) }
```

### 5.6 Canvas / outros módulos

- `bc-*` (canvas de agentes): estados por classe `is-*` (`is-primary`, `is-danger`, `is-focused`, `is-dragging`,
  `is-listening`, `is-speaking`, `is-thinking`, `is-on`); orbe com `bc-orb__halo`, `bc-orb__spinner`.
- `git-*` (painel git): `git-primary`/`git-secondary` (botões), `git-ghost`, `git-tabs`/`git-tab`, diff/log/review.
- `browser-*` (browser embutido), `bvs-*` (voice/sphere: aurora, halo, orbit, sheen, swirl — efeitos animados),
  `bnm-*` (modal), `bap-*` (agent panel), `bwv-*` (webview).
- `welcome-card` (WelcomeScreen): spotlight radial que segue o mouse
  (`radial-gradient(220px circle at var(--mx) var(--my), color-mix(in srgb, var(--accent) 20%, transparent), transparent 60%)`),
  rail lateral `linear-gradient(180deg, transparent, var(--accent), transparent)` que expande com
  `cubic-bezier(.16, 1, .3, 1)`, e sheen animado (`welcome-sheen` 1.05s) no hover; ícone faz
  `translateY(-1px) scale(1.08)` com glow `0 10px 26px -8px color-mix(accent 50%)`.

---

## 6. Padrões visuais

### 6.1 `color-mix()` como idioma central

Quase toda cor derivada usa `color-mix(in srgb, <token> <pct>%, transparent|white|<outro-token>)` —
o bundle inteiro evita hex hardcoded fora da paleta. Percentuais recorrentes:

- Tint de ação (fundos de botão/chip): primary **12%** (rest) → **18–22%** (hover) → **30%** (ativo)
- Bordas de foco/anel: primary **45–60%**
- Overlays de superfície: surface **50%/70%/78%** sobre transparent
- Glow/sombra colorida: accent **28–50%**
- Seleção: primary **20%** (`:root`), **30–32%** (`::selection`)
- Mix de painéis: `color-mix(in srgb, var(--panel) 58–82%, var(--background))` para headers/footers

Fallback sem `color-mix` é sempre declarado antes e refinado dentro de
`@supports (color: color-mix(in lab, red, red))`.

### 6.2 Glassmorphism / backdrop-filter

| Componente | backdrop-filter |
|---|---|
| Modal backdrop (`bnm`) | `blur(10px) saturate(.75)` |
| Command bar (`sw-cmdbar`) | `blur(26px) saturate(1.3)` |
| Painéis swarm diversos | `blur(14px)`, `blur(16px)`, `blur(18px)`, `blur(20px)`, `blur(24px) saturate(1.2)` |
| Headers/overlays menores | `blur(12px)`, `blur(6px)`, `blur(4px)`, `blur(3px)`, `blur(2px)` |
| Chromium legacy | sempre com prefixo `-webkit-backdrop-filter` duplicado |

### 6.3 Sombras (valores literais)

- Modal: `0 32px 80px -24px #0009` (+ anel `0 0 0 1px color-mix(danger 10%)` no caso do bnm)
- Dropdown/popover: `0 24px 60px #00000073, 0 2px 6px #00000040`
- Card elevado: `0 12px 32px -8px #0000008c, 0 4px 12px -4px #00000059, inset 0 1px color-mix(white 4%)`
- Focus ring (variação box-shadow): `0 0 0 3px color-mix(in srgb, var(--primary) 14–18%, transparent)`
- Glow de botão primário: `inset 0 1px color-mix(#ffffff 22%), 0 1px 2px color-mix(primary 35%)`
- Swarm: `--sw-shadow-rest/-focus/-drag` (ver §5.5)

### 6.4 Bordas e radius

- Borda padrão: **1px solid `var(--border)`**; hover `var(--border-hover)`; ativa `var(--border-active)`
- Radius: botões/chips **6–8px**, cards/rows **6px**, modais/painéis **16px**, avatares **9–11px**,
  toggles/pills **999px**, token global `--radius: .75rem` (12px)
- Highlight interno: `inset 0 1px color-mix(in srgb, #fff 4–7%, transparent)` (top highlight de vidro)

### 6.5 Focus visível (acessibilidade)

Dois idiomas, sempre na cor primária:
1. `outline: 2px solid color-mix(in srgb, var(--primary) 60%, transparent); outline-offset: 1–2px` (botões, toggles)
2. `box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary) 45–50%, transparent)` ou anel duplo
   `0 0 0 2px var(--background), 0 0 0 3.5px color-mix(primary 60%)` (chips/cards)

### 6.6 Scrollbars

```css
.custom-scrollbar { scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
  touch-action: pan-x pan-y; overscroll-behavior: contain }
.custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px }
.custom-scrollbar::-webkit-scrollbar-track { background: var(--scrollbar-track) }
.custom-scrollbar::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb);
  background-clip: padding-box; border-radius: 4px; transition: all .2s }
.custom-scrollbar::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover) }

.tab-bar-scrollable::-webkit-scrollbar { height: 3px }       /* tab bar: 3px */
.kanban-column-scroll::-webkit-scrollbar { width: 4px }      /* kanban: 4px, invisível até hover da coluna */
.scrollbar-none { scrollbar-width: none }                    /* ocultar total */
```

### 6.7 Animações

Keyframes definidos no bundle principal:

```css
@keyframes fade-in   { 0% { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
@keyframes float     { 0%, to { transform: translateY(0) } 50% { transform: translateY(-8px) } }
@keyframes slide-up  { 0% { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
@keyframes pulse-subtle { 0%, to { opacity: 1 } 50% { opacity: .7 } }
@keyframes dropdown-in  { 0% { opacity: 0; transform: scale(.95) translateY(-4px) } to { opacity: 1; transform: none } }
@keyframes dropdown-out { 0% { opacity: 1 } to { opacity: 0; transform: scale(.95) translateY(-4px) } }
@keyframes shimmer   { 0% { transform: translate(-100%) } to { transform: translate(100%) } }
@keyframes drop-indicator-pulse { 0%, to { opacity: 1 } 50% { opacity: .5 } }
@keyframes connectorPulse { 0%, to { opacity: .4; transform: translate(-50%) scale(1) }
                            50% { opacity: 1; transform: translate(-50%) scale(1.8) } }
@keyframes connectorDrop  { 0% { opacity: 1; top: 0 } 80% { opacity: 1 } to { opacity: 0; top: 100% } }
@keyframes bnm-fade / bnm-pop / welcome-sheen / bspin (boot)  /* nos chunks de componentes */
```

**Durações dominantes** (frequência no CSS do MainApp): `.14s` (70×), `.12s` (30×), `.16s` (23×), `.13s` (9×),
`.22s`/`.2s` — micro-interações de 120–160ms; entradas de modal/dropdown 160–220ms; hover de cards 200–350ms.

**Easings**: padrão `cubic-bezier(.4, 0, .2, 1)` (Material standard) e `cubic-bezier(0, 0, .2, 1)` (`--ease-out`);
ênfase/entrada `cubic-bezier(.22, 1, .36, 1)` (bnm-pop), `cubic-bezier(.16, 1, .3, 1)` (glide/expo-out, WelcomeScreen
e swarm), molas `cubic-bezier(.34, 1.56, .64, 1)` (spring, overshoot leve).

### 6.8 Drag & drop de tabs

```css
.tab-dragging { transition: opacity .15s, transform .15s; transform: scale(.95); opacity: .4 !important }
.tab-drag-over-highlight { background-color: color-mix(in srgb, var(--primary) 8%, transparent) !important;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 25%, transparent);
  transition: background-color .15s, box-shadow .15s }
.tab-drop-indicator { animation: 1.2s ease-in-out infinite drop-indicator-pulse }
```

---

## 7. Terminal (xterm.js)

Configuração do `Terminal` (em `SimpleTerminal`):

```js
new Terminal({
  cursorBlink: true, cursorStyle: "block",
  fontSize: <settings>,          // default 14, clamp 8–28 (localStorage "bridgespace-terminal-font-size")
  fontFamily: <settings>,        // default '"JetBrains Mono", "SF Mono", Menlo, Monaco, monospace'
  fontWeightBold: "bold",
  lineHeight: 1.2,
  theme: { ...themeAtual.terminal },
  allowTransparency: false,
  scrollback: <Bs>, scrollOnUserInput: true,
  overviewRuler: { width: 0 }, fastScrollSensitivity: 5,
  minimumContrastRatio: 1, drawBoldTextInBrightColors: false,
  macOptionClickForcesSelection: …
})
```

Tema xterm = bloco `terminal` do tema ativo. Exemplo (tema `black`), verbatim:

```js
terminal: { background: "#000000", foreground: "#EBEBEB", cursor: "#FFFFFF",
  cursorAccent: "#000000", selectionBackground: "rgba(255, 255, 255, 0.15)",
  selectionForeground: "#EBEBEB",
  black: "#0a0a0a", red: "#F87171", green: "#4ADE80", yellow: "#FACC15",
  blue: "#93C5FD", magenta: "#E879F9", cyan: "#67E8F9", white: "#A3A3A3",
  brightBlack: "#525252", brightRed: "#FCA5A5", brightGreen: "#86EFAC",
  brightYellow: "#FDE68A", brightBlue: "#BFDBFE", brightMagenta: "#F0ABFC",
  brightCyan: "#A5F3FC", brightWhite: "#E5E5E5" }
```

O editor (CodeMirror) usa o bloco `editor` do mesmo tema (background/foreground/cursor/selection/activeLine/gutter/
syntax: keyword, string, number, comment, function, variable, type, operator, tag, attribute, property).

---

## 8. Marca

- **Ícone** (`bridgespace-icon-*.svg`): quadrado 256×256 super-arredondado (~radius 20%) com grade 2×2 de "panes"
  e linhas de texto cinzas (`#888888`, stroke .75). Gradiente principal diagonal (top-left → bottom-right):
  `#110B0B → #A55900 (24%) → #F6B000 (48%) → #0060B0 (67%) → #000061 (87%) → #00003B` — ou seja,
  **âmbar/amarelo (#F6B000) encontrando azul profundo (#0060B0/#000061)** sobre base quase preta.
  Panes internos usam gradientes escuros complementares (`#3E361C→#002A49`, `#271A0D→#383114`, `#382E08→#002E4E`)
  com strokes `#C6C6C6` esmaecendo para 36% de opacidade.
- **Splash** (win-393): logo bolt hexagonal metade amarelo/metade azul sobre fundo preto, tagline
  "THE FIRST AGENT SUPER APP" em caps espaçadas.
- **Acento magenta/rosa** aparece via temas: Dracula (`#FF79C6`), Pink City (`#E10087`), ANSI magenta `#E879F9` —
  não faz parte do gradiente do logo, mas é usado em destaques de UI em temas claros (ex.: dialog "Resume your agents").
- Utility de marca: `.gradient-text` — `linear-gradient(135deg, var(--color-primary), var(--color-info))` com
  `background-clip: text`.
- Logos PNG bundled: `mainLogoDark`, `mainLogoWhite`, `logoSymbol`.

---

## 9. Convenções de nomenclatura e estrutura

1. **Tailwind v4.2.1 compilado**: `@layer properties` (defaults `--tw-*`), `@layer theme` (tokens em `:root,:host`),
   `@layer base` (preflight), depois componentes e utilities. Sem `@theme`, sem config JS — tudo resolvido em build.
2. **Tokens semânticos sem prefixo** (`--surface`, `--background`, `--primary`, `--text-*`, `--border*`) definidos em
   `:root` e sobrescritos inline no `<html>` pelo engine de temas; aliases `--color-*` mapeiam tokens → utilities
   Tailwind (`bg-surface`, `text-text-primary`, `border-border`, `bg-background` etc.).
3. **Prefixos de módulo** (BEM-ish, `__element` e `--modificador`):
   `jp-` (settings), `bnm-` (notification modal), `bap-` (agent panel), `bsp-` (sidebar/split panel),
   `bvs-` (voice sphere), `bwv-` (webview), `sw-` (swarm), `bc-`/`bcanvas-` (canvas), `git-`, `browser-`,
   `welcome-card__*`. Estados booleanos como `is-*` (`is-primary`, `is-dragging`, `is-focused`) ou
   `data-status`/`data-selected`.
4. **Tokens locais de componente**: famílias definem os próprios tokens com prefixo (`--jp-edge`, `--sw-accent`,
   `--sw-shadow-rest`, `--bsp-rail-w`, `--bsp-agent-accent`), sempre derivando dos tokens globais via `color-mix`.
5. **Dupla declaração fallback → `@supports(color-mix)`**: todo valor derivado é declarado primeiro em forma simples
   e depois refinado; padrão obrigatório para qualquer cor nova.
6. **z-index** (observado): base 0–8 em layout, 10–20 painéis/dropdowns, 30–50 overlays/popovers, **70** modais (`bnm-backdrop`).
7. **Layout do shell**: faixa superior de **28px** para a titlebar do macOS (traffic lights); fundo do documento
   `#000000`/`#FAFAFA` no boot; `overscroll-behavior: none` no documento (painéis individuais controlam o scroll,
   com `overscroll-behavior: contain` nos scrollables).
8. **Persistência**: tema em `localStorage["bridgemind-theme"]`; fonte do terminal em
   `bridgespace-terminal-font-size` / `bridgespace-terminal-font-family`.
9. **Layers finais do CSS**: utilities custom de app (`.gradient-text`, `.custom-scrollbar`, `.animate-in`,
   `.fade-in-0`, `.zoom-in-95`, `.slide-in-from-top-2`, `.scrollbar-none`, `.tab-bar-scrollable`,
   `.kanban-column-scroll`) após as utilities Tailwind.
