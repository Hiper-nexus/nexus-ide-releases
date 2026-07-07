# Senior Code Review - Fase 5 Jarvis Vision

Data: 2026-07-07
Branch: `nexus-jarvis-fase5-vision`
Range revisado: `main..HEAD` (`5a1d29d..a2fd9af`, 12 commits)
Escopo: privacidade, permissões macOS, captura de tela, OCR local, lifecycle de worker, rate limiting, AX tree, IPC e indicador visual.

## Sumário

**Verdict: BLOCK para release v1.0.0.**

Motivo: há dois bloqueadores de privacidade. Primeiro, `allowCloudImage` é respeitado no retorno de `vision.context()`, mas é contornado pela API `vision.capture()` e pelo evento `vision:captured`, que carregam `imageBase64` bruto para o renderer sem consentimento. Segundo, a captura tem fallback para "qualquer janela com nome", podendo capturar outro app do usuário quando a janela NexusIDE não é identificada.

| Severidade | Contagem |
|---|---:|
| CRITICAL | 2 |
| HIGH | 2 |
| MEDIUM | 3 |
| LOW | 1 |

Top 3 privacy/security risks:

1. Raw screenshot bypassa `allowCloudImage` via `capture()`/`onCaptured()` e broadcast para todas as janelas.
2. Fallback de captura pode selecionar Finder, Terminal, navegador ou outro app que não seja NexusIDE.
3. OCR aceita payload base64 arbitrário sem timeout/limite de tamanho; combinado com rate limit não atomico permite DoS de CPU/memória.

## Findings

### CRITICAL - VISION-PRIV-01 - `allowCloudImage` é contornado por `capture()` e `vision:captured`

**Arquivos/linhas:** `src/main/vision/ipc-bridge.ts:24-35`, `src/main/vision/ipc-bridge.ts:92-99`, `src/preload/preload.ts:601-610`, `src/shared/vision-ipc.ts:30-37`, `src/shared/vision-ipc.ts:121-135`, `src/main/vision/vision-orchestrator.ts:104-105`

**Problema:** o orquestrador omite `imageBase64` do `VisionContext.screenshot` quando `allowCloudImage` é falso, mas a captura usada por esse mesmo fluxo chama `captureWithRateLimit()`. Esse helper:

- retorna `ScreenCaptureResult` bruto para `VISION_CHANNELS.capture`;
- salva `lastCaptureResult` com `imageBase64`;
- faz `broadcast(VISION_CHANNELS.captured, result)` com o PNG base64 completo para todas as janelas.

O `VisionIndicator` só precisa saber que houve captura, mas o evento exposto pelo preload entrega `ScreenCaptureResult` completo a qualquer listener do renderer. Portanto `context({ allowCloudImage: false })` ainda pode vazar a imagem bruta para o renderer via evento.

**Impacto:** quebra o invariante P0 "imagem raw só vai pra cloud com consentimento explícito" na fronteira que alimenta fluxos cloud. Um renderer comprometido, XSS local ou integração futura pode assinar `onCaptured()` ou chamar `capture()` diretamente e exfiltrar o PNG sem `allowCloudImage`.

**Fix recomendado:**

- Separar `ScreenCaptureResultInternal` de `ScreenCaptureMetadata`.
- `vision:captured` deve emitir somente `{ capturedAt, width, height, format }` ou um booleano.
- Remover `vision.capture()` do contrato publico, ou exigir um objeto `{ allowCloudImage: true, consentToken }` emitido por uma ação explicita de usuário.
- `collectVisionContext()` deve usar captura interna sem broadcast bruto.
- Remover `lastCaptureResult` ou trocar por metadata com TTL curto.

**Teste esperado:** `context({ allowCloudImage: false })` não deve disparar nenhum evento nem retorno contendo `imageBase64`; `onCaptured` deve receber somente metadata.

### CRITICAL - VISION-PRIV-02 - Captura pode cair para janela de outro app

**Arquivos/linhas:** `src/main/vision/screen-capture.ts:53-68`, `src/main/vision/screen-capture.test.ts:100-109`

**Problema:** `captureNexusWindow()` tenta `source.name.includes('NexusIDE')`, depois compara com o título da janela focada e, se nada bater, escolhe `sources.find((s) => s.name.length > 0)`. O teste atual valida esse fallback com `SomeApp`.

**Impacto:** se o título de NexusIDE mudar, se a janela não estiver focada, se o desktopCapturer retornar nomes localizados/inesperados, ou se houver timing durante startup, o app pode capturar Finder, Terminal, navegador, password manager ou qualquer janela visível. Isso viola o invariante "zona quente intocada" e transforma uma feature de contexto do workspace em screen capture genérico.

