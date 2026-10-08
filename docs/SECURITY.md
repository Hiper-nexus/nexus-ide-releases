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
| Egress Luna (OpenAI Decisions API, beta): texto | `decision-models/luna-client.ts` (POST fixo `https://api.openai.com/v1/decisions`, `redirect: 'error'`, modelo só `gpt-6-luna`, lotes ≤ 64, limites de corpo/resposta; recusa não vira predicado 0), `luna-map.ts`, `decision-redaction.ts`, `decision-routing.ts` (Somente Luna cobre também as superfícies com efeito e, sem chave OpenAI, não cai no Jev; Juntos manda o mesmo texto redigido a cada membro pronto), `decision-accounts.ts` (preferência por conta autenticada, em `decision-accounts.json`), `luna-credentials.ts` + `voice/voice-secrets.ts` (chave já existente `voice-env:OPENAI_API_KEY`; presença por `hasSecret`, sem segundo cofre). O diário não grava o input; a linha de divergência leva só números. Custo só com `usage.input_tokens`, tarifa publicada de US$ 0,10/1M de entrada; prêmios regionais não vêm na resposta e não são inventados |
| Egress Luna: imagens mascaradas do navegador | A mesma máscara do Clef (`decision-images.ts` e a cadeia do navegador). Só com a visão ligada. Em Somente Luna a captura vai à OpenAI como data URL (`input_image`); no Automático, só se a Cloudflare não for a rota; em Juntos, a mesma captura mascarada vai à Cloudflare e à OpenAI. Pixels de desktop não saem. Sem URL remota |
| Egress Jev (TypeSafe) | `jev/jev-client.ts` (redactState, fail-open), `orch/jev-handoff-review.ts`, `orch/tools-judge.ts`, `orch/tools-browser-autopilot.ts`, `orch/tools-computer-autopilot.ts`, `vision/desktop-control.ts`, `orch/jev-dispatch-guard.ts`, `orch/tools-tool-pick.ts`, `orch/jev-task-routing.ts`, `orch/hook-triage-endpoint.ts`, `orch/tools-handoff-workspace.ts`, `browser/browser-manager.ts` + `browser/browser-extract.ts` (julgamento de página e estado de extração redigidos e limitados; Jev só escolhe entre candidatos reais) |
| Egress Jev/Clef: título de missão falado | `jev/jev-mission-pick.ts` (superfície `missionPick`, dois casos: "abre a missão X" casa com 2–5 títulos parecidos (desempate) ou NADA casa e há de 1 a 8 missões (a fala pode ser um nome mal reconhecido: aí o Jev vê a fala contra os títulos de TODAS as missões, até 8; com 9 ou mais não consulta); o que sai é o que a pessoa disse e os títulos candidatos, que ela mesma digitou, redigidos por `redactSecrets` ANTES de cortar (só formatos de segredo conhecidos: um dado pessoal no título sai como foi digitado) e limitados a 2 KB; candidatos por posição `m1…m5`, nunca id real, caminho nem conversa; uma pergunta `choice`, timeout 3 s, sem retry de timeout, 30/min; fail-open total — sem chave, desligado, limite ou erro viram "sem decisão" e a voz pergunta; aceita só com confiança ≥ 0,7 e margem ≥ 0,15 sobre a 2ª opção no desempate, e ≥ 0,90 e ≥ 0,30 no caso "nada casou" (a fala pode ser ruído); o diário grava só ids de pergunta, probabilidades e `pick:mN`/`ask:motivo` (com prefixo `noMatch:` no segundo caso), nunca texto), `jev/jev-mission-pick-ipc.ts` (`handleTrusted` + schema estrito de `shared/mission-pick.ts`: chave a mais, id ou caminho são recusados; resposta sempre tipada, inclusive em erro), `renderer/voice/restore-mission-target.ts` (timeout de 5 s no renderer; não consulta com fala de uma letra só). Rota de texto comum, NÃO fixa no Jev: em "Somente Clef" (ou sem chave Jev no Automático) o mesmo estado redigido vai à Cloudflare; em "Somente Luna" vai à OpenAI; no Automático a Luna só recebe se faltarem Jev e Clef. A regra de aceitação é a mesma |
| Egress Reporte de problema | Reporte de problema: título/descrição/passos digitados + diagnóstico opt-in redigido → `api.nexuside.app` (`POST /v1/bug-reports`), por ação explícita do usuário. `bug-report/bug-report-ipc.ts` (`handleTrusted` + schema estrito; payload inválido é recusado), `bug-report/bug-report-service.ts` (prévia fiel: o envio usa o corpo exato que a prévia mostrou e recusa se o corpo mudou — digest sha-256; no máximo 10 tentativas por 10 min; timeout curto, `redirect: 'error'`, resposta validada, erros em pt-BR, nada em log), `bug-report/bug-report-diagnostics.ts` (lista de permissão: só `kind`, código curto e instante dos últimos eventos do trace, agente/modelo ativo, nº de panes e se há missão — nunca argumentos, caminhos, prompts, saída de terminal nem ambiente; só com `consent.diagnostics`, desligado por padrão), `bug-report/bug-report-redaction.ts` (chaves/JWT/Bearer, e-mails, HOME). A sessão fica no Main (`api-client.ts`) e nunca chega ao renderer. |
| Aprovação estruturada de ferramenta (PRV-02/MOB-07, F-991) | `agent-hooks/approval-broker.ts` (CAS por requestId/revisão, recibo idempotente, prazo, teto por sessão), `orch/hook-permission-endpoint.ts` (`POST /hook/permission`, bearer per-pane; sem respondente responde `{}` na hora e a TUI decide; toda falha é `{}`; resumo redigido por `redactSecretText`), `agent-hooks/approval-ipc.ts` (`handleTrusted` + schema estrito), `remote/remote-bridge.ts` (`agentSession.respondToApproval`: decisão, nunca tecla no PTY; sem escrita no pane do pedido → `rejected`, pedido desconhecido dá a mesma recusa; aprovar comando de alto impacto pede o diálogo nativo do desktop; o snapshot só lista pedidos de panes que o escopo lê). Os hooks só existem nos settings por sessão dos panes do Nexus, nunca no `~/.claude`/`~/.codex` do operador |
| Recibo da escolha de conta (IPC de leitura) | `persistence/account-choice-ipc.ts` (`accountChoice:get`: `handleTrusted` — só o frame principal da janela principal —, schema zod estrito `{ sessionId ≤ 128 }`, qualquer entrada inválida ou falha vira `null`, nunca lança; somente leitura, sem egress) devolve o recibo de `account-choice-receipts.ts` JÁ saneado por `parseAccountChoiceReceipt` (`shared/account-choice.ts`, lista de permissão: rótulos remascarados com `maskAccountLabel`, texto livre sem controle nem e-mail cru, chave desconhecida descartada) — nunca id de conta, fingerprint, e-mail cru nem token. O renderer o relê pela mesma lista antes de exibir (`renderer/lib/account-choice-receipt.ts`). |

