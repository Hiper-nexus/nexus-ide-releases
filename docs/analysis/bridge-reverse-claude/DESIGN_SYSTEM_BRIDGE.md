# Design System do Bridge — DNA + Blueprint de clone pro Nexus

> **Método:** extraído do binário Tauri (`strings` em `bridgespace-tauri`), da screenshot da tela
> "Define the mission" (Step 1/3) e da arquitetura de overlay (web components Lit). É um **estudo de
> DNA** — estrutura, sistema de tokens e motion — pra **reconstruir com a cara do Nexus**, não cópia
> pixel-a-pixel de assets proprietários (logo/icons/wordmark/CSS literal). Isso é legalmente seguro
> **e** criativamente mais forte: você replica toda a interação e o "feel", com identidade própria.
>
> **Status:** v1 — tokens + arquitetura + componentes inferidos. **Falta** fechar agente-picker e o
> efeito builder→builder com screenshots/gravação (§7).

---

## 1. Por que o Bridge parece "caro" (o luxo é estrutura, não enfeite)

O que gera a sensação de produto premium — cada um replicável:

1. **Camada de overlay própria por cima do webview** (web components **Lit**: inspector, picker,
   connector, modal, agent menu, hover overlay). Tudo o que é "interação especial" vive fora da
   árvore do app principal e aparece on-demand com animação própria → parece flutuar.
2. **Sistema de tokens semântico shadcn-style** (`background/foreground/primary/accent/border/...`),
   não cores hard-coded. Escuridão/clareza e accent trocam por variável, não por retrabalho.
3. **Motion com easings expressivos**: um spring com overshoot (`cubic-bezier(.34,1.56,.64,1)`) pra
   entradas com personalidade + um smooth-out (`cubic-bezier(0.22,0.8,0.2,1)`) pro resto. É o que dá
   o "elastic/organic" que diferencia de `ease` padrão.
4. **Tipografia system-first**: `-apple-system` + `Inter` + `Menlo` mono. Zero webfont pesada →
   render nativa, FCP rápido, sensação de app de SO, não de site.
5. **z-index 100000** no overlay → sempre acima do xterm/canvas, sem guerra de stacking.
6. **Detalhes "made, not generated"**: accent rosa-magenta na palavra-chave do título, inset
   positional de overlay (`auto 0 0 auto` = canto inferior direito), microcopy curto e opinativo
   ("Shared with all agents so they can coordinate and stay aligned").

---

## 2. Tokens extraídos do binário (estrutura confirmada, valores a definir)

### 2.1 Tipografia
```
--font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
--font-mono:   ui-monospace, Menlo, monospace;
--font-size:   14px;            /* base */
```
- **Inter** é a única webfont; o resto é system. Decisivo: carrega rápido, renderiza como app nativo.
- Não usar weight demais — a vibe é regular/medium com 1 accent de peso no título.

### 2.2 Espaço / layout
```
--page-margin: 16px;
--inset: auto 0 0 auto;         /* overlay gruda no canto inferior direito */
--actor-inset: var(--inset);
--dialog-inset: var(--inset);
--z-index: 100000;              /* overlay SEMPRE no topo */
```

### 2.3 Cor — sistema semântico (shadcn-style)
Nomes confirmados no binário (valores literais são computados em runtime / CSS comprimido — não
extraídos; a **estrutura** é o achado):
```
--background, --foreground
--primary  (+ :hover, :focus-visible)
--accent-background, --accent-foreground
--default  (+ :hover, :focus-visible)
--border, --outline, --box-shadow
--success-color, --error-color
--interactive-filter          /* filtro no hover de elementos interativos (blur/saturate) */
```
- Padrão **shadcn**: tokens semânticos sobre HSL/OKLCH, dark+light pelo mesmo nome.
- **Âncora de accent visível na screenshot:** rosa-magenta (palavra "mission" em rosa).
- → **Clone pro Nexus:** manter a MESMA estrutura semântica, trocando só a âncora pela cor do Nexus.

