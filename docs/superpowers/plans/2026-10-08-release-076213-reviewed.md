# NexusIDE 0.76.213 reviewed release implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Execute tasks in order, with one implementer at a time and a task review after each change.

**Goal:** Publish the next macOS ARM64 release with the production-ready improvements from the reviewed PRs, preserving current 0.76.212 behavior and fixing regressions in included changes.

**Architecture:** Start from upstream/main eab826a5d in an external .noindex worktree. Preserve ready product changes and, under the user’s later explicit instruction, merge the full immutable PR126 ancestry after independent review and repairs. Keep existing Main authority, account failover and packaged smoke implementations when they supersede older PR implementations. Source foundations are not advertised as connected product features without actual callers and operational proof.

**Tech Stack:** Electron, TypeScript, React, better-sqlite3; Node 22.23.2; repository-pinned npm 12.0.0; existing Developer ID/notarization pipeline.

**Spec:** User request to release the improvements already ready, previous PR review and docs/RELEASE-CHECKLIST.md. Included product scope: launcher shortcuts/accessibility, paged handoff listing, Luna decisions with per-account settings and conservative ensemble, live mission board. Existing main account/failover, capture and smoke fixes remain canonical after a read-only comparison.

## Global constraints

- Work only in /Users/cleofaspereirarocha/.nexus-worktrees/release-076213-reviewed.noindex on codex/release-0.76.213-reviewed.
- Preserve the user's coordination checkout and uncommitted files. No worktrees under the repository root.
- Read AGENTS.md and applicable security ownership documents before changes under src/main/orch or src/main/runtime.
- Every affected source gets its co-located test; typecheck and renderer-sinks run for renderer/IPC changes.
- One heavy validation/build command at a time. Never rebuild shared coordination node_modules.
- Never re-enable SSL.com eSigner/CKA/Windows signing. Site and cloud-api are independent projects, and this app release does not deploy them.
- No automatic GPT-6 Astra selection. Implementers do not spawn further agents.
- Release source, local annotated tag, package/server/lock/CURRENT_RELEASE/CHANGELOG, built artifacts and receipts must agree. No force push, tag replacement, manual publication bypass, or weakened gate.
- User authorized a new release and necessary integration/publication. Do not request approval again for the same authorized action. Platform question is optional; use current macOS ARM64 channel if unanswered.
- Describe actual production consumers and proof: substrate, definitions-only helpers and platform plans are not a delivered product feature. The user later explicitly authorized merging the entire updated PR126; its safe foundations are included after review, but claims stay factual.

## Task 1 — Ready T3 launcher and pagination

Files: src/shared/cursor-pagination.ts and test, src/main/orch/tools-handoff.ts, src/main/orch/handoff-store.ts and tests, src/renderer/components/product/Launcher.tsx and test, src/renderer/lib/action-names.ts and test, src/renderer/styles/app-shell.css; docs/qa/items/F-1049.md.

Interfaces: preserve list's array return when limit/cursor absent; cursor mode returns {items,nextCursor,hasMoreHistory}. Extend acknowledgeSeenByOrchestratorList(missionId, seenIds?) without breaking legacy callers.

- [x] Integrate only PR126 commits 802251949 and a4c0a021a, resolving context against current main; exclude their ancestors' unused ORC changes.
- [x] Add the failing pagination test from docs/qa/evidence/2026-10-08-pr-review-mimo-t3/pagination-ack.patch to the co-located handler test. Prove invalid cursor does not ACK; page ACK affects only returned ids. Add store coverage for scoped id selection and existing full-list compatibility.
- [x] Select/validate the page before ACK, and ACK only returned ids; use parameterized SQL, validated ids and bounded chunks if necessary. Preserve own-mission/current-leader authority and submitted-only update.
- [x] Add rendered keyboard verification for launcher action callbacks and editable-input suppression; preserve canonical design tokens and current UI copy.
- [x] Run focused cursor/launcher/handler/store tests, typecheck and renderer-sinks with Node22. Update F-1049 with evidence only after passing; commit explicit pathspecs.

