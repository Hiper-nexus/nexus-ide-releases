# DESIGN SYSTEM DO BRIDGE — referência de absorção para o NexusIDE

> **Versão reconciliada da referência Bridge**
> **Objetivo:** registrar padrões de composição, overlay e motion extraídos da
> engenharia reversa. Este documento **não** é uma especificação para clonar
> tokens do Bridge no Nexus.

Para implementação no Nexus, `DESIGN.md` é a autoridade e
[`NEXUS_X_BRIDGE.md`](./NEXUS_X_BRIDGE.md) define o que absorver. Não portar
literalmente `z-index: 100000`, paleta hardcoded, bounce/spring, title-set IPC ou
um segundo wizard paralelo. Parte dos valores visuais abaixo foi reconstruída de
assets/chunks e não passou por comparação visual runtime nesta sessão.

---

## 1. Princípios Fundamentais — "O Luxo por Estrutura"

O ecossistema BridgeSpace transparece uma percepção de produto "premium" e de alta qualidade devido a **seis princípios estruturais**, e não ao acúmulo de elementos decorativos:

1. **Camada de Overlay Isolada (`z-index: 100000`):** Toda interface flutuante (inspector, file picker, modais, menus contextuais) vive fora da árvore de componentes do app principal (xterm/grid), prevenindo relayouts e conflitos de empilhamento CSS.
2. **Tipografia System-First:** Uso predominante de fontes nativas do sistema (`-apple-system`, `Menlo`) complementadas apenas pela `Inter`. Isso garante carregamento instantâneo, baixo consumo de memória e renderização nativa de SO.
3. **Motion Elástico & Expressivo:** Animações baseadas em curvas de Bézier customizadas que entregam um _overshoot_ responsivo (spring) nas entradas e uma desaceleração orgânica nas transições.
4. **Sistema de Tokens Semânticos (shadcn-style):** Abstração completa das cores em tokens lógicos (`--background`, `--foreground`, `--primary`, `--accent`), permitindo alternância fluida entre dark e light modes.
5. **Microcopy Curto e Opinativo:** Textos orientativos concisos, com destaque de palavras-chave na cor de accent.
6. **Title-Set IPC Chunking:** Resiliência de transporte de dados de UI via fragmentação de payloads.

---

## 2. Tokens reconstruídos da referência Bridge

Os valores desta seção descrevem a hipótese visual reconciliada do Bridge. Eles
não substituem `src/renderer/styles/base.css`, a ladder semântica de overlays, o
CTA branco ou as curvas `ease-out` do Nexus.

### 2.1 Tipografia

```css
:root {
  --font-family:
    -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, Menlo, Monaco, "Cascadia Code", monospace;

  --font-size-xs: 12px;
  --font-size-sm: 13px;
  --font-size-base: 14px;
  --font-size-lg: 16px;
  --font-size-xl: 20px;

  --font-weight-regular: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
}
```

### 2.2 Tokens semânticos reconstruídos (não portar literalmente)

```css
:root {
  /* Tokens de Superfície */
  --background: #09090b;
  --foreground: #f4f4f5;
  --surface-card: #121215;
  --surface-overlay: #18181b;

  /* Tokens de Fronteira e Divisão */
  --border: #27272a;
  --outline: #3f3f46;

  /* Tokens Principais & Accents */
  --primary: #6366f1; /* Indigo Accent Nexus (substitui o Rosa Bridge) */
  --primary-hover: #4f46e5;
  --accent: #ec4899; /* Destaque de palavra-chave */
  --accent-foreground: #fdf2f8;

  /* Status & Operações */
  --success: #10b981;
  --warning: #f59e0b;
  --error: #ef4444;

  /* Overlay & Backdrop */
  --backdrop-blur: blur(16px);
  --overlay-shadow:
    0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
  --z-index-overlay: 100000;
}
```

### 2.3 Motion System (Easings & Timing)

```css
:root {
  /* Mola Elástica com Overshoot (Entradas com Personalidade) */
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);

  /* Suavização Orgânica (Transições e Saídas) */
  --ease-smooth: cubic-bezier(0.22, 0.8, 0.2, 1);

  /* Tempos Padrão */
  --duration-fast: 150ms;
  --duration-normal: 250ms;
  --duration-slow: 400ms;
}

/* Animações Canônicas */
@keyframes modalIn {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(8px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

@keyframes pulseHalo {
  0% {
    transform: scale(0.9);
    opacity: 0.8;
  }
  50% {
    transform: scale(1.15);
    opacity: 0.4;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}

@keyframes connectorGrow {
  from {
    stroke-dashoffset: 1000;
  }
  to {
    stroke-dashoffset: 0;
  }
}
```

---

## 3. Referência do efeito builder-to-builder handoff

