# Jev e Clef complementares Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Preservar Jev e adicionar Clef, com credenciais pela UI, seleção automática por tarefa, contabilidade correta e julgamento visual do navegador.

**Architecture:** Um serviço comum resolve a rota em código e chama um transporte específico. As superfícies existentes conservam suas políticas e fallback; os modelos fornecem somente decisões tipadas. A rota inicial identifica sua evidência como benchmark público ou configuração manual, até existir uma avaliação local que justifique sua promoção.

**Tech Stack:** Electron, Node 22, TypeScript, React, Zod, Vitest e fetch nativo, sem novo SDK de provedor.

**Spec:** `docs/analysis/2026-10-01-jev-clef-complementares.md`, apresentada ao operador e seguida pela instrução “siga”.

## Global Constraints

- Preservar Jev, suas credenciais, toggles, políticas de autoridade e logs históricos.
- Modos públicos: Automático, Somente Jev e Somente Clef; variantes Cloudflare: Clef e Clef Flash.
- Instalações existentes começam em Somente Jev. O modo automático com Cloudflare exige escolha do cliente.
- Guardar token somente no cofre do Main; nunca no renderer persistido, JSON de settings, fixture, log ou git.
- Status retorna somente presença e máscara. O Account ID não é segredo, mas pertence à configuração local do cliente.
- Clef: até 64 perguntas por chamada; IDs com letras, números, `_`, `.` e `-`, até 100 caracteres.
- Imagens Clef: máximo 4; PNG/JPEG/WebP; até 4 MiB e 16 megapixels por imagem, 8 MiB decodificados no conjunto e 13 MiB no body.
- Perguntas e state recebem a redação existente. Pixels precisam de redação própria antes do envio remoto.
- Sem resposta: fallback determinístico nas triagens; automação sem decisão válida devolve o controle sem produzir um efeito.
- A política inicial é hipótese fundamentada, não resultado medido no Nexus. Não promover uma rota por feedback isolado.
- UI em PT-BR, componentes existentes, tokens e motion do `DESIGN.md`; consultar `.devin/skills/landing-page-design/SKILL.md` antes das mudanças visuais.
- Mudanças de renderer/IPC exigem `npm run security:renderer-sinks`; toda alteração de source exige `npm run typecheck`.
- Antes de alterar `src/main/orch/`, ler as referências de segurança apontadas pelo AGENTS.md e executar o teste co-localizado.

## Review Focus

- Modo fixo não pode trocar silenciosamente de provedor nem enviar imagens ao Jev.
- Abort, deadline ou mudança de configuração durante um lote não podem iniciar outro lote/fallback ou aplicar uma resposta obsoleta.
- Uma consulta de 104 perguntas deve preservar todos os IDs e respostas; nenhuma pergunta pode desaparecer na divisão do lote.
- Redação de strings não protege screenshots: campos sensíveis precisam ser removidos dos pixels antes da saída.
- Totais, cache e histórico devem separar provedores, variantes, tentativas e reutilizações, sem reaplicar a tarifa Jev a chamadas Clef.

## Interfaces e arquivos

Criar o domínio `src/main/decision-models/` para seleção, transporte Cloudflare,
schemas de resposta e credenciais. Manter os imports públicos do cliente Jev
como fachada de compatibilidade; separar redaction/tipos do transporte para
evitar ciclos de módulos.

Contratos compartilhados novos vivem em `src/shared/decision-models.ts` e
`src/shared/decision-model-channels.ts`. O preload expõe somente operações de
configuração, presença e teste pelo novo namespace `window.nexus.decisionModels`.
Não expor leitura da credencial nem acesso genérico ao cofre.

```ts
type DecisionMode = 'auto' | 'jev' | 'clef';
type DecisionProvider = 'jev' | 'clef';
type ClefModel = 'clef' | 'clef-flash';
type DecisionSettings = {
  mode: DecisionMode;
  clefModel: ClefModel;
  cloudflareAccountId: string;
  visionEnabled: boolean;
};
type DecisionRoute = {
  provider: DecisionProvider;
  model: string;
  policyVersion: 'jev-clef-v1';
  evidence: 'public-benchmark' | 'legacy' | 'manual' | 'capability';
  reason: string;
};
type DecisionImage = {
  content_type: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
};
```

