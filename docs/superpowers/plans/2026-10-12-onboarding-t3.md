# Onboarding Nexus (padrão T3) — Implementation Plan

> **Spec:** [2026-10-12-onboarding-t3-design.md](../specs/2026-10-12-onboarding-t3-design.md)

**Goal:** First-run wizard de 4 etapas (chaves → agentes → projeto → como usar) + checklist residual de ativação no início, ensinando Space, + Pane, chaves e formas de iniciar.

**Status:** implementado (2026-10-12). 13 testes verdes nos módulos novos; `security:renderer-sinks` 0 sinks; `npm run typecheck` completo sem erros nos arquivos do onboarding (7 erros pré-existentes em outros módulos: `alibaba-token-plan-usage.test`, `ContextWindowChip`, `reveal-pane-terminal`, `update-everything.logic.test`).

## Correções de senior (passe 2)

- **Nunca marcar ativação por clique de navegação.** Abrir Mission Setup ≠ criar missão; `pick()` cancelado ≠ abrir projeto. Só `syncDerivedFlags` (conta/chave, workspace, missões) e os hooks reais.
- **`+Pane` só em `requestOpen`** (todo origem: grid, CTA, App). “Montar meus terminais” não conta como +Pane.
- **Space/ditado marca em `onDictationStart`** (Space hold-to-talk e botão de microfone) — não em “Como funciona”.

## Deliverables

| Item | Path |
|---|---|
| Tipos de ativação | `src/shared/onboarding-state-types.ts` |
| Defaults / flow v5 | `src/shared/constants.ts` (`ONBOARDING_FLOW_VERSION=5`, `ONBOARDING_FINAL_STEP=4`) |
| Enum telemetria em sync | `src/shared/telemetry-onboarding-foundation-schemas.ts` |
| Store + localStorage | `src/renderer/state/onboarding-store.ts` |
| Wizard modal | `src/renderer/components/onboarding/FirstRunWizard.tsx` |
| Checklist residual | `src/renderer/components/onboarding/ActivationChecklist.tsx` |
| Guia Como usar | `src/renderer/components/onboarding/HowToUseGuide.tsx` |
| Bloco no início (Expresso) | `src/renderer/components/onboarding/FirstStepsGuide.tsx` → `ExpressMissionStart.tsx` |
| Mount do wizard | `src/renderer/App.tsx` (`OverlayLayer`) |
| Tokens visuais | `src/renderer/styles/onboarding.css` |

## Follow-ups (não bloqueiam)

- Smoke visual do modal no app empacotado.
- Opcional: marcar `connectedAccount` também por `authState === 'ok'` de provider sem `hasKey` (hoje: `hasKey` ou conta registrada).
