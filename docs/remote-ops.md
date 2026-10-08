# Remote Ops (Fase 5) — companion thin client

Dois clientes falam com a remote bridge (HTTPS + WebSocket), com pairing por código: o **thin client PWA** que a própria bridge serve e o **app Expo** de `mobile/` (F-994, seção abaixo). O protocolo do Orca que o app herdou continua no app para hosts Orca; o desktop Nexus não o serve.

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
mensagem. Teclas de controle (C0 exceto Tab/LF, DEL, C1 — inclui ESC e toda
sequência CSI/OSC, Ctrl-C, CR solto) são **recusadas no Main**, em
`authorizeRemotePaneInput`, para todo caminho remoto que escreve em PTY: bridge
WSS (app e PWA) e relay `/r/<room>` (o mesmo `handleAuthedMessage`). CRLF é só
fim de linha (vira LF); Tab é aceito mas tira a linha da allowlist (vai ao
diálogo). O bloqueio no app (`nexus-bridge-rpc-adapter.ts`) é só aviso de UX;
a autoridade é o desktop (F-1000). Escritas estruturadas (`git.push`, `fs.delete`,
`mission.complete`…) não têm comando na bridge: desde F-1022 são recusadas na
checagem central (`unknown command: <tipo>`) antes de qualquer diálogo no desktop;
`mission.complete` segue **sempre negado** no mobile porque a evidência fica no desktop.

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

## Escopos por aparelho (MOB-12, F-1022)

Cada aparelho pareado tem um grant com `scopes` (`src/main/remote/remote-device-token-store.ts`,
em `~/.nexus/remote-bridge/tokens.json`, junto do token e da chave do aparelho):

| Escopo | Libera |
|------|------|
| `read` (Ver) | `mission.list`, `pane.read`, `pane.stream.open/close` (e o push `pane.stream.data`), `git.status`, `git.diff`, `files.list`, `files.read`; panes e missões no `ops.snapshot`/`panes.list` |
| `input` (Enviar comandos) | `pane.input`, `pane.resize` (e `pane.stream.frame`) |
| `approve` (Aprovar) | `agentSession.respondToApproval`; os pedidos pendentes aparecem no `ops.snapshot` com `read` **ou** `approve`; só aparelho com `approve` conta como respondente no broker |
| `close` (Fechar panes) | `pane.close` |

- **Onde é decidido:** um ponto só, no topo de `handleAuthedMessage`
  (`authorizeRemoteDeviceRequest`, `src/main/remote/device-scopes.ts`), antes de
  diálogo, autorização de pane ou escrita. Tipo fora da tabela = `unknown command:
  <tipo>` (fail closed); escopo faltando = `not authorized: scope-missing:<escopo>`.
  `status`, `ops.snapshot` e `panes.list` respondem a qualquer aparelho autenticado
  (o status é a sonda de vida do app), mas sem `read` voltam sem panes nem missões.
  O teste `device-scopes.test.ts` confere que a tabela e os `case` do dispatch são os
  mesmos — comando novo sem escopo fica vermelho.
- **Pareamento:** em Configurações › Celular › *Celular na rede local*, o operador
  escolhe as permissões do próximo aparelho; elas valem para o código gerado em
  **Iniciar** ou **Novo código** (padrão: todas). O card mostra as permissões do
  código atual e a lista de aparelhos pareados, cada um com as suas chaves; mudar
  uma chave vale **no próximo pedido** do aparelho, sem reconectar (o dispatch lê o
  grant a cada mensagem; o push de saída para no próximo pedaço sem `read`).
- **Migração:** grant gravado antes do F-1022 (sem `scopes`) recebe todos os
  escopos de hoje; a próxima gravação do arquivo persiste isso. Grant com `scopes`
  malformado = nenhum escopo.
- **Revogação:** igual a antes (**Revogar acessos** apaga todos os grants e fecha
  as conexões). O `status` que o aparelho lê não traz a lista de aparelhos nem as
  permissões do código.