`JudgeInput` conserva os campos atuais e ganha `images?: readonly DecisionImage[]`.
O resultado conserva `model`, `answers` e `usage`, com `route`, `durationMs`,
`requestCount` e `estimatedUsd` opcionais para compatibilidade com fixtures antigas.

## Task 1 — Contratos, credenciais e IPC Cloudflare

**Files:**
- Create: `src/shared/decision-models.ts`, `src/shared/decision-models.test.ts`, `src/shared/decision-model-channels.ts`.
- Create: `src/main/decision-models/clef-secrets.ts`, `.test.ts`, `decision-model-ipc.ts`, `.test.ts`.
- Modify: `src/shared/settings-types.ts`, `src/shared/types.ts`, `src/main/main.ts`, `src/preload/preload.ts`, `src/preload/preload.test.ts`, `src/preload/functional-smoke.ts`.
- Modify: `src/main/persistence/secrets-portability.ts` and `.test.ts`.

**Interfaces:**
- Produces: `decisionSettingsSchema`, `getClefApiToken()`, `hasClefCredential()`, `setClefApiToken(token: string)` and `registerDecisionModelIpc()`.
- Produces: `window.nexus.decisionModels.status()` and `.setKey({ token })`; settings change through the existing validated `settings.orchSet` path. Task 2 adds `.test({ model? })` with its actual transport.
- Status returns credential presence/mask, account readiness, mode, variant, vision setting and the policy rows; never a token value.
- Secret namespace: exactly `clef-env:CLOUDFLARE_API_TOKEN`. Environment fallback: `CLOUDFLARE_API_TOKEN`; account fallback: `CLOUDFLARE_ACCOUNT_ID`.
- `orch.decisionModels` defaults to `{ mode: 'jev', clefModel: 'clef', cloudflareAccountId: '', visionEnabled: false }`. Accept a blank account ID or 32 hexadecimal characters.

- [ ] **Step 1: Write failing contract and vault tests.** Assert old settings produce the defaults, invalid modes/account IDs are rejected, empty token clears only the Clef key, stored token wins over env, missing account is reported as not ready, and status never returns the raw token.
- [ ] **Step 2: Run RED.** `npx vitest run src/shared/decision-models.test.ts src/main/decision-models/clef-secrets.test.ts src/main/decision-models/decision-model-ipc.test.ts`.
- [ ] **Step 3: Implement the named interfaces.** Register trusted configuration IPC, add the typed preload surface, reuse `secrets-store` and extend portability for the exact Clef key without accepting internal namespaces.
- [ ] **Step 4: Test export/import.** A Clef token round-trips through an encrypted bundle; a bundle containing `auth:` still rejects atomically. Run `npx vitest run src/main/persistence/secrets-portability.test.ts src/preload/preload.test.ts` and the RED command.
- [ ] **Step 5: Verify and commit with explicit file paths.** `npm run typecheck`; `npm run security:renderer-sinks`; conventional commit `feat: add secure Clef configuration`.

## Task 2 — Transporte Clef e validação do contrato

**Files:**
- Create: `src/main/decision-models/clef-client.ts`, `.test.ts`, `decision-response.ts`, `.test.ts`.
- Create: `src/main/decision-models/decision-pricing.ts`, `.test.ts`.
- Modify: `src/main/jev/jev-client.ts`, `.test.ts` to share pure types/redaction without changing native Jev behavior.
- Modify: Task 1's `decision-model-ipc.ts`, test, shared channels/types and preload to add the working `.test({ model? })` operation.