### 2.4 Motion — os easings são o DNA
```
--ease-spring:  cubic-bezier(.34, 1.56, .64, 1);   /* overshoot — entradas com personalidade */
--ease-smooth:  cubic-bezier(0.22, 0.8, 0.2, 1);   /* smooth expressive out — transições */
```
Keyframes encontrados:
- `__bridgeConnectorGrow` → **o efeito de transferência builder→builder** (cresce uma conexão).
- `__bridgeModalIn`, `scaleIn`, `fadeUp` → entradas de overlay/modal.
- `__bridgePulse`, `pulse`, `ring` → estados de atividade/agente vivo.
- `check` → confirmação.

---

## 3. Arquitetura do overlay (o segredo técnico do "lindo")

- O webview principal roda o app (**Svelte** + **xterm**). Por cima, o Bridge injeta **web components
  Lit** (`__bridge*`) instanciados on-demand: `__bridge_inspector`, `__bridge_picker`,
  `__bridge_connector`, `__bridge_modal`, `__bridge_agent_menu`, `__bridge_hover_overlay`,
  `__bridge_hover_label`, `__bridge_input_wrap`.
- **IPC pesado webview→Rust via `document.title`**: `document.title = '__BRIDGE_PICKER__' + encoded`
  (chunked) — o Rust observa o title e puxa payloads grandes que não cabem num invoke único.
  (`__bridgePreparePickerChunks`, `__bridgeEmitPickerChunk`, `__bridgePickerChunks`.)
- Versão do overlay versionada: `__BRIDGE_INSPECTOR_VERSION__2026-05-21-picker-eval-chunk-pull-v1`.
- **Implicação pro clone:** o Nexus (renderer **React** + xterm + @xyflow) deve construir essa camada
  como **Portals** React (ou web components Lit puros) **fora** da árvore do grid/canvas, com
  `z-index: 100000` e mount on-demand — igual ao Bridge.

---

## 4. Componentes pra clonar (com a cara do Nexus)

### 4.1 Mission Wizard — Step 1 "Define the mission" (da screenshot)
- Modal/wizard central, **3 passos** (STEP 1 OF 3 · SWARM 1), footer `CANCEL | <progress> | NEXT →`.
- Título: "Define the **mission**" com a palavra-chave em **accent** (rosa no Bridge → cor do Nexus).
- Subtítulo curto e opinativo.
- Bloco **WORKING FOLDER**: path + `cd ../other-project` (affordance de troca rápida).
- Bloco **MISSION BRIEF**: textarea grande com **`@` pra referenciar arquivos** (mentions/picker).
- Linha rosa de apoio: "Shared with all agents so they can coordinate and stay aligned."
- **CONTEXT FILES — optional**: zona de drop/add de arquivos seed (ícone add).
- **Sidebar WORKSPACES** à esquerda: lista (BridgeBoard=kanban, BridgeMemory=grafo, Workspace=pasta)
  com ícones próprios por tipo, item selecionado em realce.

### 4.2 Agent picker (Step 2) — **PRECISO DE SCREENSHOT**
(Escolha dos agentes do swarm — papéis, modelo, effort. Estrutura inferida mas não confirmada.)

### 4.3 Swarm rodando + transferência builder→builder — **PRECISO DE SCREENSHOT/GRAVAÇÃO**
- Cards de agentes (Coordinator/Builders) em grid ou canvas.
- O `__bridge_connector` + keyframe `__bridgeConnectorGrow` = **o efeito que você amou**: uma
  conexão que cresce de um builder até outro em tempo real quando um handoff/mensagem passa.
- **Reconstrução inferida (pra confirmar com gravação):** path SVG entre dois cards animado por
  `stroke-dashoffset` ("desenha" a linha) + um node/pacote viajando pelo path (`offset-path`) +
  `cubic-bezier(.34,1.56,.64,1)` no grow pra dar o overshoot elástico.

