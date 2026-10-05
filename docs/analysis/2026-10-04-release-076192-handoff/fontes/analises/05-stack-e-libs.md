# handoff-1dd5595e-5fa4-425f-ae56-d88fee7b85b1 (MiMo Code (Xiaomi))

# Relatório — Decisão de stack no Nexus IDE (missao: melhoria robusta)

Papel: helper SOMENTE LEITURA (oc-scout lido em `assets/skills/oc-scout/SKILL.md:1-21`; nenhum arquivo editado, nenhum git mutante). Data de referência: 03/10/2026.

---

## 1. Resumo executivo

**Verificado:** o Nexus **não tem um decididor de stack**. Ele tem (a) uma *carta* genérica que diz ao worker para respeitar a linguagem existente e usar libs "boring, maintained, CURRENT" (`src/main/orch/engineering-charter.ts:19-21`), (b) um briefing greenfield que **recusa** escolher stack (`src/main/runtime/guided-greenfield-brief.ts:56-57`), (c) um *detector* que só **lê** o que já existe (`src/main/orch/stack-detector.ts:16-37`), e (d) um sensor `dependency-audit` que roda `npm audit` (segurança, não frescor — `src/main/context/mechanical-sensors.ts:178,324,381`). **Não existe**: dependabot, renovate, `npm outdated`, checador de pacote descontinuado, nem invariante versionada sobre tecnologia/bibliotecas (`.context/nexus/invariants/` só cobre `package.name` e scripts; lacuna reconhecida em `docs/PLANO-DEV-SENIOR.md:61-63`).

**Recomendação:** política de decisão com entradas fixas (SO, desempenho, distribuição, mantenedor, ecossistema, segurança) + regra "consulta o registro na hora da decisão, recusa descontinuado, fixa versão", entregue primeiro como **skill empacotada `stack-advisor`** (menor passo útil, reaproveita `scripts/bundle-skills.mjs` + `skill-mirror.ts`), e depois como trecho da `ENGINEERING_CHARTER`. **Não** como nova especialidade no Jev — o vocabulário `ROUTE_SPECIALTIES` é por natureza de trabalho, não por linguagem (`src/shared/mission-route-specialty.ts:29-37`).

---

## 2. O que existe hoje (arquivo:linha — ✓ = verificado por leitura direta)