## Task 2 — Luna and conservative ensemble

Files: PR124's 43 changed files, especially src/main/decision-models/decision-ensemble.ts and test, src/main/orch/jev-handoff-review.ts consumer; docs/qa/items/F-1047.md.

Interfaces: preserve per-account decision settings, explicit opt-in Luna/Juntos, no credential fallback, refusal semantics, vision consent/redaction and paid-call accounting.

- [x] Integrate PR124 head f88205509 against current release branch, preserving main's subsequent changes.
- [x] Add the failing reproduction from ensemble-evidence.patch with the actual handoffBounceSignals consumer.
- [x] Remove changed_code from LOWER_IS_RESTRICTIVE so the maximum preserves the requirement for verification. Cover all providers and three-member combinations; do not change other calibrated directions.
- [x] Run focused decision and handoff review tests, typecheck and renderer-sinks. Update F-1047 and commit explicit paths.

## Task 3 — Live board on current main

Files: PR125's 8 changed files, particularly src/main/orch/mission-engine-production.ts, MissionGraph.tsx, mission-board.css and co-located tests; docs/qa/items/F-1051.md.

Interfaces: roster includes only physically live mission members from the coordination checkout; idle Maestro remains live, closed workers/history are not reanimated. Preserve main's inspector/zoom sizing tokens and existing scope boundaries.

- [x] Integrate PR125 head 1ff1a026e on the updated release branch.
- [x] Reproduce the failing literal assertion at MissionBoard.layout.test.ts:113 against current main's calc(--mission-inspector-toggle-width ...).
- [x] Adjust the test and any overlapping CSS to the canonical spacing contract, without reverting main's newer inspector sizing. Perform one focused DOM/browser layout verification with inspector open/closed at normal and narrow widths, recording effective spacing and absence of overlap; preserve current tokens.
- [x] Run snapshot/graph/layout focused tests, typecheck and renderer-sinks; update F-1051 and commit explicit paths.

## Task 4A — current account selection and measured cross-window confirmation

Read-only comparison proved explicit accountId is dropped by the mission picker/IPC/preload/Main despite main already sealing the physical account. Adapt only missing transport/pin checks from 4693c47cc; retain F-1002 physical identity+effort, F-995 compare-and-swap/recovery, F-249 no-data same-pane/capped retry, F-645/F-646 native credential ownership. Do not import old colliding F-954/955/956 docs or broad rebind implementation.

Files: PanePicker.tsx/test, preload.ts/shared/types.ts, orch-ipc.ts/test, renderer-mission-authority.ts/adoption test; limit-refutation.ts/test and failover tests. Add fresh QA records after checking free IDs.

- [x] Reproduce account-pin loss and cross-kind exhausted window behavior.
- [x] Transport explicit accountId through validated contracts and existing accountPin mechanism; prove requested account matches physical spawned account before sealing/returning.
- [x] Add cross-window confirmation only for fresh provider-api account windows with measured exhaustion (usedRatio >= 1), usage-kind unscoped hits. Keep existing matching-kind 0.8 policy intact; 0.79/0.80/0.99 in opposite-kind windows do not prove exhaustion. No stale/local/unknown/tier confirmation. Preserve switched only after actual recovery and active-account/headroom rules.
- [x] Run focused picker/authority/failover/limit tests, typecheck, sinks; independent task review and explicit-path commits.

## Task 4B — explicit Shot target without regressing current capture flow

Main already stages/batches capture paths without Enter. Adapt only missing explicit target/query from PR106 938ba4249, preserving F-613 batching/staging and scope/parked guards.

Files: shot-bridge-server.ts/test, shared/shot-bridge.ts, main.ts callback wiring, shot-ingest.ts/test; terminal-host.ts/test only if needed. Add fresh QA record.

