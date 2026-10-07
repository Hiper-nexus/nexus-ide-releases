# Remote Ops (Fase 5) — companion thin client

Nexus **não** embute o React Native do Orca. O caminho de produto é o **thin client PWA** servido pela remote bridge (HTTPS + WebSocket), com pairing por código.

## Stack

| Peça | Path |
|------|------|
| Bridge TLS + WS | `src/main/remote/remote-bridge.ts` |
| Tailscale Serve (tailnet HTTPS) | `src/main/remote/tailscale.ts` + `remote-bridge-tailscale.ts` |
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
2. Telemóvel: abrir a URL HTTPS da bridge. Com **Publicar no tailnet (HTTPS)**
   ligado, use `https://<máquina>.<tailnet>.ts.net/` (certificado válido, sem
   aviso). Em rede não confiável, não ignorar aviso de certificado da URL da
   LAN: prefira o endereço do tailnet.
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

Para LAN hostil, use o **Tailscale Serve** (abaixo) em vez da URL self-signed
da LAN. TOFU automático no PWA seria apenas um valor entregue pelo mesmo canal
potencialmente interceptado e, por isso, não foi implementado nem anunciado
como controle de segurança. O PWA continua **sem pinning** também no tailnet:
a confiança passa a ser a CA pública do certificado `*.ts.net` + a identidade
de nó do WireGuard do Tailscale, não um fingerprint verificado pelo cliente.

## Tailscale Serve (tailnet HTTPS)

Toggle **Publicar no tailnet (HTTPS)** no card *Celular na rede local*. Nasce
ligado quando a CLI do Tailscale existe e está logada com MagicDNS, e só age
quando você clica em **Iniciar** (ação explícita). Com ele:

- a bridge anuncia primeiro `https://<máquina>.<tailnet>.ts.net/` e
  `wss://<máquina>.<tailnet>.ts.net` (rótulo *Tailscale HTTPS*); IPs
  100.64.0.0/10 da lista de LAN aparecem como *Tailscale IP*;
- o Nexus roda `tailscale serve --bg --https=443 https+insecure://127.0.0.1:<porta>`
  (a bridge é TLS self-signed; o Serve termina o TLS válido e encaminha ao
  loopback). Funciona até com o bind padrão `127.0.0.1` — não precisa expor a
  bridge na LAN nem abrir porta no roteador; o acesso segue as ACLs do tailnet;
- parar a bridge e sair do app rodam `tailscale serve --https=443 off`
  (tolerando "handler does not exist"). Um marcador em
  `~/.nexus/remote-bridge/tailscale-serve.json` deixa o próximo boot remover o
  handler que um crash tenha deixado — só se ainda for o proxy exato do Nexus;
- se a porta 443 do Serve já tem outra configuração, o Nexus **não** a
  substitui nem desliga (diagnóstico *porta em uso*);
- o binário vem de caminhos absolutos fixos (macOS:
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, depois Homebrew e
  `/usr/local/bin`), sem shell; `execFile` com timeout, `SIGKILL`, `maxBuffer`
  1 MiB e `LANG=C`. stderr da CLI nunca é logado nem enviado por IPC (carrega
  `tskey-…` e nomes de nós): só rótulos fechados como `not-logged-in`;
- após o Serve, um probe `GET /manifest.webmanifest` (rota pública, sem
  estado, `redirect: 'error'`, 2,5 s) decide entre *disponível* e *requer
  configuração* (ex.: certificado HTTPS ainda sendo emitido ou HTTPS
  desligado no painel do tailnet).

O pareamento por aparelho continua obrigatório: o tailnet é transporte, não
autenticação. A checagem de Origin continua same-origin pelo `Host` (o Serve o
preserva); `X-Forwarded-*` e `Tailscale-User-*` **não** são aceitos como prova de
origem nem de identidade — qualquer processo local poderia forjá-los. Atrás do
Serve todo cliente chega como loopback, então o rate limit e o bloqueio de
pareamento por IP passam a ser compartilhados pelos aparelhos do tailnet.

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