**Interfaces:**
- Consumes: Task 1 credential and account settings.
- Produces: `judgeClef(input: JudgeInput, config: ClefConnection, deps?: ClefDeps): Promise<JevResult | null>`.
- Produces: `validateDecisionResponse(data: unknown, questions: Record<string, JevQuestion>): JevResult | null` and `decisionResultCostUsd(result: JevResult): number`.
- Produces: `testClefConnection(model?: ClefModel): Promise<JevTestResult>` with one small fixed, synthetic typed question. Register it in configuration IPC after the real transport exists.
- Cloudflare endpoint is fixed HTTPS: `/client/v4/accounts/{accountId}/ai/run/@cf/cloudflare/{model}`. Reject redirects.
- Prices per input token: Jev `0.042 / 1e6`, Flash `0.09 / 1e6`, Clef `0.24 / 1e6`.

- [ ] **Step 1: Write RED cases.** Test valid `result` envelope, `success:false` on HTTP 200, malformed/incomplete answers, invalid option or NaN, missing usage, structured instructions, embedded images, and rejection of remote image URLs.
- [ ] **Step 2: Test oversized batches.** Give 104 questions with IDs containing colons/spaces/Unicode. Assert two HTTP requests, at most 64 questions each, reversible IDs and all original answers returned. A failed second request returns null for the logical query.
- [ ] **Step 3: Run RED.** `npx vitest run src/main/decision-models/clef-client.test.ts src/main/decision-models/decision-response.test.ts src/main/decision-models/decision-pricing.test.ts`.
- [ ] **Step 4: Implement transport and validation.** Use a stable index-based ID map. Preserve structured instructions and criteria. Normalize the envelope; validate question type, complete answers, valid choices, probability intervals/distribution, finite confidence/scores and nonnegative integer usage.
- [ ] **Step 5: Pin lifecycle/error behavior.** One total deadline includes batching, bounded retries and backoff. Abort stops immediately and never retries. Errors are categorical and redacted; 401/403 do not retry. Test 429, 5xx, timeout and abort before/between requests.
- [ ] **Step 6: Verify native compatibility and commit.** Run the RED command plus `npx vitest run src/main/jev/jev-client.test.ts`; `npm run typecheck`; commit `feat: add Clef typed decision transport` with explicit paths.

## Task 3 — Roteamento complementar e consumidores existentes

**Files:**
- Create: `src/main/decision-models/decision-routing.ts`, `.test.ts`, `decision-judge.ts`, `.test.ts`.
- Modify: `src/main/jev/jev-client.ts`, `.test.ts` to delegate through the common service while retaining the public import.
- Modify consumers under `src/main/jev/`, `src/main/orch/jev-*.ts`, `src/main/orch/intent-router-jev.ts`, `src/main/orch/idle-helper-reuse.ts`, `src/main/orch/tools-{judge,rank,tool-pick,browser-autopilot,computer-autopilot}.ts`.
- Modify: `src/main/browser/browser-{manager,extract,find-jev}.ts`, `src/main/context/business-model/business-model-selection.ts`, `src/main/regression-gate/business-risk.ts` and corresponding focused tests.

**Interfaces:**
- Produces: `resolveDecisionRoute(input: Pick<JudgeInput, 'surface' | 'model' | 'images'>, settings: DecisionSettings, availability: DecisionAvailability): DecisionRoute | null`.
- Produces: `hasDecisionCredential(surface?: JevDecisionSurface): boolean` and the compatible `judge(input, deps)`.
- In auto: image requests use Clef; `toolPick` uses Clef as the public-benchmark hypothesis; other text surfaces initially keep Jev unless the evaluation task establishes and records another winner. Intake is evaluated explicitly before promotion because its Nexus questions include risk/complexity, not only intent classification.
- In fixed modes: never switch providers. Explicit model selectors must match the selected provider; agent arguments do not change user settings.
- Auto may use the other configured text provider when the preferred credential is absent, logging `credential-fallback`. No fallback after revocation/abort and no fallback from visual to text-only.

