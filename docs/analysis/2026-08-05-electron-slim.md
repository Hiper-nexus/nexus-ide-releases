# Electron Slim — ataque direto a tamanho/RAM (P1/P2)

**Data:** 2026-08-05 · **Status:** spec pronto para implementação · **Contexto:** alternativa recomendada à migração Tauri (ver `2026-08-05-tauri-spike.md`). Em vez de trocar o shell, emagrecer o que embarcamos nele.

## 1. Baseline medido (artefatos reais da 0.26.0, hoje 17:42)

| Métrica | Valor | Fonte |
|---|---|---|
| DMG arm64 | **206 MB** | `out/make/NexusIDE-0.26.0-arm64.dmg` |
| ZIP arm64 | **207 MB** | `out/make/zip/darwin/arm64/NexusIDE-darwin-arm64-0.26.0.zip` |
| .app instalado | **511 MB** | `out/NexusIDE-darwin-arm64/NexusIDE.app` |
| — Contents/Frameworks (Electron 43) | 275 MB | custo fixo do shell |
| — Contents/Resources | 236 MB | nosso payload |
| —— app.asar (payload) | 127 MB | |
| —— app.asar.unpacked | 74 MB | nativos + wasm |
| node_modules (dev, symlink) | 1,6 GB | `du -shL node_modules` |
| RAM baseline (host Overclock.app, 5 processos, workload leve) | 239 MB RSS | referência de shell Electron vivo |
| Bundles Vite (main+renderer) | 19,3 MB | `.vite/` |

### Decomposição lógica do asar (top ofensores)

Nota de método: o header do asar lista também entradas `unpacked` (payload físico em `app.asar.unpacked/`); a soma lógica (~187 MB) excede o payload do asar (127 MB). Itens marcados ⬦ vivem (total ou parcialmente) no unpacked.

| MB | Pacote | Observação |
|---|---|---|
| 43,2 ⬦ | `tesseract.js-core` | wasm multi-variante (simd, relaxedsimd, lstm…) — 44 MB no unpacked |
| 28,3 | `better-sqlite3` | **payload dentro do asar é prebuilds+src+deps**; o `.node` útil (unpacked) tem só ~4 MB |
| 25,1 ⬦ | `onnxruntime-node` | payloads nativos multi-plataforma/EP |
| 23,2 | `typescript` | **dep de RUNTIME em `dependencies`** (package.json:74) |
| 19,3 | `.vite` | nossos bundles |
| 8,9 | `@xterm` | núcleo do produto, ok |
| 4,6 | `@babel` (parser+types) | transforms em runtime |
| 4,3 | `zod` | checar duplicação (bundlado no vite E no asar) |
| 4,1 | `@tesseract.js-data` (eng+por) | traineddata OCR |
| 3,6 | `zlibjs` | transitiva (tesseract) |
| 2,6 | `pkijs` | transitiva de `selfsigned` |
| 2,2 | `tar` | transitiva |
| 1,8+1,5 | `ssh2` + `cpu-features` | optionalDependency |

### Maiores chunks renderer/main carregados no boot

| KB | Chunk | Boot ou on-demand hoje? |
|---|---|---|
| 2.631 | `acp-harness-driver-*.js` | verificar import: candidato nº 1 a lazy |
| 737 | `browser-manager-*.js` | só necessário quando pane Browser abre |
| 221 | `adapter-registry-*.js` | boot (provável ok) |

## 2. Plano de ataque

Cada item: tamanho S/M/L + MB esperados. Ordenado por MB/esforço.

### Fase A — poda de payload (P1)