- [x] Reproduce authenticated targets query/current target omission; prove explicit target selects intended live pane.
- [x] Add bounded token-protected GET /shot/targets and optional validated targetPaneId. Explicit dead/foreign/parked target must refuse, never fall back to a different pane.
- [x] Revalidate workspace/target after async staging; preserve quoted trailing-space/no-Enter delivery, recording batch prioritization and known-folder guards.
- [x] Run focused bridge/ingest/host tests, typecheck, sinks; actual local HTTP roundtrip and independent review before committing.

## Task 4 — Whole candidate verification and version

- [x] Read-only scout compares PR123/122/106 to main and records superseded or missing ready behavior; include a missing fix only after focused reproduction and review.
- [ ] A fresh reviewer examines the whole integration diff for correctness/security, scopes, account isolation and feature readiness. Address important findings.
- [ ] Run full app tests, server typecheck/tests, renderer sinks and the mission E2E, sequentially. If an unrelated test fails, reproduce on baseline; do not call it a product regression without attribution and do not bypass release gates.
- [x] Choose a still-unused monotonic version at release time (planned 0.76.213). Update package/server/lock/CURRENT_RELEASE/CHANGELOG with accurate ready feature notes.
- [ ] Commit clean source, revalidate authority, create local annotated tag at exact HEAD, check no other release is running and valid Developer ID/notary profile.

## Task 5 — Build, gate and publish

- [ ] Follow build/notarize.md and docs/RELEASE.md with Node22.23.2 and pinned npm. Prepare with release:mac --no-publish; build and candidate gates precede additional packaged acceptance and publication.
- [ ] Require security audits/SBOMs, signed/notarized/stapled DMG/ZIP, real packaged smoke, graceful process exit and final receipt. Fix a concrete failure without disabling checks.
- [ ] After candidate and extra acceptance pass, release:mac --from candidate includes the only publication transaction through release:publish:macos. Verify remote bytes/digests/tag/version and report links, actual platforms and remaining limits. Do not call a second publisher.
- [ ] Maintain an evidence ledger mapping every docs/RELEASE-CHECKLIST.md requirement to an automated/manual check or an explicit remaining limit. Do not infer UI/voice/update or soak coverage from an unrelated smoke.
- [ ] Verify adapted T3 file coverage in third_party/provenance/t3code-26285ab.json and THIRD_PARTY_NOTICES.md, preserving attribution.

## Rulings and execution ledger

- The initial selected-only PR126 scope was superseded by the user’s explicit whole-PR merge instruction. Safe foundations are included after review; readiness claims remain limited to connected product behavior and tested operations.
- GitHub Actions was previously budget-blocked. macOS uses the existing local launchd release pipeline; no dependence on unavailable hosted jobs.
- Bundled SDD workspace/review-package scripts are absent. Use the documented manual git diff package fallback and the plan-owned ignored ledger .superpowers/sdd/release-076213-reviewed/progress.md.

## Completed integration evidence before source freeze

All scoped implementations and independent reviews passed: Task1 at6d4e42455,
Task2 ate02f75598 (including F1055–1058 conservative decisions, usage receipts and
recipient-specific consent), Task3 atc5f3395e7 (F1059 live membership fallback),
Task4A at84cdc152d (F1052 account selection, F1053 measured cross-window exhaustion),
Task4B atcc81b7eef (F1054 explicit capture target). Final source regression, whole
review, signing, packaged acceptance and publication remain pending; these scoped
results alone do not declare the release ready.

The user chose macOS first; Windows/Linux wait for available runners and their
independent gates. Canonical/public latest verified v0.76.212 before choosing213.
Final regression uses a fully owned npm12 install in the isolated release worktree;
coordination dependencies were not rebuilt. Public notes list only connected
features and disclose beta/live-provider test limits.

