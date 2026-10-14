# Nexus Relay (Cloudflare)

Relay cego do companion mobile em `wss://relay.nexuside.app`: Worker `nexus-relay`
com um Durable Object por sala (`idFromName(roomId)`, WebSocket Hibernation API).
Substitui o serviço `nexus-relay` da Railway (`server/src/relay/server.ts`) com o
mesmo protocolo. O relay recebe ciphertext e o roomId; não decifra nem guarda ou
registra conteúdo, chave ou token (os invocation logs estão desligados porque a
URL carrega o roomId).

## Protocolo

- `GET /r/<roomId>?role=host|guest` com `Upgrade: websocket`; `roomId` casa
  `[A-Za-z0-9_-]{10,64}`. Sem upgrade: 404. Ordem do filtro, igual à Railway:
  limite por IP (429), Origin fora de `RELAY_ALLOWED_ORIGINS` (403, antes do
  path; cliente sem Origin, como o desktop, passa), rota ou papel inválido (404).
- O host cria a sala. Segundo host: close 4009. Guest sem sala: 4004. Guest além
  de `RELAY_MAX_PEERS_PER_ROOM`: 4029. Acima de `RELAY_MAX_ROOMS` salas abertas:
  101 + 4029 `relay at capacity` (contador global no DO `RelayRegistry`).
- Frames binários `[4B uint32 BE peerId][selado]`. Do host: peerId 0 vai a todos
  os guests, N só ao guest N, sem alteração. Do guest: o relay grava o peerId do
  remetente nos 4 primeiros bytes e entrega ao host. Binário com menos de 4 bytes
  ou qualquer frame (TEXT em bytes UTF-8) acima de `RELAY_MAX_FRAME_BYTES`: close
  1009 em quem mandou. Mais de `RELAY_MAX_MESSAGES_PER_SECOND` numa janela de
  1 s: 1008.
- TEXT de controle: ao host `{"t":"peer-joined","peer":N}` e
  `{"t":"peer-left","peer":N}`; ao guest `{"t":"room-closed"}` seguido de close
  4001. TEXT vindo de cliente não é encaminhado nem renova o TTL.
- Sala sem frame binário por `RELAY_ROOM_TTL_MS`: guests 4001 `room closed`, host
  4001 `idle timeout`.

## Conexão meio-aberta

A rede pode cair sem close. Cada conexão guarda quando mandou o último frame, e o
runtime guarda o último ping:

- Heartbeat: Workers não manda ping de protocolo. O cliente manda o TEXT
  `{"t":"ping"}` e o runtime responde `{"t":"pong"}` sem acordar o DO. Quem já
  pingou e passa 2 × `RELAY_HEARTBEAT_MS` calado cai com 1001 (o host leva a
  sala). O desktop pinga a cada 20 s desde o F-1487.
- Vaga ociosa, para quem não pinga (desktop até 0.76.251, PWA) e para quem caiu
  antes do primeiro ping: host calado há mais de `RELAY_IDLE_TAKEOVER_MS` cede a
  sala ao próximo host, e guest calado há esse tempo cede a vaga ao próximo
  guest quando a sala está cheia. Quem sai leva 4008; host ativo segue
  protegido por 4009 e sala cheia de guests ativos segue dando 4029.

O alarme da sala acorda só no primeiro prazo real (TTL ocioso, heartbeat de quem
pinga, fim da janela de quem acabou de entrar), recalculado em cada entrada e em
cada alarme (`src/schedule.ts`). A vaga no teto de salas é adquirida quando o
host entra, renovada no alarme e devolvida quando a sala fecha; sala que some sem
close (deploy, queda) devolve a vaga no próximo alarme, e o aluguel de
2 × `RELAY_ROOM_TTL_MS` é o último recurso.

## Rodar

Usa as dependências da raiz do monorepo (`npm ci` na raiz) e o Wrangler via `npx`.

```sh
cd relay-worker
npm test            # sobe `wrangler dev` (workerd local): protocolo, teto de salas, ponta a ponta
npm run typecheck
npx wrangler@latest deploy
node scripts/probe-relay.mjs wss://relay.nexuside.app   # sonda sintética em produção
```

`RELAY_TEST_URL=<ws(s)://…> npx tsx --test tests/companion-e2e.test.ts` roda o
ponta a ponta contra um relay já publicado; as suítes de protocolo e de teto
precisam das variáveis curtas que o `wrangler dev` delas recebe.
`npx wrangler@latest types --strict-vars=false` regenera
`worker-configuration.d.ts` depois de mudar `wrangler.jsonc`.
