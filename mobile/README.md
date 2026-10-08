# Nexus Mobile

App Expo (React Native) companheiro do desktop. O mesmo app fala dois protocolos e o
tipo do host vem do QR de pareamento:

| Host | Transporte | QR |
|------|------------|----|
| **Desktop Nexus** | Remote Bridge: HTTPS/WSS, chave do aparelho ECDSA P-256 (Keychain/Keystore) e desafio assinado a cada conexão | `https://<máquina>.<tailnet>.ts.net/#code=XXXXXXXX` |
| Desktop Orca (legado, herdado do fork) | `ws://<ip>:6768` com E2EE tweetnacl; relay `wss://<cell>/v1/connect/<hostId>` | `orca://pair?...` |

## Parear com o desktop Nexus

1. No desktop: **Configurações › Celular na rede local**. Ligue **Publicar no tailnet
   (HTTPS)** e clique em **Iniciar**. O card mostra o código e o QR
   `https://<máquina>.<tailnet>.ts.net/#code=…` (certificado público do Tailscale Serve).
2. O celular precisa estar no mesmo tailnet (app Tailscale logado).
3. No app: **Pair → escaneie o QR** (ou cole a URL inteira em *Paste code*). O app gera a
   chave do aparelho uma vez, assina `nexus-remote-pair-v1:<código>` e recebe o token, que vai
   para o Keychain/Keystore. O código vale para um aparelho e cinco minutos; para outro
   aparelho, use **Girar código de pareamento** no desktop.
4. Cada reconexão pede `auth.challenge` e responde `auth` com o desafio assinado — copiar só o
   token para outro aparelho não autentica. Queda de rede reconecta sozinha (backoff
   exponencial de 1 s a 30 s; voltar o app para a frente tenta na hora).
5. Revogar os tokens no desktop (ou o token expirar em 7 dias) leva a tela do host para
   **Parear de novo**, sem ficar em loop de reconexão.

**Por que não a URL da LAN.** A bridge na rede local usa certificado autoassinado. O WebSocket
do React Native só aceita certificado em que o sistema confia e não deixa o JavaScript fixar
impressão digital, então o app recusa o QR com IP/`localhost` e explica como ligar o Tailscale
Serve — aceitar sem verificar seria MITM aberto. O PWA *Nexus Remote* (abrir a URL no
navegador do celular) continua sendo a alternativa para a LAN pura.

**O que funciona com o desktop Nexus:** status do host; lista de panes e missões
(`ops.snapshot`); terminal ao vivo (`pane.stream.open` + `pane.read`, cura de lacuna por
releitura); envio de **um comando completo** com Enter (`pane.input`, até 8 KB; comandos
fora da lista de rotina pedem confirmação no desktop); fechar pane; aprovações pendentes com o
card estruturado (push `approvals.changed` + `agentSession.respondToApproval` — decisão para
o broker, nunca tecla no PTY).

**Git e arquivos do pane, só leitura (F-1014):** no detalhe de um pane, **Alterações** mostra o
`git status` do checkout DESSE pane (a worktree do worker, quando ele tem uma) e abre o diff de
cada arquivo com o componente de diff do app; **Arquivos** navega pelas pastas e abre um arquivo
para leitura. Comandos da bridge: `git.status`, `git.diff`, `files.list`, `files.read` (o
adaptador também aceita os nomes do Orca: `worktree: id:<pane>`, `filePath`, `relativePath`).
O desktop decide tudo: o pane precisa ser visível ao aparelho; o caminho é relativo, sem `..`,
e todo link simbólico no caminho precisa resolver (`realpath`) para dentro da raiz real do
checkout; `.git/` e arquivos de segredo (`.env*`, chaves, `credentials.json`…) são recusados;
leitura e diff são cortados em 256 KB com `truncated: true`; binário vem como `binary`. Sem
stage, commit, checkout nem escrita.

**Não disponível em host Nexus** (a tela avisa e o adaptador responde
`nexus_host_unsupported` com "… não disponível em host Nexus"): teclas cruas (Ctrl-C, Esc,
"1"…) — o desktop recusa entrada parcial e caracteres de controle de propósito
(`authorizeRemotePaneInput`, no Main, vale para qualquer cliente; o aviso no app é só UX e
evita a ida à bridge); escrita no Git e em arquivos (stage, commit, edição), worktrees, abas de sessão,
contas, voz/ditado, screencast do navegador, Linear/GitHub/GitLab, notificações push e o chat
nativo estruturado. O relay do companion (`/r/<roomId>`) ainda não é usado pelo app.