| Onde | Cite | O que faz |
|---|---|---|
| Carta de engenharia (única regra de stack) | ✓ `src/main/orch/engineering-charter.ts:19-21` | "Respect the project's existing language... never default to Node/React out of habit. Prefer boring, maintained, **CURRENT** libraries. Check what is already installed before adding anything; follow the project's own version-pinning style." |
| Injeção da carta no worker | ✓ `src/main/orch/worker-handoff-contract.ts:186-188` (`orch.seniorMode && tier.engineering`), tier em `:61` `charterTierForWorker`; usado em `tool-util.ts:1495` | Scout/architect/readOnly ficam sem carta |
| Teste da carta | ✓ `src/main/orch/tool-util-charter-tier.test.ts:31` | mocka `ENGINEERING_CHARTER` |
| Greenfield não escolhe stack | ✓ `src/main/runtime/guided-greenfield-brief.ts:56-57` — "records only the approved intent... **it does not select a stack**" | decisão fica com o operador/modelo, fora do sistema |
| Detector de stack (só leitura) | ✓ `src/main/orch/stack-detector.ts:16-37` | `package.json`, `pyproject.toml`/`requirements.txt` → python (`:33`), `go.mod` → go (`:36`), `Cargo.toml` → rust (`:37`) |
| Roteamento por especialidade | ✓ `src/shared/mission-route-specialty.ts:29-37` `ROUTE_SPECIALTIES = ['visual','security','bug','feature','doc','ops','general']`; prompt em `src/main/orch/jev-task-routing.ts:105-117` | vocabulário por *natureza do trabalho*, não por linguagem — não há `'rust'`/`'go'`/`'web'` |
| Recomendação de catálogo por área | `src/main/orch/catalog-recommend.ts:175-219` (áreas python/go/rust/java/php/ruby/docker/k8s/terraform por arquivos) + `src/main/orch/catalog-overlay.ts:207-213` `effectiveStacks`/`proposeRecipes` | sugere receitas, nunca instala (F-757, `AGENTS.md:1224-1236`) |
| Sensor de dependências | ✓ `src/main/context/mechanical-sensors.ts:178` ("Dependency audit"), `:324` `npm audit --omit=dev --json`, `:381` "Atualize ou substitua…"; testes `mechanical-sensors.test.ts:102-190` | **segurança** (CVE), não frescor/descontinuidade |
| CI audit | ✓ `.github/workflows/linux-preview.yml:120` `npm audit --audit-level=moderate`; teste `scripts/linux-preview-workflow.test.mjs:25` | único gate de deps no CI |
| Dependabot / Renovate / `npm outdated` | ✓ **não encontrado** — `.github/` só tem `workflows/` (sem `dependabot.yml`); `renovate` só como regex de autor de PR em `src/shared/pr-comment-audience.ts:12-13`; nenhum script `outdated`/`npm-check-updates` em `package.json` | lacuna explícita |
| Skills empacotadas (como nasce uma) | ✓ `scripts/bundle-skills.mjs:13-15` (comentário: "skill embutida nova: vendorar em `assets/skills/`, registrar aqui e materializar no skill-mirror") e lista `SKILLS` `:16-51`; roda em `package.json` `prepackage`/`premake`; índice vivo `src/main/orch/skill-mirror.ts:236-246` `BUNDLED_MANIFESTS`, materialização `:685-719` | ponto de extensão óbvio |
| `nexus_context_scaffold` | `src/main/orch/tools-context.ts:311-319` → `ensureContextScaffold` (`src/main/context/context-doctor.ts:750-805`) | cria dirs/`policy.json`/`sensors.json` — **nenhuma escolha de tecnologia** |
| `.context/docs` | ✓ varrido: `business-model.md:36-51` só princípios de design; nenhum trecho de stack/biblioteca | — |
| Doutrina Maestro / operador | `src/main/orch/orchestrator-doctrine.ts:240-256` (`MAESTRO_STANDING_DOCTRINE`); `src/main/orch/operator-delegation-doctrine.ts:14` ("O Nexus (Jev) escolhe CLI, modelo e esforço") | escolhe *onde rodar*, não *em qual linguagem escrever* |
| Portão de regressão | `AGENTS.md:357-377` (F-199/F-246) → `src/main/regression-gate/regression-gate.ts` + `regression-gate.test.ts:839-893` | roda teste do arquivo no diff; **não** checa tecnologia |
| Testes do fluxo | ✓ `package.json:49-50` `test: vitest run` / `test:changed`; `AGENTS.md:68-69`; `.context/docs/testing.md:9-15`; orquestração em `src/main/orch/*.integration.test.ts` | comandos para antes/depois |
| Invariante citada no brief | ✓ `AGENTS.md:448-449` (`modelLineOf`, modelo mais novo sempre) | **irrelevante para esta frente**: nenhum código foi alterado, invariante intacta |
| Gap reconhecido | `docs/PLANO-DEV-SENIOR.md:61-64` | "o `guided-greenfield-brief` deliberadamente não escolhe stack" |

**Conclusão do item 1:** hoje a decisão de stack acontece *fora* do Nexus (o modelo/operador decide no turno), amparada só por duas frases do charter. Não há consulta a registro nem recusa de pacote descontinuado em lugar nenhum. (✓ verificado por busca no repo inteiro, fora `node_modules`.)

---

## 3. Tabela alvo → escolha recomendada → por quê → versões atuais

Fonte das versões: registros oficiais consultados em 03/10/2026. ✓ = li a resposta do registro **neste turno**; ◆ = coletado por subagente a partir da fonte indicada (não inspecionei o JSON bruto).