## Error flow

Decision routing lives in `decision-models/decision-judge.ts`: fixed modes never
silently change provider. Somente Luna without an OpenAI key does not fall
back to Jev or Clef, including on effect-bearing surfaces. Juntos runs as an
ensemble only when at least two selected providers have a key; a single
provider is not called in place of that ensemble. Jev can still be called
alone on `computerTool` and `browserTool` labels. Visual inputs require explicit opt-in. They go to Clef
when that route is selected, to Luna (inline data URL only) when the operator
chose Luna or Automatic has no Clef credential but does have the OpenAI key,
and to both when the operator chose Juntos. Desktop pixels never leave.
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
  `helperReuse`, `businessModel`, `missionPick` (voice tie-break between similar
  mission titles, or a misheard name read against up to 8 mission titles:
  redacted titles typed by the person, ≤ 2 KB), `judgeTool`,
  `rankTool`; `businessModel` carries
  up to 12 KB of the changed code from the regression gate, redacted for known
  secret formats only; `taskRouting` also carries the skill catalog: names and
  descriptions (≤ 300 characters each, at most 120 per question) of the skills
  bundled with Nexus and of the skills installed in the project's
  `.claude/skills` / `.nexus/skills` (F-753, read by the Skills panel's
  symlink-refusing scanner), plus the request typed in a "+ Pane" (≤ 1,500
  characters, redacted); `catalogPick` (Marketplace recommendations, F-757)
  carries only the labels of the stack areas detected from the project's own
  files — "React", "Go" — and the name and category of up to 12 catalog
  candidates per question: never a path, the project name or file content,
  and installing stays behind the Marketplace's two native confirmations).
  Automatic prefers Jev
  for everything except `toolPick`; it only falls back to Cloudflare when no Jev
  key exists, and the settings screen says so (`credential-fallback`).