Código: `src/transport/nexus-bridge-{client,device-key,device-store,pairing,pair-host,rpc-adapter,git-files}.ts`,
`src/nexus-host/NexusHostScreen.tsx` e `src/nexus-host/NexusPaneWorkspace.tsx`; no desktop,
`src/main/remote/remote-workspace-rpc.ts`. Prova de ponta a ponta contra a bridge real:
`src/main/remote/remote-bridge.mobile-app.test.ts` (raiz do repositório).

## Desktop Orca (protocolo legado)

Local development against an Orca desktop uses two processes:

- Orca desktop/Electron from the repo root. This hosts the mobile WebSocket RPC server on port `6768`.
- Expo Metro from `mobile/`. This serves the React Native app on port `8081`.

Unless a command says otherwise, run mobile app commands from the `mobile/` directory.

## Prerequisites

- Node.js 24+
- pnpm
- Xcode and/or Android Studio tooling for simulator or device builds
- Expo Go on your phone, or a development client build when native modules are needed
- Phone and desktop on the same LAN when testing a physical phone

## Start Desktop Orca

From the repository root:

```bash
pnpm install
pnpm dev
```

Confirm the mobile RPC server is listening:

```bash
lsof -nP -iTCP:6768 -sTCP:LISTEN
```

Restart `pnpm dev` after changing Electron main-process code. Metro hot reload only applies to the mobile JavaScript bundle.

## Start The Mobile App

```bash
cd mobile
pnpm install
pnpm start
```

Scan the Expo QR code with your phone's camera on iOS, or Expo Go on Android.

For a native dev-client build:

```bash
pnpm exec expo run:android
pnpm exec expo run:ios
pnpm start --dev-client
```

## Pair With Desktop Orca

1. Open Orca desktop.
2. Go to Settings > Mobile.
3. Scan the pairing QR code from the mobile app.
4. Confirm the mobile host endpoint is `ws://<desktop-ip>:6768`.

For the Android emulator, use `ws://10.0.2.2:6768`. For a physical phone, use the desktop LAN IP, for example `ws://192.168.0.179:6768`.

If the phone has a stale host entry, remove it from the app and pair again.

## Development Paths

### Android Phone

1. Install Expo Go from Google Play
2. Run `pnpm start`, scan QR with Expo Go
3. For native modules: `pnpm exec expo run:android`
4. Run with `pnpm start --dev-client`

### iOS Simulator

1. Install Xcode from the App Store
2. Run `pnpm start --ios` to open in iOS Simulator

## Physical Phone Debugging

The phone can be inspected through the connected device tooling:

```bash
orca snapshot --json
orca click --element @e3 --json
orca fill --element @e1 --value "ls" --json
orca screenshot --json
```

Use `snapshot` first to find the current element refs, then click/fill those refs. After mobile file edits, Metro usually hot reloads automatically, but navigating out of and back into the session screen can be useful because it re-runs `terminal.subscribe`.

## Terminal Streaming Repro Without A Phone

Use this when terminal output does not render on device and you need to split server streaming bugs from WebView/UI bugs:

```bash
cd mobile
ORCA_MOBILE_WS_URL=ws://127.0.0.1:6768 pnpm exec tsx scripts/test-subscribe.ts <deviceToken> <serverPublicKeyB64>
```

You can pass a worktree selector as the third argument:

```bash
pnpm exec tsx scripts/test-subscribe.ts <deviceToken> <serverPublicKeyB64> "id:<worktreeId>"
pnpm exec tsx scripts/test-subscribe.ts <deviceToken> <serverPublicKeyB64> "path:/absolute/worktree/path"
pnpm exec tsx scripts/test-subscribe.ts <deviceToken> <serverPublicKeyB64> "name:my-worktree"
```

The expected result includes:

```text
streamSawMarker: true
readSawMarker: true
```

If this repro fails, debug the desktop runtime/PTY path before the mobile WebView. If it passes but the phone is blank, debug the session screen or `TerminalWebView` readiness/queueing path.

## Terminal Color Repro Without A Phone

Use this when terminal colors disappear after switching tabs. Open a Claude Code terminal and at least one other terminal in the target worktree, then run:

```bash
cd mobile
ORCA_MOBILE_WS_URL=ws://127.0.0.1:6768 pnpm exec tsx scripts/repro-terminal-colors.ts \
  <deviceToken> <serverPublicKeyB64> "id:<worktreeId>"
```

The script captures `terminal.subscribe` snapshots in an A → B → A sequence and writes raw snapshots to `mobile/terminal-color-repro/`. If the two A snapshots have different `sgrColor` counts, the desktop snapshot changed during the switch. If they match, the ANSI color data is still present and the bug is in mobile replay/rendering.

## Validation

Run these checks before committing mobile terminal changes:

```bash
cd mobile
pnpm exec tsc --noEmit
pnpm lint
cd ..
pnpm typecheck:node
```

## Protocol Version Compatibility

Mobile and desktop talk over a versioned protocol. Because mobile updates lag desktop by 24-48h via the App Store, both sides exchange version numbers on `status.get` so a genuinely incompatible combo can hard-block instead of silently misbehaving.

Constants live in two files (Metro can't resolve outside `mobile/`):

- `src/shared/protocol-version.ts` — `DESKTOP_PROTOCOL_VERSION`, `MIN_COMPATIBLE_MOBILE_VERSION`
- `mobile/src/transport/protocol-version.ts` — `MOBILE_PROTOCOL_VERSION`, `MIN_COMPATIBLE_DESKTOP_VERSION`

Today all four are set so `evaluateCompat` always returns `{ kind: 'ok' }` — nothing blocks. The wire format is in place to flip a switch when needed.

### When to bump

Bump `DESKTOP_PROTOCOL_VERSION` (and the mobile mirror `MOBILE_PROTOCOL_VERSION` when relevant) for **breaking** changes:

- Removed RPC method or required parameter that mobile uses
- Changed meaning (units, nullability) of an existing field mobile reads
- Changed encryption, framing, or auth handshake

Do **not** bump for additive changes:

- New RPC methods
- New optional fields on existing methods
- New event types in `terminal.subscribe`

Set `MIN_COMPATIBLE_MOBILE_VERSION` (kill-switch) when desktop ships a change that requires a minimum mobile version to function safely. Same for `MIN_COMPATIBLE_DESKTOP_VERSION` from the mobile side.

When a verdict is `blocked`, `mobile/src/components/ProtocolBlockScreen.tsx` renders a screen pointing the user at either the App Store (mobile too old) or GitHub Releases (desktop too old).

To exercise the block screen locally: set `MIN_COMPATIBLE_DESKTOP_VERSION = 999` in `mobile/src/transport/protocol-version.ts`, rebuild, pair to any desktop. Revert before merging.

## Mock Server

Develop the mobile app without a running Orca desktop instance:

```bash
pnpm mock-server           # starts mock WebSocket server on port 6768
```

Connect from the app using endpoint `ws://localhost:6768` and token `mock-device-token`.

### Environment variables

- `MOCK_NATIVE_CHAT=1` — serve the native-chat scenario (one live agent tab, empty transcript, image upload) instead of the default terminal fixtures.
- `MOCK_CHAT_AGENT=omp` — with `MOCK_NATIVE_CHAT=1`, present an OMP tab and four decoded transcript messages, including a tool call and result, instead of the default Claude scenario. It deliberately omits `transcriptPath` to exercise legacy-hook readability discovery; current OMP hooks may report a path.
- `MOCK_SERVER_KEY_FILE` — persist the server keypair across restarts so a paired device keeps its public-key pin. A missing or invalid file is re-keyed with a warning, which forces a re-pair.

### Scenario control files

Read on every request, so behaviour can be flipped mid-session without a restart (a restart would re-key E2EE and force a re-pair). Write the mode into the file, or delete it for the default.

- `MOCK_SEND_MODE_FILE` (default `orca-mock-send-mode` in the system temporary directory) — `accept` (default) accepts the send, `error` fails it with `mobile_input_floor_unavailable`, anything else reports the send as rejected.
- `MOCK_TERMINAL_LIST_MODE_FILE` (default `orca-mock-terminal-list-mode` in the system temporary directory) — `omit` returns an empty terminal list, `other` returns a list that omits the chat handle, anything else lists it.
- `MOCK_TERMINAL_STREAM_MODE_FILE` (default `orca-mock-terminal-stream-mode` in the system temporary directory) — `dead` answers a subscribe with `subscribed` then `end` (a gone PTY), which is what exercises the rearm bound and terminal prune; anything else streams normally.

## Connecting to Real Orca

1. Start Orca desktop with WebSocket transport enabled
2. In Orca, go to Settings > Mobile and scan the QR code with this app
3. The QR encodes the connection endpoint, device token, and TLS fingerprint

## Project Structure

```
mobile/
├── app/                   # Expo Router screens (file-based routing)
│   ├── _layout.tsx        # Root layout with navigation stack
│   ├── index.tsx          # Home screen — paired hosts list
│   └── pair-scan.tsx      # QR code scanning screen
├── src/
│   ├── terminal/          # Terminal WebView and xterm bridge
│   └── transport/         # WebSocket RPC client
├── scripts/
│   ├── test-subscribe.ts  # Desktop streaming repro without a phone
│   └── mock-server.ts     # Standalone mock WebSocket server
└── assets/                # App icons and splash screen
```