- [ ] **Step 1: Write RED route table tests.** Cover every current surface, manual modes, no key, only one configured provider, Jev plus Clef, Flash variant, vision disabled, incompatible explicit model and images in Jev-only mode.
- [ ] **Step 2: Write lifecycle tests.** Settings/credential changes during a pending query invalidate the result. A guard retains its existing deny/confirm/exemption thresholds and remains independent of the provider's route confidence.
- [ ] **Step 3: Run RED.** `npx vitest run src/main/decision-models/decision-routing.test.ts src/main/decision-models/decision-judge.test.ts`.
- [ ] **Step 4: Implement the common service.** Select in code, call one provider, retain abort and fallback contracts. Update credential availability and error text in callers; do not rename all Jev files or redefine `hasJevCredential` to mean Cloudflare.
- [ ] **Step 5: Verify existing integration.** Run co-located tests for every consumer changed, including business-model selection, guard, browser find and both autopilot tools. Run `npm run typecheck` and `npm run security:renderer-sinks`.
- [ ] **Step 6: Commit exact paths.** `feat: route Nexus decisions between Jev and Clef`.

## Task 4 — Histórico, custos e cache por provedor

**Files:**
- Modify: `src/main/jev/jev-decision-log.ts`, `.test.ts`, `jev-response-cache.ts`, `.test.ts`, `src/shared/jev-ipc.ts`.
- Modify: all touched cost-recording consumers identified in Task 3.
- Modify: `src/main/browser/browser-manager.ts` and focused browser judgment/cache tests.

**Interfaces:**
- Decision entries gain optional `provider`, `route`, `durationMs` and `requestCount`; old entries remain readable as Jev.
- New aggregates group by provider/model and retain the existing time-window/surface totals.
- Cache identity includes provider, model, policy version, configuration revision, state/questions and image hash, in addition to existing navigation/owner fences.

- [ ] **Step 1: Write RED regression tests.** Mixed old Jev and new Clef/Flash rows retain historical costs; image hashes and provider switches miss cache; identical valid queries coalesce; failures never enter cache.
- [ ] **Step 2: Test billing evidence.** Reuse increases avoided-request evidence only, not tokens/USD. A two-batch response sums actual reported usage and records one logical decision with two requests. Raw state, images and tokens never appear in JSONL.
- [ ] **Step 3: Run RED.** `npx vitest run src/main/jev/jev-decision-log.test.ts src/main/jev/jev-response-cache.test.ts` plus focused browser cache tests.
- [ ] **Step 4: Implement metadata/cost helpers.** Replace fixed Jev cost multiplication on routed calls with the result's model-aware cost. Preserve native Jev stats and provide common aggregates to the generalized UI.
- [ ] **Step 5: Verify and commit.** Run focused tests and `npm run typecheck`; commit `feat: track decision usage by provider and model` with explicit paths.

## Task 5 — Interface de configuração e escolha

**Files:**
- Create: `src/renderer/components/settings/DecisionModelsSection.tsx`, `.test.tsx`.
- Modify: `ApiKeysSection.tsx`, `.test.tsx`, `ModuleSections.tsx`, its focused test, `JevDecisionsSection.tsx`, `.test.tsx`, `SettingsWorkspace.tsx`.
- Modify only the existing settings stylesheet owning the reused component classes if needed; locate that owner with `rg` before editing.

**Interfaces:**
- Consumes Tasks 1, 3 and 4 through typed preload/settings APIs.
- Copy: “Modelos de decisão”, “Automático”, “Somente Jev”, “Somente Clef”, “Account ID”, “API Token”, “Salvar token”, “Testar conexão”, “Remover token”.
- Vision label: “Analisar imagens com Clef”; help text states that captures are sent to Cloudflare. Default off.
- Display policy source as “Regra inicial” or “Avaliado no Nexus”; do not imply benchmarking was executed.