- **Somente Luna (text):** the same redacted text, sent to `api.openai.com/v1/decisions`
  (`gpt-6-luna` only), including `dispatchGuard`, `handoffReview`,
  `memoryDistill`, `computerTool` and `browserTool` (text). Automatic uses Luna
  only after the preferred provider (Clef for tool selection, research, and
  rank; Jev otherwise) is missing, and an explicit `gpt-6-luna` on a pinned
  surface in Automatic or Somente Jev still yields no route. Without the OpenAI
  key there is no route and no silent Jev fallback. The published input price
  is US$0.10 per 1M tokens; output tokens are not billed. If `usage.input_tokens`
  is absent the diary stores a null cost.
- **Juntos (opt-in):** redacted text of the same question goes to Jev and Luna
  when both keys exist. On `dispatchGuard`, `handoffReview` and `memoryDistill`,
  Jev stays in the call when its key exists; Luna and Clef may only tighten
  that measured threshold. Luna and Clef without a Jev key are still an
  ensemble on those surfaces and, for ordinary text, with each other. The
  call is not dropped only because Jev is absent. When Jev and Luna are both
  ready, ordinary text still does not include Clef. Reversible disagreement (`taskRouting`, including the skill
  suggestion, `missionPick`, `catalogPick`) keeps the higher confidence, and
  the journal line stores both numbers with no input text. Agreement follows.
  Irreversible disagreement keeps the more restrictive verdict. `computerTool`
  and `browserTool` labels stay on Jev. Masked browser images, with vision
  already on, go to Clef and Luna; Jev does not see images. Fewer than two
  ready members is not an ensemble. This mode is the only one that spends more
  than one call per judgment. The preference is the signed-in account's, not a
  value written into a worker prompt.
- **Pinned to Jev in Automatic, Somente Jev, and Somente Clef:** `dispatchGuard`,
  `handoffReview`, `memoryDistill`, `computerTool`, `browserTool` (text).
  Without a Jev key they have no route and fail open (guard `skipped`).
  Somente Clef does not send them anywhere. `nexus_judge` (surface `judgeTool`,
  not pinned) still rejects `model=clef`; in Somente Luna that tool uses the
  Decisions API.
- **Images:** only `nexus_browser_judge_visual`, with the operator's explicit
  opt-in (a fresh confirmation each time it is switched on). Somente Luna names
  OpenAI in that confirmation; Automatic names Cloudflare and, as fallback, OpenAI.
  That fallback does not run when the caller asked for Clef and Clef has no
  credential: the image route is empty. Luna still judges images in Automatic
  without an explicit Clef request, in Somente Luna, and in Juntos.

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

## Linux: identidade de desktop e backend do cofre (F-728 / F-729)

- **Entrada de menu do ZIP portátil.** `src/main/linux-desktop-entry.ts` escreve
  `$XDG_DATA_HOME/applications/nexus-ide.desktop` (e, se o caminho do binário
  tiver espaço ou caractere reservado, o symlink
  `$XDG_DATA_HOME/nexus-ide/nexus-ide`) antes de registrar `nexus://`, e
  garante a linha do handler em `$XDG_DATA_HOME/applications/mimeinfo.cache`
  (`update-desktop-database`, ou mescla da própria linha sem tocar nas dos
  outros). São os únicos arquivos que o app grava fora de `~/.nexus` e do
  `userData` por conta própria. Regras: só no build empacotado e fora do smoke;
  só substitui arquivo que carrega o marcador `X-NexusIDE-Portable=true`; o que
  EXISTE e não é arquivo comum pequeno (symlink de gerenciador de dotfiles,
  FIFO, arquivo enorme, sem permissão) é do operador e não é lido como "ausente"
  nem substituído, vale para a entrada e para o índice; entrada feita à mão e
  arquivo comum no lugar do symlink do lançador também não são tocados; escrita
  por temporário + `rename`, nunca através de um symlink; caminho com caractere
  de controle não é registrado. "Instalação por pacote" é só
  `/usr/lib/` e `/usr/lib64/`: um ZIP extraído em `/usr/local` ou `/opt` é
  portátil. O `Exec` nunca passa por shell: é um caminho absoluto cru, ou a
  forma entre aspas da Desktop Entry Specification.
