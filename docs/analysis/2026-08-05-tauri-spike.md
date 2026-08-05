# Spike Tauri — registro formal da avaliação (P2)

**Data:** 2026-08-05 · **Status:** avaliação encerrada, recomendação registrada · **Decisão: FICAR NO ELECTRON.** O ataque a tamanho/RAM é o `2026-08-05-electron-slim.md`.

## 1. Números medidos (Electron, artefatos 0.26.0 de hoje)

| Métrica | Electron (medido) | Tauri (estimado) |
|---|---|---|
| DMG | **206 MB** | shell WKWebView ~5-15 MB, mas **nosso payload fica**: asar-equivalente 127 MB + nativos 74 MB ⇒ DMG realista ~90-130 MB |
| .app | **511 MB** (275 MB = Frameworks Electron, custo fixo do shell) | ~240-280 MB |
| RAM baseline | **239 MB RSS** (host Overclock.app, 5 processos, workload leve — medido hoje via `ps`) | −100-150 MB de shell; PORÉM o sidecar Node (obrigatório, ver §2) devolve 60-100 MB |
| Startup | não medido hoje; método definido: telemetria de boot (esqueleto 6bdb7ac0) — medir antes de qualquer revisita | — |

Leitura honesta: o ganho bruto de disco (~150-250 MB) e de RAM de shell é real, mas **mais da metade do peso atual é payload nosso** (asar 127 MB + unpacked 74 MB), que migra junto. A poda do `electron-slim` captura 70-100 MB SEM trocar de shell.

## 2. Matriz de risco (do ledger real do projeto, não teórica)

| Risco | Evidência concreta | Gravidade |
|---|---|---|
| **Gates E2E ficam cegos** | TODO o gate de release dirige o app real por **CDP** (`NEXUS_REMOTE_DEBUG`, browser WS — memória: dev responde HTTP /json, empacotado só browser WS; `release-candidate-gate.mjs`, evidência `e2e-real-mission-evidence`). WKWebView **não tem CDP**. Migrar = reconstruir a instrumentação inteira do gate que hoje é a única prova de release | **Bloqueante** |
| **Multi-webview imaturo** | O grid de panes (Terminal/Browser/Squad) depende de múltiplas surfaces web independentes; multi-webview do Tauri ainda é experimental para este padrão | **Alta** |
| **QA 3 engines vs 1** | Chromium único hoje; Tauri = WKWebView (macOS) + WebView2 (Windows) + WebKitGTK (Linux) sob o mandato multi-plataforma do produto — triplica a matriz de teste visual/comportamental | **Alta** |
| **Ports nativos** | `better-sqlite3` (N-API), `@lydell/node-pty`, `onnxruntime-node` (voz), keychain/vault (Security.framework; memória: keychain trancado já congelou main thread), AEC wasm — todos assumem runtime Node no processo principal ⇒ **sidecar Node obrigatório**, anulando parte do ganho de RAM e adicionando um IPC novo | **Alta** |
| **darwin-pty-supervisor / cadeia de responsabilidade** | O disclaim + prova de cohort (main.c) ancora no PROCESSO host; trocar o host muda a cadeia de assinatura/responsibility inteira, recém-endurecida (76d405d1, spec Etapa 1) | **Alta** |
| **Pipeline de release inteiro** | `make-release.mjs`, `verify-macos-release.mjs` (fuses!), notarização, staging c/ hardlinks, forge makers — tudo Electron-específico; reconstrução completa | **Média-alta** |
| **Precedente Overclock** (dossiê 2026-07-18) | A migração Electron→Tauri deles **deixou a segurança para trás**: panes sem sandbox de OS, gates de skill/comando não portados. Lição registrada: *"enforcement de segurança mora no processo que controla o spawn, e portar isso é a parte que fica para trás"* | **Estratégica** |

## 3. Recomendação registrada

**FICAR NO ELECTRON.** Revisitar somente quando TODAS as três condições valerem:

1. **(a) Produto estável** — superfícies de pane e orquestração fora de fluxo de mudança semanal;
2. **(b) Gates em CI e CDP-free** — a prova de release não pode depender de dirigir Chromium por CDP (pré-requisito que a reforma do gate já persegue por outros motivos — ver `2026-08-05-release-gate-reforma.md` §1d);
3. **(c) Multi-webview Tauri maduro** — suporte estável a N webviews independentes por janela com paridade de eventos.

Gatilho de revisita: reavaliar este documento quando (b) estiver entregue — é a condição no nosso controle. Até lá, todo esforço de tamanho/RAM vai para o `electron-slim` (P1) e a manutenção de currency do Electron (hoje `^43.0.0`, atual).