| Alvo | Escolha recomendada | Por quê (criterial) | Versão atual + fonte |
|---|---|---|---|
| Ferramenta nativa **Windows** | **Rust + windows-rs** (padrão); C++/WinUI 3 ou .NET só se o mantenedor já é da casa | binário único sem runtime, memória segura, bindings oficiais dos WinAPI, distribuição = um `.exe` | windows-rs (`windows`) **0.62.2** ◆ https://lib.rs/crates/windows · Rust stable **1.99.0** ◆ https://releases.rs/ · .NET LTS **10.0.12** ◆ https://dotnet.microsoft.com/ |
| **macOS** nativo | **Swift 6.4 + SwiftUI** | única via para App Store/notarização/SHORTCUTS do SO sem atrito; o próprio Nexus já tem pedaços nativos em `resources/native/darwin` | Swift **6.4.0** ◆ https://www.swift.org/ |
| **Desktop multiplataforma** | **Tauri 2** para projetos novos; **Electron** quando o app *já é* Electron ou precisa de Node/PTY completo (caso do próprio Nexus) | Tauri: binário ~10× menor, webview do SO, backend Rust; Electron: maturidade, sandbox, Node de verdade | Tauri estável **2.12.1** (3.0.0-alpha.4 em teste) ✓ https://crates.io/api/v1/crates/tauri · Electron **44.5.1** ✓ https://registry.npmjs.org/electron/latest |
| **CLIs** | **Go** por padrão; **Rust** quando latência/segurança de memória é requisito (grep/fd) | Go: binário estático, cross-compile trivial, stdlib completa, curva baixa; Rust: sem GC, correção de dados concorrentes | Go **1.27.1** ◆ https://go.dev/VERSION?m=text · Rust **1.99.0** ◆ |
| **Serviços de backend** | **Go** (rede/infra), **Rust** (hot path), **Node 24 LTS** quando o time é JS/full-stack, **Elixir** para real-time distribuído | escolha por restrição, não por moda: concorrência (Go), segurança+desempenho (Rust), produtividade+SSR (Node), BEAM/sessões (Elixir) | Node LTS **v24.21.0** ◆ https://nodejs.org/dist/index.json · Elixir **1.20.4** ◆ https://api.github.com/repos/elixir-lang/elixir/releases/latest · Bun **1.4.2** (runtime alternativo) ◆ npm dist-tags |
| **Web apps** | **Next.js** (SSR/RSC/edge), **React Router 8** (full-stack mais enxuto), **SvelteKit** (menos boilerplate), **Rails** (CRUD/back-office) | por requisito de rendering/ecossistema do deploy; Rails segue vindo para produtividade convencional | Next **16.3.8** ✓ https://registry.npmjs.org/next/latest · React Router **8.4.0** ✓ · SvelteKit **3.0.0** ✓ · Rails **8.1.4** ✓ https://rubygems.org/api/v1/gems/rails.json · React **19.3.0**, Vite **8.3.2**, TypeScript **7.0.2** ◆ npm dist-tags |
| **Dados / ML** | **Python + uv** (+ ruff/ty da Astral) | uv substitui pip/poetry/pyenv com lockfile único e 10–100× mais rápido; padrão *de facto* da área em 2026 | uv **0.12.22** ✓ https://pypi.org/pypi/uv/json |
| **Mobile** | **Expo/React Native** se o time é JS; **Flutter** para UI multiplataforma rápida; **Swift/Kotlin** quando depende de API do SO | 1 código-base × 2 lojas; nativo só quando o requisito é do dispositivo | Expo SDK **57.0.26** / RN **0.87.1** ◆ npm dist-tags · Flutter **3.47.0** ◆ https://docs.flutter.dev/release/release-notes |
| **Scripts de automação** | **Bash + jq** (uma linha), **Python + uv script** (lógica com deps, `uv run` com metadados inline), **tsx/TypeScript** dentro de repo JS | custo zero de setup > poder; uv scripts eliminam o "funciona na minha máquina" | uv **0.12.22** ✓ (mesma fonte) |
| Ruby / PHP (ecossistema web legado ou CMS) | Ruby 4.0 + Rails 8.1 / Laravel | só se o projeto já vive nisso — convencionalidade vence | Ruby **4.0.7** ◆ https://www.ruby-lang.org/en/news/ · Laravel **13.34.0** ◆ GitHub releases |