- [ ] **Step 1: Write RED UI tests.** Old mocks without the new bridge still render. Saving a token uses only the Clef IPC. Empty account, rejected save and failed connection show inline errors. Mode/variant/vision changes persist through settings.
- [ ] **Step 2: Test privacy and behavior.** Token is masked, cannot be read back, is cleared from transient input after confirmed save, and no key is stored in localStorage. Jev's key survives Clef removal. Pending operations prevent duplicate submissions.
- [ ] **Step 3: Run RED.** `npx vitest run src/renderer/components/settings/DecisionModelsSection.test.tsx src/renderer/components/settings/ApiKeysSection.test.tsx src/renderer/components/settings/JevDecisionsSection.test.tsx`.
- [ ] **Step 4: Implement within existing settings hierarchy.** Put provider selection and routes next to orchestration; expose the Cloudflare credential card in API keys; generalize the history's title and provider/model labels. Reuse tokens and semantic controls with loading/error/empty/focus states.
- [ ] **Step 5: Verify real rendering.** Start the dev app with a synthetic vault/session and inspect settings save/test/mode flows. Do not reset the operator's real auth or replace the installed app to run UI checks.
- [ ] **Step 6: Verify and commit.** Focused tests, `npm run typecheck`, `npm run security:renderer-sinks`; commit `feat: configure complementary decision models in settings`.

## Task 6 — Avaliação local e promoção das rotas

**Files:**
- Create: `src/main/decision-models/decision-evaluation.ts`, `.test.ts`.
- Create: `scripts/evaluate-decision-models.mjs`, `.test.ts` and redacted fixtures under `scripts/fixtures/decision-models/`.
- Modify: `decision-routing.ts` and test only when measured evidence justifies a route change.

**Interfaces:**
- Produces: `evaluateDecisionCases(cases: readonly DecisionEvalCase[], judgeProvider: EvalJudge): Promise<DecisionEvalReport>`.
- Cases include ID, surface, split (`development` or `heldout`), input/questions and expected behavior. Report includes accuracy/errors, abstentions, p50/p95, usage and model-specific cost; missing/unavailable responses remain failures, not zero-cost successes.
- CLI reads credentials from secure runtime or env, never arguments. Reports exclude raw state/token/image bytes and write to an explicit unversioned output path.
- No live parallel comparison is auto-enabled in the product. The initial labeled suite covers intent, tool selection, tool timing, research relevance, pane states, handoff evidence and guards; include Portuguese and negative/out-of-catalog cases.

- [ ] **Step 1: Write RED evaluation tests.** Given predetermined outputs, verify actual accuracy and error classes, heldout separation, percentile calculation, cost, provider-unavailable status and removal of secret/fixture content from the report.
- [ ] **Step 2: Run RED.** `npx vitest run src/main/decision-models/decision-evaluation.test.ts scripts/evaluate-decision-models.test.ts`.
- [ ] **Step 3: Implement evaluator and fixtures.** Include behavioral assertions beyond the answer label; guard decisions cannot authorize effects and visual-only cases are marked unsupported for Jev instead of claimed comparative wins.
- [ ] **Step 4: Run live eval only after secure configuration works.** Measure all eligible candidates on identical labeled inputs. If a key or service is unavailable, record the gap and retain the initial route. Do not print credentials or full provider error bodies.
- [ ] **Step 5: Review route promotion.** Promote only when heldout behavior improves without a higher consequential error rate; ties prefer the cheaper model within the observed latency target. Guard remains Jev unless its own safety cases pass.
- [ ] **Step 6: Verify and commit.** Focused tests and typecheck; commit `test: evaluate complementary decision model routes`. Keep live reports unversioned unless explicitly selected after review.

## Task 7 — Visão do navegador com proteção de pixels

**Files:**
- Create: `src/main/browser/browser-visual-judgment.ts`, `.test.ts`, `browser-capture-redaction.ts`, `.test.ts`.
- Create: `src/main/orch/tools-browser-visual.ts`, `.test.ts`.
- Modify: `src/main/browser/browser-manager.ts`, `src/preload/browser-automation.ts` and test, `src/shared/browser-automation.ts`, `src/main/orch/tools-domain.ts`.

