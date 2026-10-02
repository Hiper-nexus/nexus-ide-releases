# Security

## Contract

Fail-closed for permissions, MCP, filesystem, secrets, agents, and side effects.
All external input validated with Zod at process boundaries.

## Ownership

| Surface | Module |
|---------|--------|
| MCP effects | `mcp-effect-policy.ts`, `mcp-dispatch.ts` |
| PTY env / ownership | `pty-manager.ts` |
| Workspace paths | `renderer-workspace-scope.ts`, `workspace-path` |
| Audit + redaction | `jarvis/audit-log.ts`, `command-redaction.ts` |
| Autonomy | `autonomy/autonomy-profiles.ts` |
| Browser | `browser/url-policy.ts` |
| Egress Clef (Cloudflare Workers AI): texto | `decision-models/*` — `decision-routing.ts` (rota em código; superfícies com efeito fixas no Jev), `decision-judge.ts` (nunca troca de provedor depois da chamada), `clef-client.ts` (endpoint HTTPS fixo, sem redirect, lotes ≤ 64, limites de corpo/resposta), `decision-redaction.ts`, `decision-response.ts`, `clef-secrets.ts` + `decision-model-ipc.ts` (token só no cofre; variáveis de ambiente próprias `NEXUS_CLEF_API_TOKEN` / `NEXUS_CLEF_ACCOUNT_ID`) |
| Egress Clef (Cloudflare): imagens mascaradas do navegador | `browser/browser-visual-judgment.ts`, `browser/browser-capture-redaction.ts`, `browser/browser-visual-inspection.ts`, `browser/browser-visual-refusal.ts`, `preload/browser-visual-redaction.ts`, `preload/browser-visual-mask-rules.ts`, `orch/tools-browser-visual.ts`, `decision-models/decision-images.ts` — só com a visão ligada pelo operador; nunca em aba com perfil pessoal |
| Egress Jev (TypeSafe) | `jev/jev-client.ts` (redactState, fail-open), `orch/jev-handoff-review.ts`, `orch/tools-judge.ts`, `orch/tools-browser-autopilot.ts`, `orch/tools-computer-autopilot.ts`, `vision/desktop-control.ts`, `orch/jev-dispatch-guard.ts`, `orch/tools-tool-pick.ts`, `orch/jev-task-routing.ts`, `orch/hook-triage-endpoint.ts`, `orch/tools-handoff-workspace.ts`, `browser/browser-manager.ts` + `browser/browser-extract.ts` (julgamento de página e estado de extração redigidos e limitados; Jev só escolhe entre candidatos reais) |
| Egress Reporte de problema | Reporte de problema: título/descrição/passos digitados + diagnóstico opt-in redigido → `api.nexuside.app` (`POST /v1/bug-reports`), por ação explícita do usuário. `bug-report/bug-report-ipc.ts` (`handleTrusted` + schema estrito; payload inválido é recusado), `bug-report/bug-report-service.ts` (prévia fiel: o envio usa o corpo exato que a prévia mostrou e recusa se o corpo mudou — digest sha-256; no máximo 10 tentativas por 10 min; timeout curto, `redirect: 'error'`, resposta validada, erros em pt-BR, nada em log), `bug-report/bug-report-diagnostics.ts` (lista de permissão: só `kind`, código curto e instante dos últimos eventos do trace, agente/modelo ativo, nº de panes e se há missão — nunca argumentos, caminhos, prompts, saída de terminal nem ambiente; só com `consent.diagnostics`, desligado por padrão), `bug-report/bug-report-redaction.ts` (chaves/JWT/Bearer, e-mails, HOME). A sessão fica no Main (`api-client.ts`) e nunca chega ao renderer. |

## Error flow