## Task 6 — User-expanded entire PR126 integration and safe monitor (09/10)

The user explicitly requested merging the other session's entire updated PR126
before release, collecting additional incoming corrections, fixing all defects
found, then publishing safely. The user confirmed the sending batch finished;
normal ancestry through `64a8d16a2d57dbc934b6b07c27719ebd7726a6b5` is already included. A fresh remote check detected later correction `8e46134d5177440f24e828c67723320c1d50e230`; its review, integration and repairs must finish before source freeze. This supersedes the earlier selected-only PR126 exclusion.
The user also requested a persistent incoming-source monitor and invoked
/GOAL: stop only after public release and senior operational review.

- [x] Re-check all open PRs; latest source is PR126; demais PRs do inventário anterior sem novo conteúdo neste lote.
- [x] Independently review immutable7dc/7f/4ef/c747 deltas; retain observed RED
  renderer sinks and actual consumer failures; no remote CI code coverage was
  available because Actions budget prevented jobs starting.
- [x] Preserve normal merge ancestry of ece/4ef and existing release/Main guards,
  including batched/deduped page ACK, consent, cost receipts, quota/CAS/pins,
  live board and explicit Shot target.
- [x] Merge ece/4ef/c747/64a normal ancestry and repair real resume outcomes/authority, safe Mermaid/obsolete editor, Tiptap newline/controlled lifecycle, scoped CDP factory and failed attach cleanup, cross-manager transaction identity, audit caption and canonical Tiptap style/contrast findings.
- [x] Independently review and integrate later8e correction without reverting local repairs or version213. Repair newly exposed transport authorization/command confinement/navigation lifetime and lossless path/markdown behavior; scoped approvals and proof limits are preserved below.
- [x] Review adapted/reference code against pinned raw T3 sources and update
  applicable headers, provenance hashes/notices. Final sourcewriter snapshot2ee2
  records149entries/124unique paths with valid JSON and matching current hashes;
  original upstream pins/history remain intact.
- [ ] Senior independent review of the FINAL combined source, with no known
  relevant integration defect left. Run full regression, focused consumers and
  real Main/PTY mission E2E anew; old61014 test results are baseline evidence only.
- [ ] Actual compiled/browser UI evidence for safe Mermaid/Tiptap and new decision
  modes; actual signed packaged runtime/soak/gates before one guarded publication.
- [x] Configure/verify independent local monitor of new PR heads AND main commits,
  own .noindex worktree per batch, no active-coordinator/worker/build overlap,
  exact private/public publication proof, auditable dispositions, ownership locks,
  bounded retries and quiet operator inbox. Existing tool automation_update was
  absent; self-Codex UI access refused. Use documented public CLI/launchd, without
  private app APIs, raw automation directives or weaker permissions.

The monitor is operational configuration outside the app checkout in
`~/.nexus-monitors/incoming-review-watch`. It is an independent writer domain;
its small Node policy tests may run while the single app writer works. It cannot
launch a model or source/build worker while the current coordinator is active.
The app's heavy-validation lane remains one at a time.

Fresh owned pinned npm12 install of final Tiptap/Mermaid dependencies found a
KaTeX trust-bypass advisory (GHSA-238p-pmpm-9mq7). Patched KaTeX0.18.2 was
verified/nondeprecated and pinned by override; DOMPurify3.4.16 promoted to an
exact runtime dependency for safe DOM fragments. Fresh npm audit reports zero
vulnerabilities. No forced package update or weakened sink gate was used.

## Latest incoming correction review (09/10)

The live monitor and fresh GitHub query both observed PR126 head8e46134d.
The incremental review found concrete authorization and page-session command
confinement defects in its newly reachable preview CDP transport, plus loss
of Windows path backslashes in the markdown parser. These are release blockers,
not waived findings. Source and candidate gates remain pending their repair.
The independently reviewed local monitor is loaded in launchd at a10-minute
interval, performing read-only ticks under an active coordinator; it cannot
start a model/build writer until the verified publication handoff.