- **O handler não amplia a superfície do deep link.** `nexus://` continua
  passando por `parseDeepLink` (hosts em lista fechada) e `open`/`license`
  vindos de URL continuam exigindo o diálogo nativo. A mudança só faz o link
  chegar ao app no Linux, como já chegava no macOS e no Windows.
- **Backend do cofre.** `src/main/linux-secret-store.ts` pede
  `--password-store=gnome-libsecret` sempre que o `XDG_CURRENT_DESKTOP` não
  traz um literal exato que o Chromium protege sozinho (KDE, GNOME, XFCE…),
  porque ele cai em `basic_text` em qualquer outro (Hyprland, sway, LXQt…).
  `KDE_FULL_SESSION`/`DESKTOP_SESSION` herdados de um login KDE não contam. A
  recusa de `basic_text` em `isSecureStorageBackendAllowed` não mudou: sem
  Secret Service o cofre continua indisponível, nunca vira texto plano. Um
  `--password-store` explícito do operador tem precedência; depois dele,
  `NEXUS_LINUX_PASSWORD_STORE` (`kwallet5`, `kwallet6`, `kwallet`,
  `gnome-libsecret`) escolhe o backend. Não verificado: com
  o chaveiro TRAVADO no boot (autologin sem desbloqueio por PAM) o libsecret
  pode esperar um diálogo de desbloqueio; no macOS esse bloqueio do Main
  existiu, por isso o cofre não é sondado cedo demais lá.
- **Links `nexus://` em rajada.** Cada link `open`/`license` vindo de URL abre um
  diálogo nativo síncrono, um depois do outro. Não há coalescência, como no
  macOS e no Windows; é incômodo, não escalada de privilégio. O Chrome ainda
  pergunta antes de abrir o esquema.

## Sandbox de processo no Linux: toolchain do PATH (F-732 / F-733)

- O Bubblewrap cobre `/home`, `/root`, `/tmp`, `/var/tmp`, `/run/user`, `/mnt` e
  `/media` com tmpfs. `collectLinuxToolchainMounts` (`process-sandbox.ts`)
  devolve, SOMENTE-LEITURA, o que o PATH resolve sob essas raízes: o diretório
  de cada entrada, o alvo real de cada executável e, para node/npm/npx/
  corepack/pnpm/yarn, a árvore do runtime. É a mesma política que
  `collectToolchainReadRules` aplica no Seatbelt. Sem isso, Node instalado por
  mise/nvm e `~/.local/bin` não existiam dentro do sandbox.
- Nunca é montado: uma raiz mascarada, o home, um ancestral do home, um caminho
  que contenha o workspace/runtime/mount suplementar, nem um caminho dentro
  deles (ficaria somente-leitura). Entrada larga demais é descartada inteira,
  com o que há dentro. Teto de 512 mounts; entrada relativa ou symlink é
  ignorada.
- **Diretórios protegidos (revisão independente de 02/10).** A árvore de runtime
  do Node vem de `lastIndexOf('/bin/')`; um `node` real em `~/.local/bin/node`
  (`n` com `N_PREFIX=$HOME/.local`) virava `--ro-bind ~/.local ~/.local` e
  entregava `~/.local/share` (keyrings, auth das CLIs) ao agente, provado com
  `bwrap` real. Agora nenhum mount pode ser igual ou ancestral de
  `LINUX_PROTECTED_HOME_DIRS` (`.ssh`, `.gnupg`, `.nexus`, `.aws`, `.kube`,
  `.docker`, `.config`, o estado das CLIs de IA, `.local/share`, `.local/state`
  e os `XDG_*_HOME`), nem ficar DENTRO de `.ssh`, `.gnupg`, `.nexus`, `.aws` ou
  `.kube`. Uma CLI de IA nova que guarde credencial em `~/.<nome>` entra na
  lista. Limite honesto: um symlink dentro de um diretório do PATH do operador
  monta o alvo dele; isso depende de o PATH não ser gravável por agente.
