# Nexus IDE — Inventário completo de UI + auditoria de legibilidade

**Data:** 2026-07-12  
**Escopo:** renderer Electron (`src/renderer/**`) + janela pet (`src/renderer/pet/**`)  
**Método:** inventário fechado de superfícies montadas em `App.tsx` + settings nav + pet window; score por superfície (não só amostra).  
**Critério (mesmo do fix de Pet):** hierarquia de CTA · hit target ≥ ~44–52px em ações de produto · ícone/identidade · empty state com ação · nota de ajuda sem competir com o botão.

### Escala

| Score | Significado |
| --- | --- |
| **A** | Cliente enxerga e age; hierarquia e empty ok |
| **B** | Usável; polish de ícone/tamanho/empty |
| **C** | Risco real: miúdo, denso, empty fraco ou sem ícone |
| **D** | CTA de produto fácil de não ver (prioridade fix) |
| **—** | Superfície densa de power-user / monitoramento (não forçar “card grande”) |

---

## 1. Mapa do shell (árvore real)

```text
BootScreen
├── (sem workspace) LaunchScreen + overlays parciais
└── (com workspace)
    ├── WorkspaceBar
    ├── MissionRail | FilesPanel | PaneGrid|CanvasView | HomeDeck | OrchestrationPanel
    ├── OpsBoard | DiffAnnotatePanel | IntegrationsPanel
    ├── VoiceHud | VoiceSettings
    ├── SettingsDrawer → N seções
    ├── MissionWizard | OperatorProfile | OperatorFx
    ├── CloseWorkspaceDialog | Onboarding
    ├── CommandPalette | KeyboardCheatsheet
    ├── ConfirmDialog | Toasts | UpdateNotifier
    └── (processo separado) PetApp window
```

Arquivo âncora: `src/renderer/App.tsx`.

---

## 2. Inventário fechado — Shell & workspace

| ID | Superfície | Arquivo(s) principal | CSS | Score | Notas |
| --- | --- | --- | --- | --- | --- |
| S01 | Boot | `App.tsx` BootScreen | `base.css` | **A** | Marca + label; ok |
| S02 | Launch (sem WS) | `LaunchScreen.tsx` | `launch.css` | **B** | Bom; empty de lista pode ser mais CTA |
| S03 | Workspace bar | `WorkspaceBar.tsx` | `base.css`, `home-billing.css` | **B** | Primário ok; muitos icon-only; fleet chip denso |
| S04 | Fleet chip | `WorkspaceBar.tsx` | `base.css` | **B/—** | Power-user; legenda só no title |
| S05 | Account switcher | `AccountSwitcher.tsx` | `rail-onboarding.css` | **C** | Empty fraco; lista densa |
| S06 | Cost badge | `CostBadge.tsx` | `cost-operator.css` | **—** | Monitoramento |
| S07 | Update status | `UpdateModal.tsx` | `overlays.css` | **B** | OK; notifiers podem ser mais visíveis |
| S08 | Voice button (bar) | `VoiceButton.tsx` | `canvas-voice.css` | **B** | Ícone ok |
| S09 | Vision indicator | `VisionIndicator.tsx` | — | **B** | Status |
| S10 | Dev server chip | `DevServerChip.tsx` | — | **—** | Chip operacional |
| S11 | Mission rail | `MissionRail.tsx` | `rail-onboarding.css` | **C** | Heads 11px; empty CTA modestos |
| S12 | Files panel | `FilesPanel.tsx` | `panels.css` | **B/—** | Explorer denso ok; empty file tree fraco |
| S13 | Pane grid | `PaneGrid.tsx`, `PaneLeaf.tsx` | `panels.css` | **—** | Layout |
| S14 | Pane toolbar | `PaneToolbar.tsx` | `panels.css` | **—** | Icon-only denso (esperado) |
| S15 | Agent drop zone | `AgentDropZone.tsx` | — | **B** | |
| S16 | Canvas view | `CanvasView.tsx`, `CanvasPaneNode.tsx` | `canvas-cockpit.css` | **B** | Cockpit; densidade alta ok |
| S17 | Sticky notes | `StickyNote.tsx`, `StickyNoteNode.tsx` | — | **B** | |
| S18 | Home deck | `HomeDeck.tsx` | `home-deck.css` | **A** | Referência de empty-state bom |
| S19 | Orch panel | `OrchestrationPanel.tsx` | `orchestration.css` | **C** | Vários empties **sem botão** |
| S20 | Ops board | `OpsBoard.tsx` | `ops-board.css` | **B** | Empty com título; CTA pode ser maior |
| S21 | Diff annotate | `DiffAnnotatePanel.tsx` | — | **B** | Tool |
| S22 | Integrations | `IntegrationsPanel.tsx` | `integrations.css` | **C/D** | 10–11px; lista densa; empty fraco |
| S23 | Browser pane | `BrowserPane.tsx` | — | **—** | Host |
| S24 | Browser design bar | `BrowserDesignBar.tsx` | — | **B** | Toolbar |
| S25 | Design sidebar | `DesignSidebar.tsx` | — | **B** | |

---