The incremental raw-CDP transport cannot generically enforce existing sensitive-field redaction and visual consent while forwarding arbitrary Runtime JavaScript. The coordinator therefore rules fail closed for that newly exposed production transport, preserving its merge ancestry but disabling the HTTP/WebSocket registration. Existing governed browser tools and ordinary static preview remain the supported operations. Internal relay defects and text persistence are still repaired; public notes do not promise an exposed CDP endpoint or full T3 parity. A future raw-execution capability needs a separate trust contract rather than inferred release approval.

## Pre-freeze frontier refresh (09/10, f8)

The8e integration repairs are independently approved through80433ad02 and
legal-only refresh01ee04cc6. Actual231focused tests, TSC0, unchanged sinks0
and provenance/hash checks are recorded in task8e-report.md. Root metadata
co-located tests and release-authority checks pass7tests/version213/Node22/npm12.
No source freeze/tag/build/publication has occurred.

A fresh remote query before freeze detected PR126 head
`f8f871a92bc9b2c886c0f927f315384aae0249b5`, comprising0b784/f8f after8e.
Its blanket command producer is now a real product caller, so fresh senior
review found blockers in caller/RPC identity, plaintext result persistence,
false physical/checkpoint settlement, concurrent retry budget/audit, and
receipt lifecycle. Its ticket transport also reopens the rejected rawCDP
surface. These findings are not waived; sourcewriter is investigating a
minimal truthful producer repair before merging this immutable delta.
The existing CDP closure and all prior guards remain mandatory.

The monitor configuration is armed and verified at600seconds under the active
coordinator. Explicit first-publication handoff is still pending; it cannot
launch a second writer during this integration or candidate validation.

## Final repaired source handoff and metadata (09/10)

The included PR126 frontier is immutable
`ad517bfb633313af9b34cd9ab69c4ae946d14222`, preserved through normal ancestry
and locally repaired. Sourcewriter handed back clean
`2ee2cad832bc890a49ed9bfc46df4a45fa4c9004`, no owned process/service/source/index
writer active. Its fresh23files/494focused tests, TSC0/sinks0/diff0 and legal
149records/124paths are scoped evidence, not the final combined release gate.

Independent scoped closeouts now cover F1080–84/88 at the repairedf8 frontier,
F1089 cursor-session binding, F1090 sticky shutdown admission, F1091 private
Main PTY channel/session identity and lifetime, F1092 bounded production
retention, F1094 local failure isolation with global cancellation preserved,
and F1093 owned bootstrap/first-wave ordering at
`fead91eeafb6cd6017df6bfa81482ce64d59082e`. These close known source findings;
full app/server/Main-PTY, whole-source approval, signed candidate/runtime/soak,
visual inspection and publication are still pending.

Production scope is now logical safe dispatch receipts with actual durable event
sequence, plus instrumented terminal_run/bg_run owned-tree physical obligations.
Logical ACK never certifies physical exit; unknown work blocks completion, no
raw output cache or automatic uncertain-mutation replay. Maintenance is bounded
per scope/pass (500 eligible settled effect rows,100 guarded generated receipts),
keeps explicit/unknown bindings and stops on global cancellation/registry loss.
First-wave work follows confirmed setup/kickoff and failed bootstrap CAS only
terminalizes its captured owned attempt; the operator/newer leader remain safe.
Raw CDP stays closed; Tiptap/Mermaid/history/resource/WSL remain accurately
scoped foundations rather than announced connected product parity.

Fresh all39openPR/main/private/public inventory at10:19UTC found main still
protected at eab826a5, latest private/publicv0.76.212 and plannedv0.76.213 absent
locally and remotely. PR126 has a later38321a81 head. Under Root's
incoming-lot-policy.json, later feature additions are queued for the already
requested monitor's next batch; Root inspects later material bugs in this
candidate before publication. The binary will claim only its reviewed selected
frontier and repairs, never unbuilt incoming commits. No tag/source freeze yet.