Decision routing lives in `decision-models/decision-judge.ts`: fixed modes never
silently change provider; visual inputs require explicit opt-in and Clef.
Cloudflare credentials use only `clef-env:CLOUDFLARE_API_TOKEN` in Main's
encrypted vault (a vault label, not an environment variable). The environment
fallback is `NEXUS_CLEF_API_TOKEN` / `NEXUS_CLEF_ACCOUNT_ID`; the wrangler
variables `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` are never adopted,
because that token usually has account-wide scope. Trusted settings IPC returns
presence/mask (3 + 4 characters, the same pattern as the Jev key), never the
token. The Account ID is local configuration. Rotation/import and settings
changes invalidate in-flight decisions and cache authority. Cloudflare requests
target the fixed Workers AI HTTPS endpoint, reject redirects and validate every
answer (Clef: strict probability sums and mandatory `usage`; Jev keeps its
production tolerance, measured against the real API).

What can leave the machine for Cloudflare, by mode:

- **Somente Jev:** nothing. `visionEnabled` is forced off in this mode, so
  returning to Automatic never resurrects an old image consent.
- **Automatic / Somente Clef (text):** the redacted state of pane screens,
  terminal output, requests and tool candidates (`paneState`, `terminalTriage`,
  `intake`, `taskRouting`, `delegation`, `toolPick`, `rank`, `researchTriage`,
  `helperReuse`, `businessModel`, `judgeTool`, `rankTool`; `businessModel` carries
  up to 12 KB of the changed code from the regression gate, redacted for known
  secret formats only). Automatic prefers Jev
  for everything except `toolPick`; it only falls back to Cloudflare when no Jev
  key exists, and the settings screen says so (`credential-fallback`).
- **Never Clef (pinned to Jev):** `dispatchGuard`, `handoffReview`,
  `memoryDistill`, `computerTool`, `browserTool` (text). Their thresholds are
  calibrated for Jev and have no Clef evaluation. Without a Jev key they have no
  route and fail open (guard `skipped`), including in Somente Clef. The agent
  cannot choose the route either: `nexus_judge` rejects `model=clef`.
- **Images:** only `nexus_browser_judge_visual`, with the operator's explicit
  opt-in (a fresh confirmation each time it is switched on).

`nexus_browser_judge_visual` is scoped, read-only and rate limited. Panes bound
to the operator's personal browser profile (real logins) are refused before any
capture; only isolated panes can be judged. Its isolated preload supplies
geometry only; Main makes an opaque pixel copy for editable fields, recognized
secrets (including labels whose value sits in a neighbouring node: the whole
row/list/ancestor block is hidden), frames, canvas and any media larger than an
icon. Rectangles are merged with a sweep line (a hostile page cannot stall the
main thread); a capture that would be almost entirely masked, or whose
image/mask scale is not verifiable, is refused. Navigation, scope, geometry,
configuration changes and cancellation reject stale captures/results. Invalid
masks or provider image limits stop egress. Closed shadow trees or an unavailable
local inspector also stop egress before any capture is exported. The inspector
never borrows a pre-existing session. Captures remain in memory; original local
artifacts are unchanged. **Masking is partial:** it does not guarantee removal of
all personal information on a page (names, e-mails, numbers and CSS background
images can remain), and the UI says so. Signals never authorize clicks or
permissions. Desktop screenshot egress is not enabled by this feature.

- Jev dispatch guard: `deny` only on injection ≥ 0.8; otherwise at most human
  confirmation (destructive + incoherent); service failure = pass-through
  (never blocks). The operator's own hand (`role user`, no mission) is never
  judged; operator-spawned helpers (`operatorParentSessionId`) are judged for
  injection only (deny ≥ 0.8, never a modal) with the spawn brief as objective.

- Invalid schema → reject, no side effects.
- Path escape → throw / deny.
- Audit write failure → policy-defined block for effectful tools (`effectMayHaveCommitted` when handler already ran).
- Unknown MCP tool → never executes.

## Cofre: autoridade interna e credenciais portáveis (N1 / F-414)