**△ Inferência (não é fato de fonte):** "melhor escolha" por alvo é julgamento de engenharia com base em critérios públicos (distribuição, runtime, ecossistema); os *números de versão* são verificados, a *preferência* é minha.

---

## 4. Política de decisão de stack

**Entradas (6, todas obrigatórias antes da resposta):**
1. **SO/alvo de distribuição** — Windows/macOS/Linux/web/móvel/loja (isso já corta metade das opções);
2. **Desempenho** — hot path? latência p99? consumo de memória? (sim → Rust/Go; não → produtividade primeiro);
3. **Distribuição/instalação** — binário único sem runtime (Go/Rust/.NET), web store (Tauri/Electron), loja de apps (Expo/Flutter/Swift),"`curl | sh`" (Rust/Go) — o operador NÃO é dev: instalação de um clique vence empate;
4. **Quem mantém** — time já sabe X? (respeitar stack existente é a regra nº 1 do charter atual: `engineering-charter.ts:20`);
5. **Ecossistema/madurez** — nº de mantenedores, releases nos últimos 12 meses, testes, docs, governança (fundação/pessoa única);
6. **Segurança** — superfície de ataque, histórico de CVEs, sandbox, verificação de memória.

**Saída (formato fixo):** `{ linguagem, framework, libs[{nome, versão exata}], justificativa em ≤3 frases, fonte: URL do registro }` — gravada como draft `.context/docs/stack-decision.md` pelo fluxo já existente de `nexus_context_draft_propose` (`src/main/orch/tools-context.ts:321-366`, source-bounded, review→apply independente). Nada de autoridade nova.

**Regra "lib sempre atual" (executar NO MOMENTO da decisão, nunca de memória):**
- **Consultar o registro:** npm → `npm view <pkg> version` (ou `https://registry.npmjs.org/-/package/<pkg>/dist-tags`); Rust → `https://crates.io/api/v1/crates/<name>`; Go → `pkg.go.dev`; Ruby → API do rubygems; Python → `https://pypi.org/pypi/<pkg>/json`.
- **Recusar (fail-closed):** pacote com `deprecated` no registro; última publicação > 18 meses; sem licença; govêrnio de pessoa única sem release desde 2024 sem justificativa; downloads perto de zero; dependência que só sustenta um pacote abandonado. Recusar = listar a evidência e propor alternativa, não seguir em silêncio.
- **Fixar versão:** exata no manifesto (`package.json` sem `^`/`~` nas libs críticas, `package-lock.json`, `Cargo.lock`, `go.sum`, `uv.lock`) — alinhado ao "version-pinning style" que o charter já manda seguir (`engineering-charter.ts:21`).

---

## 5. Plano de integração (passos pequenos, cada um com o teste que prova)

**Passo 1 — skill empacotada `stack-advisor` (menor primeiro passo útil).** Vendorar `assets/skills/stack-advisor/SKILL.md` com: as 6 entradas da política, a tabela §3 e o procedimento de consulta de registro; registrar em `scripts/bundle-skills.mjs` (lista `SKILLS`, `:16-51`) e em `skill-mirror.ts:236-246` (`BUNDLED_MANIFESTS`).
*Teste:* `node scripts/bundle-skills.mjs` gera `stack-advisor-manifest.ts` byte-estável; `npx vitest run src/main/orch/skill-mirror.test.ts` passa; **novo teste** afirmando `BUNDLED_MANIFESTS['stack-advisor']` existe e o manifesto contém `SKILL.md` + o marcador `registry` (o padrão já existe: `skill-mirror.test.ts:96-107` trata estados `'outdated'/'missing'`). Antes/depois: `npm run test:changed` (AGENTS.md:69).