O efeito é uma reconstrução de assets/chunks, não uma observação visual completa.
O padrão portável é continuidade origem→destino; duração, curva, halo e geometria
devem ser validados no Nexus e obedecer a `prefers-reduced-motion`.

O padrão visual de transferência de mensagens entre agentes pode orientar uma
evolução do NexusIDE (usando React + SVG overlay ou a infraestrutura já
existente), desde que a implementação seja validada no canvas real:

```
                       [STROKE-DASHOFFSET ANIMATION ~280ms]
Agent A Card -----------------------------------------------------> Agent B Card
(Origem)                                                            (Destino)
                                                                        │
                                                             [HALO SPRING PULSE]
                                                              cubic-bezier(.34,1.56,.64,1)
```

### Algoritmo de Execução

1. **Cálculo da Geometria:** Obter os centros das caixas delimitadoras (`getBoundingClientRect()`) dos cards do Agente A e Agente B.
2. **Construção do Path SVG:** Gerar uma curva de Bézier suave entre as coordenadas $(x_1, y_1)$ e $(x_2, y_2)$.
3. **Animação do Conector:**
   - Injetar o elemento `<path d="..." class="hand-off-path" />`.
   - Propriedades CSS: `stroke-dasharray: pathLength`, `stroke-dashoffset: pathLength -> 0`, com transição `animation: connectorGrow var(--duration-normal) var(--ease-smooth)`.
4. **Halo Overshoot no Destino:**
   - Ao atingir $100\%$ do trajeto, disparar no Card B uma classe `.agent-pulse-target` executando a animação `pulseHalo` com `--ease-spring` por $400\text{ms}$.

---

## 4. Componentes de referência a adaptar no NexusIDE

### 4.1 Mission Wizard (3-Step Modal)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 1 OF 3 · SWARM MISSION                                     [ X ]   │
│                                                                         │
│ Define the <span class="text-accent">mission</span>                             │
│ Set up the working scope, brief, and seed context files for your team.  │
│                                                                         │
│ WORKING FOLDER                                                          │
│ [/Users/cleofasrocha/dev/nexus-ide                    ] [Change Folder] │
│                                                                         │
│ MISSION BRIEF                                                           │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ Build a multi-tenant auth module. Use @src/auth/types.ts as ref...  │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ Shared with all agents in the swarm to coordinate execution.           │
│                                                                         │
│ CONTEXT FILES (OPTIONAL)                                                │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ [+ Drop files here or type @ in brief]  types.ts (12KB)              │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│ [ Cancel ]                                         [ Step 2: Agents → ] │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Adaptação recomendada no NexusIDE:

- **Mention Engine (`@`):** estender o textarea e o `MissionAttachmentPicker`
  existentes; não criar um fluxo concorrente.
- **Scope projector:** materializar uma projeção legível derivada do runtime
  canônico; nunca tornar o filesystem autoridade do swarm.
- **Overlay:** reutilizar a ladder de `base.css`, `panel-stack.ts` e portals já
  presentes. Nenhum valor de z-index solto.
- **Motion:** usar 150–220 ms e easings `--ease-out-*` do Nexus, com alternativa
  para reduced motion; sem spring/overshoot.

### 4.2 File Picker & Context Overlay (`@mention`)

- Renderização flutuante posicionada via `fixed` próximo ao cursor de digitação.
- Teclas de navegação `Up`, `Down`, `Enter`, `Escape`.
- Exibição de ícones de tipo de arquivo e caminho relativo formatado em tom atenuado (`--outline`).

---

## 5. Matriz de adaptação no codebase do NexusIDE

| Padrão                  | Seam existente no NexusIDE                             | Ação recomendada                                                                                                             |
| ----------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Tokens/motion**       | `DESIGN.md`, `src/renderer/styles/base.css`            | Preservar tokens, CTA branco, ladder semântica e `ease-out`; absorver apenas a clareza de estado.                            |
| **Overlays**            | `panel-stack.ts`, portals de Account/Squad/ContextMenu | Consolidar os overlays que ainda podem ser clipados; não criar um tier `100000`.                                             |
| **Mission Wizard**      | `MissionWizard.tsx`, `MissionWizardReview.tsx`         | Fatiar e reduzir o default para objetivo+contexto → rota pronta → iniciar; manter avançado colapsado.                        |
| **File Mention Picker** | textarea + `MissionAttachmentPicker.tsx`               | Adicionar `@` e botão explícito para arquivo de contexto, usando busca do workspace.                                         |
| **Handoff visual**      | `MissionEndorphinFx.tsx`, canvas/panes                 | Evoluir o burst genérico para continuidade origem→destino quando ambos estiverem visíveis; fallback compacto fora do canvas. |