The final executor now owns metadata/index and the single heavy lane. Source
checks run against the exact clean metadata commit with immutable SHA/tree
checks. Tag/build await both independent whole-source approval and all combined
checks. Public macOS publication remains one guarded transaction after all
candidate, additional signed5minute soak/runtime and actual PNG inspection.
The monitor stays coordinator.active=true until Root's verified-public/no-owned-
writer closeout. No Windows/Linux artifact, paid Luna call, real microphone,
installed upgrade or full T3 parity proof is inferred.

## Sucessora 0.76.214 da candidata privada 213 (09/10)

A fonte 5a2df06d1 e seus gates de app, servidor e Main/PTY receberam aprovação
global. A tag local anotada v0.76.213 (objeto 0813eb33...) permanece imutável.
Sua build ARM64 assinada, notarizada e stapled e o gate base passaram; o soak
adicional falhou antes da primeira amostra. Nenhuma 213 foi publicada.
Artefatos, recibos, manifests originais e o RED extra estão preservados por
cópia de snapshot FD + SHA-256 em histórico privado ignorado; não são a
candidata publicável 214.

O diagnóstico nativo controlado com bootstrap real demonstrou 0/3 execuções
do comando de 1.899 bytes enviado imediatamente e 3/3 do equivalente de 153
bytes, com os mesmos 97 LF, marcador ausente do comando digitado e janela de
5.000 ms inalterada. Isso fundamenta o reparo compacto, mas não substitui a
prova no novo pacote assinado. F-1099 (f4c94a0ab) e F-1100 (9dcfcbbcc)
receberam aprovação independente de fonte; os gates completos e a aceitação
assinada da 214 permanecem pendentes. Não aumentar o prazo, diminuir a política
de memória, fabricar amostras ou retagar 213.

A candidata sucessora usa versão nova 214 em root, server, lock,
CURRENT_RELEASE e CHANGELOG, no mesmo checkout, branch e scratch autorizados.
A fronteira incluída é ad517bfb e os reparos locais. Novas funcionalidades
posteriores continuam na próxima batch já autorizada do monitor; as triagens
383, f649 e c8f3 não estabeleceram bug material nesta fronteira. Fonte,
metadados, revisão global, todos os gates e nova tag devem concordar no SHA
214. A descrição da release pública 212 continua intacta; ela permanece a
versão pública até publicação guardada e verificação de bytes e digests.


## Sucessora 0.76.215 da candidata privada 214 (09/10)

A fonte ca8270ed5, árvore 460978939, recebeu revisão global e oito gates
completos verdes: app 24.683/60 skips, servidor157 e Main/PTY 1. A tag local
v0.76.214 (objeto c6620ede...) permanece imutável. A candidata assinada e
notarizada passou no gate base e no soak fixo de cinco minutos (43 amostras),
mas a etapa adicional de runtime falhou ao observar o líder da missão.
Resume e inspeção de PNG não foram concluídos; nenhuma 214 foi publicada.
O histórico privado preserva artefatos, recibos e RED por snapshot FD/SHA-256.

O reparo distingue autenticação nativa de credenciais de API/transporte e
corrige a coordenação das observações de runtime para agentes em worktrees.
A identidade de escopo, prioridade da sessão nativa, isolamento, permissões
e limites continuam obrigatórios. A sucessora usa 215 nos sete paths
acoplados; root checkout, branch e scratch não mudam. Fonte final, revisão
independente, todos os gates, nova tag/build/sign/notary, soak/runtime/PNG e
publicação permanecem pendentes até evidência real. Não reutilizar o pacote
214 como 215, retagar 214 ou apagar falhas. A versão pública 212 e sua descrição
continuam intactas; a fronteira incluída permanece ad517bfb + reparos locais.