- O PATH que decide esses mounts é o do OPERADOR. `nexus_terminal_run` não
  aceita mais `env.PATH` de quem chama (`CALLER_ENV_KEYS`): com ele, um agente pedia `PATH=~/.ssh` e o perfil —
  Seatbelt no macOS, e agora os mounts no Linux — liberava a leitura desse
  diretório. Quem adicionar um caminho novo de execução sandboxed precisa
  garantir a mesma coisa: `env.PATH` do plano nunca vem de entrada de agente.

## Linux: atualização automática assinada do pacote portátil (F-940)

O ZIP portátil (`install.sh`, Arch/Omarchy) se atualiza sozinho. É código baixado da rede e executado
como o usuário, então o GitHub sozinho não é a raiz de confiança.

- **Raiz de confiança:** uma chave Ed25519 de atualização. A pública está embutida em
  `src/main/linux-update-signing.ts` (lista, para rotação: a chave nova entra numa versão assinada pela antiga e
  só depois a antiga sai). A privada vive só em `~/.config/nexus-release/linux-update-ed25519.pem` (0600) de quem
  publica, fora do repositório e fora do container de build; `scripts/sign-linux-update.mjs` recusa chave legível
  por outros e chave cujo id o app não conhece.
- **O que é assinado:** o `SHA256SUMS-linux-x64.txt` (`.sig`, base64). O app só confia no ZIP cujo SHA-256 consta nesse
  arquivo assinado; o formato é rígido (`<64 hex>␣␣<nome>`, sem barra, sem duplicata, ≤ 4 KB).
- **Origem:** o app MONTA as URLs (`https://github.com/<repo conhecido>/releases/download/v<versão>/<nome>`); nada da
  resposta da API vira URL. Tag e versão precisam casar (`v0.76.198` ↔ `0.76.198`).
- **Sem downgrade:** só entra versão maior que a instalada. Sem `.sig`, sem assinatura válida ou ZIP fora da lista: recusa e
  a instalação atual fica intacta.
- **Extração própria** (`linux-zip-extract.ts`, o mesmo contrato do `scripts/extract-linux-zip.py`): raiz única, sem
  `..`, caminho absoluto, duplicata, arquivo especial, link que escape ou passe por link, ZIP64/criptografia; tetos de
  entradas, tamanho e razão de compressão; CRC32 e tamanho conferidos; o executável precisa ser ELF x86-64.
- **Troca:** um script constante (`APPLY_SCRIPT`) espera o PID sair, move `<pasta>` para `<pasta>.old` e `<pasta>.new` para
  `<pasta>`, desfaz se a segunda troca falhar e reabre o app. Só roda com a pasta nova irmã do destino. A `.old` some depois
  de 90 s de vida da versão nova.
- **Não cobre:** DEB e RPM (root; canal manual) e a conta do dono do repositório de releases ser comprometida JUNTO com a
  chave privada. Perder a privada exige uma versão nova assinada por outra chave que o app já conheça (por isso a lista).

## Linux: repositórios apt e dnf assinados (F-942)

- **Quem assina:** uma chave GPG RSA 4096 só de repositório (`EFFD5CAE…E2518740`, expira em 2031-10-04), distinta da
  chave Ed25519 do auto-update do ZIP (F-940). A privada fica em `~/.config/nexus-release/gnupg` (0700), fora do repositório
  e fora de qualquer container; `scripts/build-linux-repo.sh` só assina no host e confere a assinatura com um chaveiro novo
  que só tem a pública antes de qualquer upload.
- **O que é assinado:** `InRelease`/`Release.gpg` (apt) e `repomd.xml.asc` (dnf). Os índices carregam o SHA-256 de cada
  pacote, então a integridade do `.deb` vem do `Release` assinado. O RPM não é assinado (`gpgcheck=0`, `repo_gpgcheck=1`).