**Fix recomendado:**

- Falhar fechado quando não houver match positivo da janela NexusIDE.
- Preferir `BrowserWindow.getMediaSourceId()` e comparar com `DesktopCapturerSource.id` quando disponível.
- Como fallback, usar match exato contra o `BrowserWindow` alvo conhecido, nunca "qualquer janela".
- Adicionar teste que garante rejeição quando só existem janelas não Nexus.

### HIGH - VISION-RATE-01 - Rate limiter não é atomico e não taxa tentativas com erro

**Arquivos/linhas:** `src/main/vision/ipc-bridge.ts:24-35`, `src/main/vision/rate-limiter.ts:13-20`, `src/main/vision/rate-limiter.test.ts:16-31`

**Problema:** `captureWithRateLimit()` checa `canCapture()`, aguarda `captureNexusWindow()`, e só depois chama `markCaptured()`. Chamadas concorrentes que entram antes do primeiro `await` concluir passam todas no mesmo `lastCaptureAt`. Além disso, falhas de permissão, imagem inválida ou janela ausente não consomem a janela de rate limit.

**Impacto:** qualquer renderer pode disparar rajadas paralelas de `vision.capture()`/`vision.context()`, causando múltiplas chamadas `desktopCapturer.getSources()` e OCR em sequência. Em `not-determined`/erro, o app pode martelar o subsistema de captura, degradando bateria/CPU e UX.

**Fix recomendado:**

- Trocar para `tryAcquire()` atomico que marca a tentativa antes do `await`.
- Opcionalmente liberar o token apenas para cancelamentos internos conhecidos; nao para erro de permissao/captura.
- Adicionar lock/in-flight singleflight para captura.
- Cobrir burst concorrente e falhas repetidas em teste.

### HIGH - VISION-OCR-01 - OCR não tem timeout, limite de payload ou validação de PNG no IPC

**Arquivos/linhas:** `src/main/vision/ipc-bridge.ts:108-117`, `src/main/vision/ocr.ts:72-104`, `src/main/vision/ocr.test.ts:64-80`

**Problema:** `vision.ocr(imageBase64)` aceita qualquer string não vazia, faz `Buffer.from(raw, 'base64')` e chama Tesseract. Não há limite de tamanho, validação de assinatura PNG, timeout de `createWorker()`/`recognize()`, nem cancelamento. O `finally` chama `worker.terminate()`, mas só roda quando a promise resolve/rejeita; se `recognize()` travar, o worker fica vivo e o IPC pendente.

**Impacto:** DoS local por memória/CPU e leak de worker em timeout/hang. Este ponto falha o invariante "Worker tesseract termina limpo (sem leak)" no caminho de timeout.

**Fix recomendado:**

- Validar base64 e assinatura PNG antes de OCR.
- Aplicar limite de bytes coerente com screenshot 1920x1080.
- Envolver OCR em `Promise.race` com timeout e chamar `terminate()` no timeout.
- Adicionar teste para timeout, imagem inválida no IPC e payload acima do limite.

### MEDIUM - VISION-AX-01 - AX tree inclui nós live/status e não tem filtro explicito para campos sensíveis

**Arquivos/linhas:** `src/preload/ax-tree.ts:8-70`, `src/preload/ax-tree.test.ts:23-49`

**Problema:** o extractor remove `display:none`, `visibility:hidden` e `aria-hidden`, mas não exclui explicitamente `input[type=password]`, campos com `autocomplete=current-password/one-time-code`, `contenteditable` sensível, nem regiões `aria-live`/`role=status`. O teste atual inclusive espera que `aria-live="polite"` e texto `Ready` sejam capturados.

**Impacto:** hoje valores atuais de `<input>` normalmente não entram via `textContent`, mas a política não é defensiva. Em UI real, regiões live/status e DOM de terminal podem produzir ruído de alto churn e capturar texto sensível que depois entra em `llmPrompt`.

**Fix recomendado:**

- Excluir password/OTP/secret-like controls por tag, type, autocomplete e role.
- Tratar `aria-live`, `role=status`, `role=log` e regiões de terminal com limite dedicado ou opt-in.
- Adicionar testes para password field, OTP, contenteditable e live-region churn.

### MEDIUM - VISION-AX-02 - Erro de AX/permissão perde classificação no IPC bridge

**Arquivos/linhas:** `src/main/vision/ipc-bridge.ts:59-66`, `src/main/vision/vision-orchestrator.ts:54-70`, `src/main/vision/vision-orchestrator.test.ts:82-103`