- **App:** a recusa por escopo vira o código `nexus_scope_refused` com frase em
  pt-BR ("Este aparelho não tem permissão para enviar comandos ao terminal…
  O operador libera em Configurações › Celular, no desktop."), e continua sendo
  recusa final (o outbox não reenvia).
- **Relay do companion** (`/r/<room>`): não tem grant por aparelho; passa pela mesma
  checagem com todos os escopos e mantém o próprio gate de escrita (`writeToken`).

## App Expo (`mobile/`, F-994)

O app trata o desktop Nexus como host `nexus-bridge`, separado dos hosts Orca. O
leitor de QR aceita `https://<host>[:porta]/#code=XXXXXXXX` (o QR do card *Celular na
rede local*) e o transporte é um porte em TS puro do lado cliente do PWA:
`mobile/src/transport/nexus-bridge-client.ts` (pair/auth.challenge/auth, pedidos,
pushes, reconexão com backoff), `nexus-bridge-device-key.ts` (ECDSA P-256 por
`@noble/curves`, chave privada no Keychain/Keystore do aparelho) e
`nexus-bridge-rpc-adapter.ts` (métodos do app → comandos da bridge; o que não tem
equivalente responde "… não disponível em host Nexus").

- **TLS:** o WebSocket do React Native só confia no que o sistema confia e não expõe
  a cadeia ao JS. Por isso o app **recusa** o QR com IP/`localhost` (certificado
  autoassinado da LAN) e pede o Tailscale Serve (`*.ts.net`, CA pública). Não há
  "aceitar mesmo assim". Para LAN pura sem tailnet, use o PWA no navegador.
- **Mapeamento:** `status.get`→`status`, `terminal.list`→`ops.snapshot`,
  `terminal.subscribe`→`pane.stream.open` + `pane.read`, `terminal.send` (com Enter)→
  `pane.input` com `messageId`, `terminal.updateViewport`→`pane.resize`,
  `terminal.close`→`pane.close`, `mission.list`, `agentSession.respondToApproval`
  (+ push `approvals.changed`). Teclas cruas, arquivos, Git, worktrees, abas, contas,
  voz, screencast e Linear/GitHub/GitLab ficam desabilitados com aviso. O aviso de
  teclas cruas no app é só UX: quem barra Ctrl-C/Esc/sequências de controle é o
  desktop (`authorizeRemotePaneInput`), para qualquer cliente — inclusive um app
  modificado.
- **Prova:** `src/main/remote/remote-bridge.mobile-app.test.ts` sobe esta bridge real
  em processo e conecta o cliente do app (importado por caminho) com o certificado
  fixado pela `certFingerprint`: pareia, autentica, lista, abre stream, envia uma
  linha, recebe a saída e responde uma aprovação.
- O relay do companion (`/r/<roomId>`) ainda não é usado pelo app.

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
origem nem de identidade — qualquer processo local poderia forjá-los.

Atrás do Serve todo cliente chega como loopback, então o IP não distingue
ninguém. Por isso:

- aparelho autenticado tem bucket de rate limit próprio, pela identidade
  comprovada no Main (`tokenId` após o desafio assinado) — um cliente não
  pareado não esgota o limite de quem já entrou;
- a pré-autenticação via loopback conta **por conexão** (60/min);
- as tentativas de pareamento via Serve contam **por peer do tailnet**
  (10/min e bloqueio após 8 códigos errados, que sobrevive à reconexão): a
  chave é `Tailscale-User-Login` (ou, em nó com tag, o IP de
  `X-Forwarded-For`). Um peer que esgota o próprio teto não nega o pareamento
  do aparelho do dono. Um teto global do proxy (240/min ≈ 1200 palpites por
  código de 5 min, em ~1,1e12) segue como rede contra força bruta em muitas
  partições; loopback sem partição (desktop local) divide um balde de 30/min
  com bloqueio por conexão;
- esses cabeçalhos são **só chave de partição**, nunca identidade nem
  autorização. Só valem com as três condições: socket de loopback (é por onde
  o Serve entrega), Serve publicado por **esta** bridge (sem ele não há proxy
  e o cabeçalho só pode vir de um processo local) e `X-Forwarded-For` único
  num IP do tailnet (100.64.0.0/10 ou fd7a:115c:a1e0::/48). O proxy do Serve
  (tailscaled, `ipnlocal/serve.go`) descarta o `X-Forwarded-For` de entrada e
  grava o IP do peer, e apaga `Tailscale-User-*` antes de gravar o login: o
  peer não os escolhe. Um processo local na porta loopback ainda os forja —
  por isso o teto global continua valendo (servePeerPartition em
  `remote-bridge.ts`);
- conexões diretas da LAN mantêm os limites por IP (nunca leem cabeçalho);
- o marcador do Serve é lido com `O_NONBLOCK|O_NOFOLLOW`, só como arquivo
  regular de até 4 KiB num diretório real do próprio usuário (FIFO, symlink
  ou `/dev/zero` plantados são ignorados; diretório não confiável publica sem
  marcador e avisa no log); se a consulta `serve status` falha, o dono do
  handler é desconhecido e **nada** é desligado — o marcador fica e a remoção
  é tentada de novo em 5 s, 30 s, 2 min e depois a cada 10 min, sem desistir,
  tanto no stop quanto no boot (o Nexus pode subir antes do Tailscale.app). O
  boot para quando limpou, quando o marcador sumiu ou quando o dono está vivo;
  nunca desliga um Serve que deixou de ser o proxy exato do Nexus. A nova
  tentativa confere na vez da fila se a bridge viva republicou o mesmo alvo
  (porta fixa) e, nesse caso, não desliga nada.

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