`src/main/persistence/secrets-store.ts` é o dono de `isReservedSecretName`:
os prefixos `auth:`, `system:`, `agentkey:` e `browser:` são internos. As APIs
genéricas de escrita/exclusão recusam esses nomes com `reserved_secret_name`
antes de acessar o cofre. Só os donos no Main usam `setInternalSecret` /
`deleteInternalSecret`; nunca encaminhar nomes escolhidos pelo renderer/MCP
a essas entradas.

`providers.setKey` usa o schema de id dos adapters e exige registro no catálogo
no Main; key vazia segue a mesma validação antes de excluir. A portabilidade
aceita ids registrados e os namespaces de credenciais `voice-env:`, `jev-env:`,
`acctkey:`, `acctcred:`, `mediakey:`, `mcphub:` e o nome exato
`clef-env:CLOUDFLARE_API_TOKEN`. Export não lê registros internos;
import valida todos os nomes antes da primeira escrita e recusa o bundle inteiro
se contiver autoridade interna ou nomes desconhecidos. Bundles antigos contendo
sessão/licença devem ser reexportados como credenciais de providers.

Evidência: `secrets-store.test.ts` reproduz JWT pro/trial anterior à suspensão,
MAC calculado pelo atacante, import/setKey e reinício; o acesso continua bloqueado.
`secrets-portability.test.ts` cobre rejeição sem escrita parcial e round-trip;
`provider-config-spawn.test.ts` cobre o handler IPC; `provider-settings-types.test.ts`
cobre a validação compartilhada.

## Limits

- Max redaction depth/size (audit-log constants).
- Command history max length / denylist.
- Editor max ~1.5 MB.
- Mission event payload ≤ 64 KiB.

## Migration / rollback

Additive SQLite migrations only. Feature flags kill-switch new paths.

## Metrics

Secrets redacted count; denied path escapes; MCP denials.

## How to test

```bash
npx vitest run src/main/orch/mcp-dispatch-security.test.ts \
  src/main/terminal/command-redaction.test.ts \
  src/main/persistence/renderer-workspace-scope.test.ts \
  src/main/autonomy/autonomy-profiles.test.ts
```


## Authorized worker capabilities (2026-10-02)

Autopilot workers may use native subagents and browser/desktop tools when the
existing tool policy permits them. Claude/OpenClaude Task restrictions are
computed at spawn for governed or read-only panes, rather than attached to every
adapter invocation. Native subprocesses inherit their pane's existing authority;
this change does not grant cross-workspace access or a global MCP profile.

Browser ownership is derived in Main from an exact project scope and a live PTY
or ACP session. ACP proof includes its Main-owned runtime binding, account,
provider, incarnation and coordination/execution scopes. A headless caller needs
a unique live mission coordinator; stale, ambiguous or substituted bindings fail
closed. Workers can use existing tabs in that authorized window. Personal-profile
image export still requires its existing isolation/consent rules. The desktop
loop retains macOS availability, Accessibility permission, per-goal confirmation,
focus checks, sensitive-field refusal and irreversible-action handback.

Regression evidence lives in native-subagent-policy, worker-handoff-contract,
pane-authz, pane-registry-browser-owner, gate-browser-access, tools-browser-workspace
and tools-computer-autopilot tests. Browser keyboard tests cover event.code,
optional bounded hold duration, cancellation and document replacement. Hosted
Xvfb smoke uses an isolated temporary fixture and an explicit test-only sandbox
opt-in; production packaging never installs a no-sandbox launcher.

## Donos externos do reporte de problemas

O endpoint de produção `api.nexuside.app/v1/bug-reports` pertence ao Worker
`nexus-cloud-api` (repositório separado): `src/bugs/routes.ts`, `schemas.ts`,
`build-report.ts` e `store.ts`. Ele exige a sessão nativa, limita o corpo a
64 KB e aplica cota atômica por conta. O `server/` Express deste monorepo
não é o dono desse endpoint. O site/admin é do repositório `nexus-site`.
A revisão final confirmou os contratos locais e o GET protegido `/mine`
retornou 401 sem credencial; isso não constitui envio de relato nem teste
de administração em produção. Nenhuma dessas árvores externas foi alterada.