| # | Item | Ação | Size | MB no .app |
|---|---|---|---|---|
| A1 | `better-sqlite3` gordo no asar | `packagerConfig.ignore` para `prebuilds/`, `src/`, `deps/` do pacote (o `.node` rebuildado já vai pro unpacked via plugin-auto-unpack-natives) | **S** | **−24** |
| A2 | `typescript` em runtime | Auditar `require("typescript")` em `src/main`/`src/shared` (suspeito: pipeline recast/babel). Se usado: lazy `import()` + avaliar substituir por `@babel/parser` que já embarcamos; se não: mover p/ devDependencies | **M** | **−23** |
| A3 | `tesseract.js-core` multi-variante | Embarcar só a variante que o runtime escolhe no arm64 (simd-lstm); as demais são fallback de CPU que nunca dispara em Apple Silicon. Gate por arch no forge config | **M** | **−25 a −33** |
| A4 | `onnxruntime-node` multi-EP | Strip de payloads de plataformas/EPs não-alvo no `postpackage` (manter arm64 CPU/CoreML). Cuidado com a trilha da memória: nunca mexer via hook em node_modules compartilhado — fazer no bundle de saída | **M** | **−10 a −15** |
| A5 | Duplicação bundle × asar (`zod`, `@babel`, `recast`, `smol-toml`…) | Auditar `externals` do vite main: tudo que o vite já bundla não precisa existir também no asar; ampliar `ignore` do packager | **M** | **−8 a −12** |
| A6 | `pkijs`/`selfsigned`/`zlibjs`/`tar` | Verificar uso real; selfsigned só gera cert uma vez → candidato a lazy ou a pré-gerar no primeiro boot | **S** | **−5 a −8** |
| A7 | `@tesseract.js-data` eng+por | Decisão de produto: manter embarcado (OCR offline garantido) ou download no primeiro uso. Default: manter | **L** | (−4, opcional) |

**Subtotal Fase A: −70 a −100 MB no .app → DMG estimado 206 → ~160-175 MB.**

### Fase B — lazy-load (P1/P2, ataca RAM e startup)

| # | Item | Ação | Size | Ganho |
|---|---|---|---|---|
| B1 | `acp-harness-driver` (2,6 MB) | `import()` dinâmico no primeiro spawn de pane ACP | **S** | boot mais leve, −heap parse |
| B2 | `browser-manager` (737 KB) | carregar quando o primeiro pane Browser abre | **S** | idem |
| B3 | OCR (tesseract) | inicializar worker só no primeiro uso de visão/OCR | **M** | −30-60 MB RSS quando não usado |
| B4 | Voz (onnxruntime + AEC) | já parcialmente condicional; garantir zero require no boot sem voice ativa | **M** | −40-80 MB RSS |

Critério de aceite B: `npm start` + boot sem abrir Browser/voz/OCR → nenhum desses módulos no snapshot de módulos carregados (medível via `process.getHeapStatistics` + telemetria de boot do esqueleto 6bdb7ac0).

### Fase C — Electron currency (contínuo, S)

- Hoje: `electron ^43.0.0` — **atual**. Frameworks 275 MB é custo fixo por versão; majors novos ocasionalmente reduzem (icu slim, etc.).
- Regra: acompanhar major N−0/N−1, nunca ficar >2 majors atrás (ABI dos nativos: better-sqlite3/node-pty/onnx — ver trilha de rebuild na memória do projeto).

## 3. Metas e verificação

| Meta | Baseline | Alvo |
|---|---|---|
| DMG arm64 | 206 MB | **≤ 160 MB** |
| app.asar | 127 MB | **≤ 65 MB** |
| RSS boot (sem workload) | ~239 MB | **≤ 200 MB** |

- Gate: adicionar check de regressão de tamanho no `verify-macos-release.mjs` (falha se DMG crescer >10% sem justificativa no commit).
- Ordem de execução recomendada: A1 → A2 → A5 → A3 → A4 → B1/B2 → B3/B4 → A6.
- Riscos: A3/A4 mexem em runtime de terceiros (testar OCR e voz no smoke empacotado — `smoke:package` já existe); A2 exige prova de que nenhum caminho de produção importa typescript eagerly.