- **O Worker não é confiável para conteúdo:** ele só redireciona (`site/src/downloads/repo.js`) para os assets da release
  Linux mais nova do catálogo validado, e só para nomes de uma lista fechada. Se o Worker ou o GitHub entregarem outro
  arquivo, o apt/dnf recusam por hash ou por assinatura.
- **Opt-in:** só `install-repo.sh` altera repositórios do sistema (`/etc/apt/keyrings`, `sources.list.d`, `yum.repos.d`); o
  `install.sh` comum continua sem tocar neles. O ativador confere a impressão digital da chave quando há `gpg` e tem `--remove`.

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

Autopilot workers may use native subagents and the browser tools of their own
mission. Claude/OpenClaude Task restrictions are computed at spawn — for governed
or read-only panes and for the orchestrator — rather than attached to every
adapter invocation. Native subprocesses inherit their pane's existing authority;
this change does not grant cross-workspace access or a global MCP profile.

Browser ownership is derived in Main from an exact project scope and a live PTY
or ACP session. ACP proof includes its Main-owned runtime binding, account,
provider, incarnation and coordination/execution scopes. A headless caller needs
a unique live mission coordinator; stale, ambiguous or substituted bindings fail
closed. A worker drives the browser panes of its OWN mission in that window; the
operator's tabs and other missions' tabs stay out of reach (`pane-authz`). The
operator's renderer hand (Jarvis/`mcp:invoke`, role `user`, no PTY session) keeps
the operator's reach, bounded by the exact scope. Personal-profile image export
still requires its existing isolation/consent rules; agent-opened tabs are
isolated unless the operator turned on sharing.

`nexus_computer_do` stays with the operator's own pane and the orchestrator
(`assertMayDriveDesktop`): a worker may have been steered by web content, and in
an approved mission there is no per-goal modal, so the role check is the barrier.
The loop keeps macOS availability, Accessibility permission, focus checks,
sensitive-field refusal and irreversible-action handback.

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

## Bloqueio de missão preserva o coordenador (F-253)

`authority-revoked` ainda encerra os workers, mas conserva o coordenador exato
para conversa/recuperação quando a missão está `blocked_user` ou
`blocked_technical`, a revisão mantém seu contrato aprovado e despachado,
e não existe encerramento vigente pelo operador. A sessão precisa coincidir
com `orchestratorSessionId`, ter spec persistida e autoridade física sem
ambiguidade; órfãos não ganham a exceção. Isso não concede autoridade de efeito:
o gate de intenção continua recusando execução/despacho até a retomada.
`operator-close`, restart, hibernação e missões done/failed não usam a exceção.
A demotion conserva o ponteiro do coordenador retido; Encerrar usa razão
explícita e exige a mesma prova de saída física de antes.

## Preferências de decisão duráveis (F-421)

`~/.nexus/decision-models.json` é a projeção legada de modo, modelo Clef, Account ID
e consentimento visual. Não contém token: este permanece no cofre. Com uma conta
autenticada, a autoridade é `~/.nexus/decision-accounts.json`: uma linha por id
de conta. Conta sem linha própria não recebe a escolha de outra. Livro vazio
reivindica a projeção uma vez, para o primeiro login. Logout volta a projeção
ao padrão Jev e não apaga as outras linhas. Sem conta (antes do login) a
projeção legada continua valendo para o operador desta máquina. O schema
continua desligando visão em Somente Jev; Somente Luna e Juntos podem manter o
consentimento. Carregar uma cópia antiga de settings.json não reativa
consentimento. Migração só cria o arquivo ausente
com uma seção legada validada; arquivo próprio válido prevalece sobre a cópia
de compatibilidade em settings.json. Escritas de áudio, tema e demais opções
não regravam essa autoridade. Sob Vitest ambos os arquivos ficam no diretório
isolado de testes, nunca no perfil real do operador.

Se o arquivo próprio existir, mas não validar, uma cópia antiga não pode
reativar egress: o Account ID válido pode ser recuperado dela, mas o modo
fica Jev e a visão desligada até uma gravação explícita do operador.