## 3. Inventário fechado — Overlays / modais globais

| ID | Superfície | Arquivo | CSS | Score | Notas |
| --- | --- | --- | --- | --- | --- |
| O01 | Mission wizard | `MissionWizard.tsx`, `MissionWizardReview.tsx` | `launch-wizard.css` | **B** | Longo; steps ok; CTAs podem ser mais “card” |
| O02 | Command palette | `CommandPalette.tsx` | `overlays.css` | **B** | Empty sem atalhos sugeridos fortes |
| O03 | Keyboard cheatsheet | `KeyboardCheatsheet.tsx` | `overlays.css` | **A** | Ajuda contextual |
| O04 | Confirm dialog | `ConfirmDialog.tsx` | `overlays.css` | **A** | Botões claros |
| O05 | Close workspace | `CloseWorkspaceDialog.tsx` | — | **A** | |
| O06 | Onboarding | `Onboarding.tsx` | `rail-onboarding.css` | **B** | Pode ser mais card-step |
| O07 | Toasts | `Toasts.tsx` | `overlays.css` | **B** | Sem ícone de tipo |
| O08 | Update modal/notifier | `UpdateModal.tsx` | `overlays.css` | **B** | |
| O09 | Operator profile | `OperatorProfile.tsx` | `cost-operator.css` | **B** | Gamificação densa mas com identidade |
| O10 | Operator HUD | `OperatorHud.tsx` | `cost-operator.css` | **—** | HUD |
| O11 | Operator FX | `OperatorFx.tsx` | — | **—** | Efeitos |
| O12 | Operator sprite | `OperatorSprite.tsx` | — | **A** | Identidade pixel |
| O13 | Error boundary | `ErrorBoundary.tsx` | — | **B** | |
| O14 | Agent picker (in bar) | `WorkspaceBar.tsx` | `overlays.css` | **C** | Empty “Nenhuma CLI” sem CTA grande para Providers |

---

## 4. Inventário fechado — Voz

| ID | Superfície | Arquivo | CSS | Score | Notas |
| --- | --- | --- | --- | --- | --- |
| V01 | Voice HUD | `VoiceHud.tsx` | `canvas-voice.css` | **B** | Orb + estados; mensagens de mic ok |
| V02 | Voice settings drawer | `VoiceSettings.tsx` (~1k linhas) | `voice-settings.css` | **C** | Muito denso; falta agrupamento visual por painel |
| V03 | Audio devices | `AudioDeviceControls.tsx` | `settings-controls.css` | **C** | Selects/miúdos |
| V04 | Voice section (settings) | `ModuleSections.tsx` VoiceSection | — | **B** | Ponte para VoiceSettings |

---

## 5. Inventário fechado — Settings (todas as seções)

Nav: `settings-nav.ts` — **26 seções**.

| ID | Seção | Componente | Score | pixelIcon nav | Notas de melhoria |
| --- | --- | --- | --- | --- | --- |
| K01 | account | `AccountSection.tsx` + billing | **B** | sim | CTAs plano podem ser cards |
| K02 | appearance | `AppearanceSection.tsx` | **B** | sim | |
| K02a | appearance → pet | `PetSection.tsx` | **A** | (sub) | **Já melhorado** (cards + ícones) |
| K03 | terminal | `ModuleSections` TerminalSection | **B** | sim | |
| K04 | shortcuts | `CatalogSectionsOps` ShortcutsSection | **C** | **não** (CMD) | Dar pixelIcon; lista densa |
| K05 | voice | VoiceSection | **B→C** | sim | Depende de V02 |
| K06 | providers | `ProvidersPanel.tsx` | **D** | sim | Keys: botões miúdos Salvar/Testar/Limpar |
| K07 | ranking | `ModelRankingSection.tsx` | **A** | **não** (RNK) | Visual forte; falta pixelIcon na nav |
| K08 | squads | SquadsSection + `OrchestratorDefaults` | **B** | sim | |
| K09 | diagnostics | `DiagnosticsSection.tsx` | **C** | **não** (DIA) | Permissões/mic; CTAs pouco “card” |
| K10 | mcps | Catalog McpsSection | **C** | ? | Arsenal empty fraco |
| K11 | tools | ToolsSection | **C** | | |
| K12 | media | `MediaSection.tsx` | **C** | | Keys de mídia = mesmo padrão Providers |
| K13 | system | SystemSection + UpdateReadiness | **B** | | |
| K14 | vision | `VisionSection.tsx` | **B** | sim | Consent |
| K15 | audit | `AuditSection.tsx` | **B** | | Lista |
| K16 | remote | RemoteSection | **C** | | SSH; empty/CTA |
| K17 | marketplace | `MarketplaceSection.tsx` | **C** | | |
| K18 | design-systems | `DesignSystemsSection.tsx` | **C** | | |
| K19 | agents | AgentsSection | **C** | | Arsenal list |
| K20 | skills | SkillsSection | **C** | | |
| K21 | llms | LlmsSection | **C** | | Lista instalados |
| K22 | media-catalog | MediaCatalogSection | **C** | | |
| K23 | recipes | RecipesSection | **C** | | |
| K24 | plugins | PluginsSection | **C** | | |
| K25 | hooks | HooksSection | **C** | | |
| K26 | rules | RulesSection | **C** | | |

