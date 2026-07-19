# Code review senior — findings (corrigidos)

Data: 2026-07-18  
Escopo: F2–F4, operator loop, Kimi, route/quota, plan lane, bg tasks.

| Sev | Achado | Correção |
|-----|--------|----------|
| **High** | Plan lane: `memory_retain` em allowlist mas caía no gate bootstrap e era negado | Allow explícito pós-planAllowed |
| **Med** | `file_write` plan: catch engolia miss do store e podia abrir write | Fail-closed só quando `isPlanLane` |
| **Med** | DiffAnnotate: `setState` após fechar o painel (async MCP) | `cancelled` flag no effect |
| **Med** | `route_task` mutava `decision.reason` in-place | Cópia imutável `{ ...decision, reason }` |
| **Med** | Quota auto-exclude (uncommitted) sem fail-safe claro no reason | Fail-safe + note; ship com review |
| **Low** | `bgTasks` Map sem prune (leak em main longo) | Cap 64 + TTL 10 min |
| **Low** | Allowlist plan com tools já read-only (ruído) | Lista só effects reais |
| **Low** | Contrato `hasAvailableAccount` sem teste | Teste de decisão + ompAvailable |
| **Info** | Kimi headless com `-y` baked-in | Intencional (eval/non-interactive); documentado |
| **Info** | Sticky omp sem conta Nexus → available | Intencional (auth third-party) |

Não reaberto: Phoenix, Wire Kimi, ACP host, harness rewrite.