**Passo 2 — endurecer a regra no charter.** Acrescentar à seção "Stack & dependencies" (`engineering-charter.ts:19-21`): obrigação de consultar o registro na hora, recusa de descontinuado com evidência, pin de versão. Um parágrafo, mesma voz do texto atual.
*Teste:* `npx vitest run src/main/orch/tool-util-charter-tier.test.ts` (mock em `:31`) + **novo teste de contrato** verificando que o charter injetado contém os marcadores `npm view`/`deprecated`; e `npx vitest run src/main/orch/worker-handoff-contract*.test.ts` para o gate `seniorMode && tier.engineering` (`:188`) não mudar de comportamento.

**Passo 3 — seção por projeto no `.context`.** Usar `nexus_context_draft_propose` para criar/revogar `.context/docs/stack-decision.md` (saída da política §4), sem tocar em autoridade: segue o fluxo draft→review→apply já existente.
*Teste:* testes do workflow de contexto (`src/main/context/context-doctor` / `context-workflow*.test.ts`): draft proposto com `sources` aceito, aplicado só após review, arquivo ausente → proposta nova. Sem UI nova — nada a exercitar em navegador.

**Passo 4 — (depois, opcional) frescor como sensor.** Estender `mechanical-sensors.ts` com um sensor `stack-freshness` fail-open (só reporta; o `dependency-audit` continua bloqueando por CVE). **Não** incluir no portão de regressão de imediato: o gate F-199 (`regression-gate.ts`) barra por diff, e uma checagem de rede quebraria builds offline.
*Teste:* `mechanical-sensors.test.ts` com fixture de resposta do registro (mesmo padrão dos testes `:102-190`), incluindo caso "pacote descontinuado" e caso "rede indisponível → não bloqueia".

**O que eu NÃO faria (△ inferência):** nova especialidade no Jev (`mission-route-specialty.ts:29-37`). Especialidade ≠ linguagem; mudar `ROUTE_SPECIALTIES` repercutiria em heurística (`:195-213`), benchmark (`:86-95`) e prompt (`jev-task-routing.ts:105-117`) para ganho zero de decisão de stack. Também não colocaria checagem de rede no portão de regressão.

---

## 6. O que não foi verificado (lacunas honestas)

1. **Nenhum teste do repo foi executado** — sou somente-leitura e não alterei código; não há comportamento alterado a validar. Os comandos de validação estão listados em cada passo acima (§5) para quem for executar.
2. **Validação visual de UI: não aplicável** — a entrega é um relatório, sem mudança de interface; nenhum screenshot ou clique foi produzido (e nada seria inventado).
3. **`WebSearch` indisponível neste pane** — a tool devolveu erro; usei `WebFetch` direto em registros/fontes oficiais. Versões ✓ (li o JSON nesta sessão): next 16.3.8, electron 44.5.1, react-router 8.4.0, @sveltejs/kit 3.0.0, tauri 2.12.1, rails 8.1.4, uv 0.12.22. Versões ◆ (coletadas por subagente a partir da fonte indicada; não inspecionei a resposta bruta): Rust, Go, Node LTS, Swift, .NET 10.0.12 (rodapé do site — pode haver SDK mais novo), Elixir, Flutter, Expo/RN, Bun, windows-rs, Ruby, Laravel, react/vite/typescript/deno.
4. **Não testei empiricamente** que Tauri vence Electron no caso do operador-alvo (não-dev) — é recomendação de critérios públicos, não benchmark.
5. **Invariante `AGENTS.md:448`** (modelo mais novo sempre / `modelLineOf`) foi lida e respeitada: nenhum código de rota/modelo foi tocado.
6. **Conflito de autoridade:** nenhum — brief pedia somente leitura e é exatamente o que foi feito.

---

Relatório (read-only, seguindo oc-scout): onde o Nexus decide stack hoje (engineering-charter.ts:19-21, guided-greenfield-brief.ts:56-57, stack-detector, catalog-recommend), tabela alvo→escolha→versões out/2026 lidas nos registros, política de decisão "lib sempre atual" e plano de integração em 4 passos pequenos com testes — primeiro passo: skill empacotada "stack-advisor" registrada em bundle-skills.mjs + skill-mirror.ts.