## Sucessora 0.76.216 da candidata privada 215 (09/10)

A fonte 6d7022978, árvore e51552a7, recebeu revisão global e oito gates
verdes: app 24.708/60 skips, servidor 157 e Main/PTY 1. A tag local 215
868f16ef permanece imutável. Build assinada/notarizada, candidata base e
soak fixo de cinco minutos (43 amostras) passaram. Runtime avançou ao líder,
mas falhou na execução OPS sem workers: a orientação enfileirada não teve
aceitação comprovada. Resume/PNG/publicação não foram concluídos.

Duas observações do mesmo ZIP 215, sem alterar comportamento do gateway,
permissões ou prazos, registraram somente GET /runtime-hello 200 e zero pedidos
de modelo. Root CUA capturou a instância privada PID 9799/perfil TXYBOS exibindo
a confirmação da chave de API sintética, com No(recommended) selecionado.
Nenhuma aprovação ou entrada de CLI foi enviada. A imagem existe INLINE
ONLY na conversa Root; não inventar arquivo PNG ou aprovação visual.
Artefatos, recibos, provas e REDs estão em histórico privado por FD/SHA-256.

A sucessora 216 corrige somente consentimento da credencial sintética no
perfil de teste privado, usando o mecanismo normal de chave aprovada, e o
resultado honesto de orientação enfileirada não comprovada, sem replay.
Não confirmar chaves, trust ou permissões globalmente; não aumentar timeout,
fabricar busy/aceitação nem tocar credenciais do operador. Revalidar a
redação contra implementação e revisão final antes de aplicar metadados.

Sete paths acoplados terão 216 após handoff exclusivo. Fonte limpa, revisão
independente, oito gates, nova tag/build/sign/notary e soak/runtime/resume/PNG
continuam pendentes até prova real; publicação é uma única transação guardada.
A pública 212, archives 213/214/215 e cutoff ad517 mais reparos são preservados.
Sem novas dependências, features, deploy de site/API, outra plataforma ou
claims de upgrade, full T3, microfone real e provedor pago.


## Sucessora 0.76.217 da candidata privada 216 (09/10)

Fonte 07f986283, árvore e2040daba, aprovada globalmente com oito gates
verdes: app 24.756/60 skips, servidor 157 e Main/PTY 1. Tag 216 4dac1640
permanece imutável. Build/notary/base/Node restore e soak fixo de cinco
minutos (42 amostras) passaram. Runtime executou OPS e nexus_clarify reais,
mas falhou no verificador da pergunta registrada; resume/PNG/publicação
não foram concluídos. A versão pública conhecida permanece 212.

O ledger privado reteve a pergunta RT_QUESTION, enquanto a missão estava
running/executing. MissionEngine normaliza a view openQuestion para o campo
canônico snapshot.question; as leituras privadas desse campo estão corretas.
A pergunta aparece após o fluxo normal: chamada real da CLI ao status enum
blocked, com nota válida, que mapeia executing para intent blocked_user.
O reparo adiciona somente essa transição da própria missão, usando o ID do
resultado real de clarify e a allowlist declarada da fixture; não renomeia
campos nem altera o contrato canônico. Não simular
pergunta, status, aceitação ou busy, alterar o produto clarify, permissões,
prazos ou respostas do gateway para encobrir o contrato.

217 é apenas a candidata sucessora planejada: revalidar disponibilidade
remota/local e estes sete metadados após handoff limpo e revisão. Fonte,
oito gates e revisão global, nova tag/build/sign/notary, soak/runtime/resume/
PNG e publicação guardada permanecem pendentes até evidência real. Nenhuma
feature ou dependência nova; sem site/API deploy, outra plataforma ou claims
de upgrade/full T3/provedor pago/microfone real. Archives 213–216 e suas
falhas, pública 212 e cutoff ad517 mais reparos são preservados.
