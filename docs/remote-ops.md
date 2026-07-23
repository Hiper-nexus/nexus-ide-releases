# Remote Ops (Fase 5) — companion thin client

Nexus **não** embute o React Native do Orca. O caminho de produto é o **thin client PWA** servido pela remote bridge (HTTPS + WebSocket), com pairing por código.

## Stack

| Peça | Path |
|------|------|
| Bridge TLS + WS | `src/main/remote/remote-bridge.ts` |
| Thin client HTML | `src/main/remote/remote-client-page.ts` |
| Policy mobile RPCs | `src/main/remote/mobile-companion-policy.ts` (ligada em `handleAuthedMessage` via `mobileRpcKindForBridgeType`) |
| Pairing LAN ativo | `src/main/remote/remote-bridge.ts` + `remote-device-authority.ts` |
| Confirmação desktop | `src/main/remote/remote-desktop-confirmation.ts` (scheduler main-owned) |
| Primitiva challenge/proof isolada | `src/main/remote/device-pairing.ts` (não é o canal ativo nem E2EE) |
| IPC desktop | `src/main/remote/remote-ipc.ts` |

## RPCs de leitura (ops)

| type | Uso |
|------|-----|
| `ops.snapshot` | **Home phone**: missões + panes + summary |
| `mission.list` | Lista missões + contagens por status |
| `panes.list` | Panes visíveis do projeto |
| `pane.read` / `pane.input` | Terminal remoto; `pane.input` aceita comando completo (cap 8KB) |

Uma allowlist curta de comandos locais de baixo risco (`npm test`, `git status`)
segue fluida, sem modal. `pane.input` classifica cada linha pela política main
do Nexus; comando desconhecido/arbitrário, composto por operadores de shell,
destrutivo, deploy, publish ou efeito remoto exige confirmação **no desktop**.
O cliente nunca atesta a própria confirmação. Input binário/parcial é negado,
pois dividir `rm -rf` em vários frames contornaria qualquer classificador por
mensagem. Escritas estruturadas (`git.push`, `fs.delete`) usam o mesmo scheduler
main-owned; `mission.complete` é **sempre negado** no mobile porque a evidência
fica no desktop.

## Fluxo de uso

1. Desktop: iniciar Remote Bridge (Config / remote IPC).
2. Telemóvel: abrir a URL HTTPS da bridge. Em rede não confiável, não ignorar
   aviso de certificado: instalar/confiar uma CA local ou usar VPN identificada.
3. Inserir o código emitido pelo desktop. Ele aprova exatamente um aparelho:
   expirar ou consumir não gera outro; para um segundo aparelho, clicar em
   **Girar código de pareamento** no desktop.
4. Ecrã **Ops**: resumo + missões + panes; tocar pane → output + input.

## Relação com Orca mobile

Inspiração: home com hosts/stats + lista de trabalho.  
Implementação: thin client embutido (sem App Store lag), protocol versionável no bridge.

## Stream em tempo real e sessão persistente (feito)

- A bridge empurra `pane.stream.data` (frames do terminal-stream-protocol via
  `remote-output-bus`, tap único compartilhado com o relay do companion) para
  clientes que abriram `pane.stream.open` (resposta negocia `pushAvailable`;
  uma inscrição ativa por socket; `pane.stream.close` encerra). O cliente
  acompanha o cursor dedicado `pushSeq` — imune aos encodes de resposta de
  `pane.read`/`pane.input` — e backpressure derruba frames (nunca acumula
  buffer): o gap é curado com um único `pane.read` de reconciliação
  (debounced).
- O thin client consome os pushes e mantém o poll só como reconciliação
  (15 s com stream vivo; 2,5 s em bridges antigas sem push).
- O token fica em `localStorage`, mas deixou de ser uma credencial bearer
  suficiente. O aparelho gera ECDSA P-256; a chave privada não-extraível fica
  no IndexedDB e a bridge persiste apenas chave pública/fingerprint. Cada
  reload pede desafio aleatório single-use e exige assinatura. Copiar só o
  token para outro browser/aparelho falha. Revogação invalida server-side e o
  cliente apaga token + identidade local antes de voltar ao pareamento.

## Limite TLS do PWA (sem alegação falsa de pinning)

A bridge usa HTTPS/WSS com certificado self-signed e exibe
`certFingerprint` no desktop. Um PWA de navegador não recebe a cadeia ou o
fingerprint TLS do socket via Web APIs; portanto ele **não consegue implementar
certificate pinning nem channel binding verificável em JavaScript**. O código
não afirma que o vínculo ECDSA do aparelho resolve MITM: ele reduz roubo/replay
do token, mas a primeira visita continua dependendo da decisão de confiança do
navegador/OS.

Para LAN hostil, a opção segura continua sendo CA local confiável/VPN com
identidade ou um app first-party capaz de verificar fingerprint fora de banda.
TOFU automático no PWA seria apenas um valor entregue pelo mesmo canal
potencialmente interceptado e, por isso, não foi implementado nem anunciado
como controle de segurança.

## PWA e alertas locais (feito)

- O mesmo HTTPS da bridge serve `manifest.webmanifest`, service worker e ícone
  sem dependências externas. O shell é instalável e abre offline; autenticação,
  missão e terminal continuam exclusivamente no WebSocket autenticado.
- A navegação usa network-first e o cache contém somente o shell público. Token,
  output, snapshots e qualquer outro estado operacional nunca entram no cache.
- O botão **Ativar alertas locais** pede permissão por gesto explícito. Com o
  cliente aberto em segundo plano, transições observadas para `done` ou
  `blocked` geram aviso genérico, sem título nem conteúdo da missão na lock
  screen. Isto é alerta local por polling autenticado, não Web Push em background.

## Próximos passos

- Conta ativa no `ops.snapshot` (secret-free).
- Push também no caminho do relay (companion-relay-transport hoje mantém
  contrato request/response; o parâmetro `pushTarget` do
  `handleAuthedMessage` já aceita um sink futuro).
- Web Push em background só entra quando houver um serviço de push com modelo
  explícito de privacidade e revogação; não é necessário para o companion LAN.
