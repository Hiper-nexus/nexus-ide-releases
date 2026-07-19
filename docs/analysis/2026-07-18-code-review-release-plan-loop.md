# Code review senior — plan loop (pré-release)

Data: 2026-07-18  
Escopo: plan toast, promote flow, metrics, orch-bridge side effects.

| Sev | Achado | Correção |
|-----|--------|----------|
| **High** | Rehydrate de handoffs (prev=[]) re-toastava todos os plan handoffs | `detectNewPlanHandoffs` ignora seed prev vazio |
| **High** | Métricas/toasts recontavam após reload | `seenPlanMissionIds` / `seenPlanHandoffIds` em localStorage |
| **Med** | Double-click toast/rail promovia em paralelo | Guard `promoting` Set por missionId |
| **Med** | `ensureOrchestrator` reportava reopened sem inject | Só `reopened` se inject ok |
| **Med** | Toast TTL timer após dismiss manual | `clearTimeout` no dismiss |
| **Low** | Double-click no botão do toast | disable imediato no click |
| **Low** | Toast de promote após lane já standard | Check lane no onClick do toast |

## Passada 2 (pré-release)

| Sev | Achado | Correção |
|-----|--------|----------|
| **High** | `prev=[]` engolia o **primeiro** handoff real da sessão | Seed no bridge (`handoffsPrimed` + `seedSeenHandoffIds`); detect volta a permitir first delivery |
| **Med** | Lock de promote só após confirm — race toast+rail | Lock **antes** do confirm |
| **Med** | Promote com snapshot stale após dialog | Re-ler missão do orch-store após confirm |
| **Low** | `bg-task-events` channel string solta | `ORCH_CHANNELS.bgTaskEvent` |
| **Low** | `plan_write` aceitava vazio / path sujo | min 20 chars + reject `..` / absolute |

Release-ready para smoke plan → handoff → Executar plano → PREVC.