**Interfaces:**
- Produces: `judgeBrowserVisual(input: { paneId: string; goal: string; scope: ProjectExecutionScope; signal?: AbortSignal }, deps?: BrowserVisualDeps): Promise<BrowserVisualJudgment>`.
- Exposes a read-only `nexus_browser_judge_visual` tool with paneId and goal, using the caller's existing pane authority. It does not accept arbitrary filesystem paths, URLs or credential values as images.
- Results include typed signals for visible error, goal achieved, loading, human blocker and layout problem, plus route metadata. They do not execute a click or grant permissions.
- Collect sensitive-field rectangles through the existing browser preload; mask opaque pixels in a copied image buffer in Main before creating the embedded PNG. Validate viewport scaling, image limits and navigation freshness. If masking cannot be verified, return unavailable without sending pixels.

- [ ] **Step 1: Write RED pixel and authority tests.** Password/token/credential fields are opaque in the sent bytes; non-sensitive pixels remain; Retina/viewport scaling and overlapping rectangles work; invalid rectangles fail closed. Cross-workspace panes, disabled vision, missing Clef and Jev-only mode perform no remote call.
- [ ] **Step 2: Write snapshot lifecycle tests.** Navigation, pane disposal, consent/config change or abort between collecting rectangles, capturing and judging stops egress or discards the result. The original local screenshot/artifact is not modified.
- [ ] **Step 3: Run RED.** `npx vitest run src/main/browser/browser-visual-judgment.test.ts src/main/browser/browser-capture-redaction.test.ts src/main/orch/tools-browser-visual.test.ts src/preload/browser-automation.test.ts`.
- [ ] **Step 4: Implement the constrained path.** Reuse scope/capture infrastructure, apply pixel masking and limits, send embedded bytes through Task 2 and register the read-only tool. Honor existing URL, session and mission ownership rules.
- [ ] **Step 5: Verify an actual browser pane.** Use a local synthetic page with password/token fields, loading, success and layout error states. Inspect the redacted image artifact and request body; live visual inference follows the client's explicit vision setting.
- [ ] **Step 6: Verify and commit.** Focused tests, renderer sinks, typecheck and `mcp-dispatch-security.test.ts`; commit `feat: add scoped Clef visual browser judgments`.

## Task 8 — Validação final e cadastro da credencial criada

**Files:**
- Modify: `docs/SECURITY.md`, `docs/analysis/2026-10-01-jev-clef-complementares.md` and appropriate co-located regression tests where an integration gap is found.

- [ ] **Step 1: Verify the final changed-file list.** Run `git diff --check`, `npm run typecheck`, `npm run security:renderer-sinks` and the affected suites. Include secure portability, lifecycle, MCP authority and legacy Jev cases.
- [ ] **Step 2: Perform a fresh review of the full change.** Follow the selected execution workflow's review requirements; fix HIGH/CRITICAL issues before delivery and rerun only checks justified by the fixes.
- [ ] **Step 3: Register the created token through the new trusted settings flow.** The operator already authorized the Cloudflare token creation and local vault storage. Populate Account ID and token without exposing them in logs or source. Verify presence in the cofre, successful Clef inference and Jev preservation.
- [ ] **Step 4: Handle the installed-app access blocker honestly.** Current Google and GitHub login endpoints both return “Este login ainda não está disponível”. Do not alter licensing/auth secrets or bypass the access gate to reach settings. Resolve access through the supported login path, or report that local code is ready while real-app credential registration remains blocked.
- [ ] **Step 5: Verify persistence and mode behavior.** Reopen settings; token remains masked, account and mode survive, provider switch changes the actual endpoint, visual remains off until chosen, and a service failure preserves the relevant fallback/stop behavior.
- [ ] **Step 6: Update documentation with actual evidence.** Separate stub/contract tests from live inference measurements. State which routes were promoted and which remain initial. Deployment, release packaging, native modules and desktop pixel egress are outside this first delivery unless explicitly added.

## Execution handoff

Recommended method: native implementation in this session. Most tasks share the
same contract and caller boundary, so executing sequentially avoids conflicting
edits. Complete a fresh review after the full implementation.

The plan is ready for review. Implementation starts after the operator reviews
this written plan and confirms the execution method, as required by the loaded
`superpowers:writing-plans` workflow.
