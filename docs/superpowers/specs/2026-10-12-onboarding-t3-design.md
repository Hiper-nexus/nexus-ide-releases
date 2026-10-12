# Onboarding Nexus (padrão T3) — Design

**Status:** aprovado pelo operador (2026-10-12)  
**Inspirado em:** `pingdotgg/t3code` @ 26285ab (MIT) — padrão de stepper Connect → Agents → Projects.  
**Não copia UI React do T3.** Visual e copy seguem o `DESIGN.md` do Nexus.

## Problema

Clientes novos não sabem por onde começar: onde colocar chaves, como ditar com
Space, o que é o + Pane e quais são as formas de iniciar. O Launcher atual só
tem um guia estático de três linhas.

## Objetivo

1. **Wizard first-run** (modal) em 4 etapas que ensina o produto de verdade.
2. **Checklist residual de ativação** no Launcher, marcado por fatos.
3. **Guia «Como usar»** denso (Space, + Pane, chaves, formas de iniciar).

## Decisões do operador

| Questão | Escolha |
|---|---|
| Quando abre | First-run modal + checklist residual |
| Etapas | Conectar/chaves → Agentes prontos → Projeto → Como usar |
| Profundidade | Wizard + checklist de ativação (sem micro-tour na missão) |

## Arquitetura

```
App.tsx
  └─ OverlayLayer
       └─ FirstRunWizard          (modal duro, z-hard-modal)
Launcher.tsx
  ├─ ActivationChecklist          (auto-marcação + atalhos)
  └─ HowToUseGuide                (Space · + Pane · chaves · iniciar)
onboarding-store.ts               (localStorage nexus.onboarding.v5)
shared/onboarding-state-types.ts  (checklist de ativação Nexus)
```

- Dados de agentes: `useProviderStore` + `providerStateChips` / `providerRowCta`
  (nada de status mockado).
- Ações de navegação: `useProductNavigationStore`
  (`openSettings('api-keys' | 'providers')`, workspace, mission, pane picker).
- Estado persistido em `localStorage` (`nexus.onboarding.v5`), no mesmo molde de
  `progressive-launch.ts`. `OnboardingState` em `persisted-state-types` é
  atualizado para o mesmo shape (ponte futura para settings do Main).

## Wizard — 4 etapas

| # | id | Título | Conteúdo | CTA |
|---|---|---|---|---|
| 1 | `keys` | Colocar suas chaves | Caminho exato **Ajustes → Chaves de API** (colar chave) *ou* **Providers → Entrar**. Lista de providers com CTA real. | Continuar |
| 2 | `agents` | Agentes prontos | Cards com status real (`Pronto` / `Falta login` / `Instalar`). Ação «Conectar outra conta» → Providers. | Continuar |
| 3 | `project` | Seu primeiro projeto | Abrir pasta existente · novo workspace · «Agora não». | Continuar |
| 4 | `use` | Como usar o Nexus | **Space (segurar) = ditar** · **+ Pane** · **Formas de iniciar** (5 caminhos com botão). | Começar |

- Stepper: `1 Chaves → 2 Agentes → 3 Projeto → 4 Usar` (`aria-current="step"`).
- **Pular sempre permitido** («Pular» + Esc). Nunca prende o app.
- Abre sozinho quando `closedAt === null && lastCompletedStep < 1` e o
  `flowVersion` do store for o atual (5). Upgrade de flow antigo com
  `closedAt` preenchido **não** reabre o wizard.

## Checklist residual de ativação

| chave | Rótulo | Marca quando | Atalho |
|---|---|---|---|
| `connectedAccount` | Conecte uma IA ou chave | conta viva ou `hasKey` em algum provider | Chaves de API |
| `openedProject` | Abra um projeto | workspace atual existe | Escolher pasta |
| `dictatedWithSpace` | Dite com Space | primeiro hold-to-talk (ou marcar manual) | Explicar |
| `openedPlusPane` | Abra um + Pane | pane picker aberto (ou marcar manual) | Abrir + Pane |
| `createdMission` | Crie a primeira missão | missão criada | Criar com IA |

- Auto-marcação por derivados (providers/workspace) + flags de uso quando
  houver gancho barato; itens de uso têm marcar manual como fallback.
- Some quando todos `true` ou `dismissed === true` («Entendi, não mostrar de novo»).

## Guia «Como usar»

Quatro blocos, copy do produto (`shortcuts.ts` / `Launcher`):

1. **Ditar com Space** — «Segure Space e fale; solte para transcrever no
   terminal selecionado.» ⌘⇧Space fala com a assistente. Toque curto é espaço.
2. **+ Pane** — «Abra outro painel de IA ou terminal pela grade.»
3. **Onde ficam as chaves** — Ajustes → Chaves de API / Providers.
4. **Formas de começar** — Criar com IA · Montar meus terminais · Abrir projeto ·
   Terminal sem IA · + Pane (cada um com o que serve).

## Visual (DESIGN.md)

- Dark-first Pink City; CTA primário `--btn-primary` (branco); acento só em
  foco/seleção/estado vivo.
- Cards `--surface-2` + `--border`; status `--state-ready` / `--state-blocked` /
  `--state-failed` com glifo + palavra.
- Modal em `overlay-layer` (portal), foco inicial no CTA seguro, Tab preso,
  Esc = pular/fechar.
- A11y: nome acessível, `aria-current` no stepper, contraste AA.

## Telemetria

- `OnboardingChecklistState` ganha as 5 chaves Nexus; enum
  `onboardingChecklistItemSchema` acompanha (compile-time sync guard).
- Eventos existentes (`onboarding_step_*`, `activation_checklist_item_completed`)
  continuam; step 1–4 do wizard novo.

## Testes / gates

- `FirstRunWizard.test.tsx`, `ActivationChecklist.test.tsx`,
  `onboarding-store.test.ts` (co-locados).
- `npx tsc --noEmit`, `npm run security:renderer-sinks`, vitest focado.

## Fora de escopo

Tour micro-contextual na missão, i18n EN, mobile, persistência via Main
settings (localStorage basta nesta entrega).

## Atribuição

Padrão de UX inspirado no onboarding do T3 Code (MIT). Se no futuro copiarmos
código de UI deles, cabeçalho `Adapted from pingdotgg/t3code @ <commit>` +
entrada em `third_party/provenance/t3code-26285ab.json`.