**Settings chrome:** `SettingsDrawer.tsx` + nav — **A/B** (brand + search + progressive disclosure).  
**Accounts manager:** `AccountsManager.tsx` — **C** (mesma família Providers).  
**Doctor engine:** `DoctorEngineSettings.tsx` — **B/C**.

---

## 6. Inventário fechado — Pet (janela desktop)

| ID | Superfície | Arquivo | Score | Notas |
| --- | --- | --- | --- | --- |
| P01 | Pet window app | `PetApp.tsx` | **A** | Sprite grande (200–260px) por design |
| P02 | Sheet / custom sprites | `SheetPetSprite`, `CustomPetSprite` | **A** | |
| P03 | Menu / balloons | `pet.css`, queue | **B** | Menu contexto; CTAs de balão ok |
| P04 | Settings pet (import) | `PetSection` | **A** | Pós-melhoria |

---

## 7. Primitivos de UI (sistema)

| Primitivo | Onde | Score | Problema |
| --- | --- | --- | --- |
| `settings-btn` | quase todo settings | **C** | Pequeno (padrão 12px / padding curto) |
| `settings-input` | settings-controls | **C** | padding 7×9 &lt; 44px |
| `settings-chip` | providers, etc. | **B** | Status ok |
| `settings-pet-import__btn` | pet | **A** | Novo padrão a reutilizar |
| `home-deck__btn` | home | **A** | |
| `workspace-bar__btn` | bar | **B** | |
| `PixelIcon` | parcial | **B** | Set limitado; nem toda nav usa |
| Empty `.arsenal-empty` | catalog | **D** | Só texto dashed |
| Empty `.orch-panel__empty` | orch | **D** | Sem CTA |
| Empty `.ops-board__empty` | ops | **B** | Melhor |
| Empty `.activity-rail__empty` | rail | **C** | CTA pequeno |
| Empty agent-picker | bar | **D** | Sem deep-link Providers |

---

## 8. Contagem

| Categoria | Qtd superfícies inventariadas |
| --- | ---: |
| Shell / workspace | 25 |
| Overlays | 14 |
| Voz | 4 |
| Settings seções (+pet sub) | 27 |
| Pet window | 4 |
| **Total** | **~74** |

Scores aproximados:

| Score | Qtd (aprox.) |
| --- | ---: |
| A | 12 |
| B | 28 |
| C | 24 |
| D | 6 |
| — (power-user denso) | 4+ |

---

## 9. Top 15 melhorias (ordenado por ROI cliente)

1. **Providers keys** — ActionCards (Salvar/Testar/Limpar)  
2. **Empty “Nenhuma CLI”** (agent picker) → botão grande “Abrir Providers”  
3. **Arsenal empties** (agents/skills/mcps/tools/…) → CTA + ícone  
4. **Orch panel empties** → “Lançar missão”  
5. **Mission rail empty** → CTA grande  
6. **Integrations panel** — tipografia e hit targets  
7. **Media keys** — mesmo padrão Providers  
8. **Voice settings** — 4 painéis (Captura / Wake / Live / TTS)  
9. **Accounts manager / switcher** — empty + actions  
10. **Nav: pixelIcons** em ranking, diagnostics, shortcuts, system, advanced  
11. **ActionButton primitivo** (unificar pet + home + settings)  
12. **settings-input** altura padrão 40–44px  
13. **Toasts** com ícone de severidade  
14. **Ops board** CTA “Nova missão” mais gordo no empty  
15. **Command palette empty** com 3 ações sugeridas  

---

## 10. O que NÃO forçar a “ficar grande”

- Terminal / PTY  
- Pane toolbar icon strip  
- Cost/operator telemetry densa  
- Canvas nodes para power users  
- Diff hunks  

Regra: **monitoramento denso OK; CTAs de produto grandes.**

---

## 11. Cobertura desta auditoria

| Item | Status |
| --- | --- |
| Todas as seções do settings-nav | **Sim** (listadas e scoreadas) |
| Todas as montagens de `App.tsx` | **Sim** |
| Janela pet | **Sim** |
| Cada linha de cada arquivo CSS | Não (score por superfície + contagem de padrões) |
| Server web UI fora do renderer | Fora de escopo se existir |
| QA visual pixel-perfect em runtime | Não (estático) |

Isto é o inventário **fechado do sistema de UI do app desktop**. Scores são de legibilidade/ação, não de bugs funcionais.

---

## 12. Implementação (2026-07-12)

Sprint A→D aplicados no código:

- `ActionCard` + `EmptyState` + `ui-actions.css` (padrão pet)
- Providers / Media keys com ActionCards
- Empties: agent-picker, arsenal, orch, mission rail, command palette, accounts
- Ops board CTA gordo; Integrations hit targets
- Nav com `pixelIcon` em todas as seções restantes
- Toasts com ícone de severidade
- Voice settings tabs com ícones
- `settings-input` / `settings-btn` min-height floor