### 4.4 Overlay components (Lit/Portal)
- **Inspector** (`__bridge_inspector`): overlay de inspeção de elemento/UI.
- **Picker** (`__bridge_picker`): seletor de arquivo/referência (chunked via title-set).
- **Modal** (`__bridge_modal`, `__bridgeModalIn`).
- **Agent menu** (`__bridge_agent_menu`, `__bridge_agent_btn`).
- **Hover overlay/label** (`__bridge_hover_overlay`, `__bridge_hover_label`): tooltip/preview on hover.

---

## 5. Blueprint de motion — o efeito builder→builder (especificação)

Reconstrução técnica pra implementar no Nexus (React + xyflow):

```
Trigger: evento de handoff/mensagem builder A → builder B
1. Calcular geometria: reta/curva (bezier) do centro do card A ao centro do card B.
2. "Desenhar" o conector:
   - <path> SVG com stroke-dasharray + stroke-dashoffset animado 1→0
     (dashoffset = pathLength → 0), easing --ease-smooth, ~280ms.
3. "Crescer" no destino (bridgeConnectorGrow):
   - No card B, um ring/halo escala 0.8 → 1.0 com --ease-spring (overshoot), opacity 0→1→0.
4. Node viajante (opcional, o "pacote"):
   - elemento com offset-path: path('...') e offset-distance 0%→100%, --ease-smooth, ~320ms,
     leva um ícone/dot do A pro B.
5. Pulse residual no card B (__bridgePulse) por ~600ms pra sinalizar "chegou".

Reduced motion (prefers-reduced-motion: reduce):
 - colapsa tudo pra um fade simples (opacity) ≤150ms, sem path/node.
```
Anima só `transform` e `opacity` (compositor-friendly), nunca layout.

---

## 6. Tokens Nexus ("nossa cara") — proposta de adaptação

Manter do Bridge (são decisões de sistema, não identidade):
- Estrutura semântica de tokens (background/foreground/primary/accent/border/outline/success/error/
  interactive-filter/z-index).
- Stack tipográfica system + Inter + Menlo, base 14px, page-margin 16px.
- Os 2 easings (`--ease-spring`, `--ease-smooth`) e o alfabeto de keyframes.
- Arquitetura overlay (Portal/web component fora da árvore, z-index 100000).
- O wizard de missão de 3 passos + @mentions + context files.

Trocar (a identidade do Nexus):
- **Âncora de accent**: a cor do Nexus (definir no `DESIGN.md` do projeto — não herdar o rosa do Bridge).
- **Ícones e wordmark**: próprios (nunca os do Bridge).
- **Copy/microcopy**: voz do Nexus.
- Nomes de componentes (`Nexus*` não `Bridge*`).

→ Próximo passo: gerar `tokens.css` + os componentes React (MissionWizard, AgentPicker, SwarmCanvas,
BuilderConnector) já conectados aos tokens do Nexus.

---

## 7. O que preciso de você pra fechar o clone (importante)

Animation e UI não se clonam sem **ver**. Manda:

1. **Screenshot do Step 2 (agent picker)** — como escolhe agentes/papéis/modelo.
2. **Screenshot do swarm rodando** — cards de builders + o conector em repouso.
3. **Gravação de tela (ou 3-4 shots em sequência) do efeito builder→builder em tempo real** —
   animation não captura em foto; preciso ver o timing/o que se move (linha? partícula? pacote?).
4. **Screenshot do sidebar de workspaces expandido** + qualquer painel "lindo"
   (browser/editor/git/skills tabs).
5. (Opcional) **inspector/picker aberto** pra clonar o overlay.

Com isso eu: (a) fecho este `DESIGN_SYSTEM_BRIDGE.md` com specs exatas, (b) gero `tokens.css` no
padrão do Nexus, (c) implemento os componentes React (`MissionWizard`, `AgentPicker`, `SwarmCanvas`,
`BuilderConnector`) já prontos pra plugar no renderer do Nexus.