**Problema:** `vision-orchestrator.test.ts` cobre AX permission denied via override direto com `name: 'AxPermissionDenied'`, mas o caminho real `readFocusedAxTree()` captura qualquer erro de `executeJavaScript()` e rethrowa `new Error('Falha ao extrair AX tree do renderer.')`. Isso apaga `name/message` originais e impede `classifyError()` de retornar `permission-denied`.

**Impacto:** degradação existe, mas o feedback ao usuário/LLM vira `error`, não `permission-denied`, em falhas reais de acesso/isolation. Isso enfraquece o requisito de degradation gracioso quando AX/permissão é negada.

**Fix recomendado:** preservar `cause`, `name` e mensagem sanitizada, ou mapear explicitamente falhas conhecidas antes de lançar erro genérico.

### MEDIUM - VISION-PRIV-03 - Screenshot bruto fica retido em memória sem TTL

**Arquivos/linhas:** `src/main/vision/ipc-bridge.ts:22`, `src/main/vision/ipc-bridge.ts:32-35`, `src/main/vision/ipc-bridge.ts:127-129`

**Problema:** `lastCaptureResult` guarda o último `ScreenCaptureResult` completo, incluindo `imageBase64`, até próxima captura ou encerramento do app. Não há TTL, clear após OCR, nem minimização para metadata.

**Impacto:** não há escrita em disco, mas o tempo de retenção em memória é desnecessariamente alto para um conteúdo sensível. Também cria uma API exportada que facilita reuso futuro inseguro.

**Fix recomendado:** remover o cache bruto, ou guardar somente metadata com TTL. Se cache bruto for necessário, encapsular em módulo privado com expiração e zeroização best-effort.

### LOW - VISION-UI-01 - Indicador diz "capturando" durante a janela pos-captura

**Arquivos/linhas:** `src/renderer/components/VisionIndicator.tsx:42-49`

**Problema:** o indicador aparece por 10s apos uma captura, mas o title diz "está capturando". Isso comunica captura contínua quando o evento já terminou.

**Impacto:** baixo, mas em feature de privacidade a copy precisa distinguir "capturou recentemente" de "capturando agora".

**Fix recomendado:** trocar title para "Jarvis Vision capturou a tela do Nexus IDE recentemente" ou adicionar estado real de captura em andamento.

## Privacy Audit

Escopo desta auditoria: caminhos novos da Fase 5. Não há chamada de rede direta nos módulos `src/main/vision/*`, `src/preload/ax-tree.ts`, `src/shared/vision-ipc.ts` ou `VisionIndicator.tsx`. A fronteira critica e o renderer/API que pode alimentar fluxos cloud posteriores.

| Fluxo | Dados | Sai do main/local? | Consentimento | Observação |
|---|---|---:|---|---|
| `captureNexusWindow()` -> `ScreenCaptureResult` | PNG base64 da janela | main -> renderer via `vision.capture()` | Nenhum | Bypass direto de `allowCloudImage`. |
| `collectVisionContext({ allowCloudImage:false })` | OCR texto, AX tree, metadata | main -> renderer | Sem consentimento de imagem | Retorno omite `imageBase64`, mas `captureWithRateLimit()` ainda transmite evento bruto. |
| `collectVisionContext({ allowCloudImage:true })` | OCR texto, AX tree, PNG base64 | main -> renderer | Flag booleana do caller | Falta origem confiavel/UX de consentimento; qualquer renderer pode setar `true`. |
| `vision:captured` event | PNG base64 completo | main -> todas as janelas renderer | Nenhum | Evento necessario para UI indicator deveria conter somente metadata. |
| `vision.ocr(imageBase64)` | Imagem enviada pelo renderer, texto OCR | renderer -> main -> renderer | Nenhum | OCR e local, mas payload e unbounded. |
| `readFocusedAxTree()` | DOM/ARIA/texto do renderer | renderer -> main -> renderer context | Nenhum | Texto pode entrar em `llmPrompt` e ser enviado por integração cloud futura. |
| Logs | Erros e progresso | console local | N/A | `rg` nao encontrou log de `imageBase64`; OCR logger esta silenciado. |
| Disco | Screenshot | Nao identificado | N/A | Nenhum `fs.writeFile` em vision; risco atual e memoria/evento, nao TTL de arquivo. |

Conclusão da auditoria: a promessa "raw screenshot local por padrao" não se sustenta enquanto `capture()` e `onCaptured()` expuserem `ScreenCaptureResult` bruto sem consentimento. A correção deve reduzir a API pública para metadata/contexto redigido e mover qualquer acesso a imagem bruta para caminho interno com consentimento rastreável.

## Test Review

Cobertura existente positiva:

- PNG valido/invalido em `screen-capture.test.ts`.
- Permissão macOS `denied` em `assertScreenPermission()`.
- OCR sucesso, cache hit e erro de recognize/init.
- Orquestrador omite `imageBase64` no retorno de `context()` sem consentimento.
- AX tree remove hidden/script/style.
- VisionIndicator remove timer/listener no unmount.

Gaps que precisam bloquear merge:

- Nenhum teste para `ipc-bridge.ts`; portanto o bypass via broadcast não é coberto.
- Nenhum teste de concorrência para rate limiter.
- Nenhum teste provando que erro de captura consome rate limit.
- Nenhum teste de OCR timeout/hang ou payload grande.
- Nenhum teste de `vision.ocr()` com base64 inválido/imagem não PNG.
- Nenhum teste garantindo que janelas não Nexus são rejeitadas.
- Nenhum teste para password/OTP/contenteditable/aria-live noise no AX tree.

## Checklist de Segurança

| Item | Status |
|---|---|
| Injection | Sem SQL/comando/template novo nos módulos vision; `executeJavaScript` usa string constante. |
| XSS | Sem renderização HTML nova; risco principal e XSS existente conseguir chamar API vision ampla. |
| Authentication | N/A para desktop local; falta capability/consent token para captura. |
| Authorization/IDOR | Falha: qualquer renderer com `window.nexus` pode capturar/assinar evento bruto. |
| CSRF | N/A. |
| Race conditions | Falha: rate limiter nao atomico sob concorrência. |
| Session/state | `lastCaptureResult` retem imagem bruta sem TTL. |
| Cryptography | N/A. |
| Information disclosure | Falha: raw image via broadcast/capture e janela errada. |
| DoS | Falha: OCR unbounded/no-timeout e burst capture. |
| Business logic | Falha: `allowCloudImage` aplicado somente a um retorno, nao ao sistema inteiro. |

## Arquivos revisados

Lidos integralmente:

- `docs/analysis/fase5-vision-map.md`
- `src/main/vision/screen-capture.ts`
- `src/main/vision/ocr.ts`
- `src/main/vision/rate-limiter.ts`
- `src/main/vision/vision-orchestrator.ts`
- `src/main/vision/ipc-bridge.ts`
- `src/preload/ax-tree.ts`
- `src/shared/vision-ipc.ts`
- `src/renderer/components/VisionIndicator.tsx`
- `src/main/vision/screen-capture.test.ts`
- `src/main/vision/ocr.test.ts`
- `src/main/vision/rate-limiter.test.ts`
- `src/main/vision/vision-orchestrator.test.ts`
- `src/preload/ax-tree.test.ts`
- `src/renderer/components/VisionIndicator.test.tsx`

Trechos relevantes revisados:

- `src/preload/preload.ts:560-616`
- `src/main/main.ts:40-70`, `src/main/main.ts:110-243`
- `src/renderer/components/WorkspaceBar.tsx:1-260`
- `src/renderer/styles/global.css:1560-1604`
- `forge.config.ts:70-90`
- `src/shared/types.ts:660-695`
- `docs/changelog/fase5.md`

## Evidência de comandos

- `git log main..HEAD --stat --oneline` confirmou 12 commits e arquivos alterados.
- `git diff --name-status main...HEAD` listou 25 arquivos alterados.
- `rg -n "imageBase64|base64|screenshot" src/` mapeou todos os pontos que tocam imagem/base64.
- `rg -n "worker|terminate|Worker\\(" src/` confirmou lifecycle do worker Tesseract.
- `rg -n "console\\.|imageBase64|screenshot|ocr|llmPrompt|allowCloudImage" src/main/vision src/preload src/renderer/components/VisionIndicator.tsx src/shared/vision-ipc.ts` não encontrou logging de imagem bruta em vision.
- `rg -n "fs\\.|writeFile|tmp|temp|cache|screenshots|lastCaptureResult|getLastCaptureResult" src/main/vision ...` não encontrou screenshot em disco, mas encontrou `lastCaptureResult` em memória.
- `rg -n "getMediaSourceId" node_modules/electron/electron.d.ts` confirmou API local disponível no Electron instalado.

## Release Gate

Para liberar Fase 5, eu exigiria no mínimo:

1. Corrigir `allowCloudImage` em todos os caminhos, inclusive eventos e API `capture`.
2. Remover fallback para qualquer janela e falhar fechado quando a janela Nexus nao for identificada.
3. Tornar rate limiter atomico e aplicavel a tentativas com erro.
4. Adicionar timeout/limite/validação no OCR e testes de lifecycle.
5. Cobrir `ipc-bridge.ts` com testes de privacidade e rate limit.
