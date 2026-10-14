# Relay E2E no Cloudflare

O relay do celular é o Worker `nexus-relay` (pasta `relay-worker/`), com um
Durable Object por sala. Ele recebe o ciphertext dos frames e o roomId da URL,
mas não decifra nem registra conteúdo, chave ou token: só encaminha frames
selados fim a fim. Substitui o serviço `nexus-relay` da Railway (histórico em
`docs/deploy-relay-railway.md`), com o mesmo protocolo: rotas, regras de Origin,
códigos de fechamento, limites, TTL e encaminhamento cego. Os detalhes estão em
`relay-worker/README.md`.

## Publicação

```sh
cd relay-worker
npm test                     # workerd local: protocolo, teto de salas, desktop + PWA reais
npx wrangler@latest deploy
node scripts/probe-relay.mjs wss://relay.nexuside.app
```

`wrangler.jsonc` fixa a conta `53446ce31f241717e814d3766cb43305`,
`workers_dev: false`, `preview_urls: false`, o domínio próprio
`relay.nexuside.app` e as migrações dos Durable Objects `RelayRoom` (v1) e
`RelayRegistry` (v2), ambos `new_sqlite_classes`. Observability fica ligada sem
invocation logs: a URL da requisição traz o roomId.

## Variáveis

```text
RELAY_ALLOWED_ORIGINS=https://app.nexuside.app
RELAY_MAX_ROOMS=2000
RELAY_MAX_PEERS_PER_ROOM=8
RELAY_MAX_FRAME_BYTES=262144
RELAY_MAX_MESSAGES_PER_SECOND=1000
RELAY_ROOM_TTL_MS=1800000
RELAY_HEARTBEAT_MS=30000
RELAY_IDLE_TAKEOVER_MS=45000
```

`RELAY_MAX_UPGRADES_PER_IP_PER_MINUTE=60` virou o limitador nativo
`UPGRADE_RATE_LIMITER` (60 por 60 s, chave `CF-Connecting-IP`; a borda recusa
esse header vindo do cliente, então ele não é forjável).

`RELAY_MAX_ROOMS` é contado pelo Durable Object `RelayRegistry`, uma instância
só, que guarda o id do Durable Object de cada sala (um hash, não o roomId) com
um aluguel de 2 × `RELAY_ROOM_TTL_MS`. A sala adquire a vaga quando o host entra
(acima do teto: 101 + 4029 `relay at capacity`), renova no alarme e devolve ao
fechar. Sala que some sem close (deploy, queda) devolve a vaga no próximo
alarme; o aluguel é o último recurso. Falha do registro fecha o host com 1011,
que o desktop trata como queda passageira.

`RELAY_MAX_FRAME_BYTES` vale para binário e para TEXT (bytes UTF-8), como o
`maxPayload` da Railway. `RELAY_MAX_MESSAGES_PER_SECOND` derruba com 1008 quem
manda mais que isso numa janela de 1 s.

## Conexão meio-aberta

Workers não manda ping de protocolo. O desktop (`relay-socket.ts`) manda o TEXT
`{"t":"ping"}` a cada 20 s e o runtime responde `{"t":"pong"}` sem acordar a
sala. Um socket que já pingou e passa 2 × `RELAY_HEARTBEAT_MS` (60 s) calado é
derrubado com 1001, e o host leva a sala junto.

O relay aceita o upgrade (101) antes de recusar a sala com 4009, 4008, 4029 ou
4004. Por isso o desktop manda um ping assim que o upgrade abre e só considera a
conexão estabelecida (zera o backoff, drena a fila, avisa a UI) quando chega o
pong ou qualquer mensagem do relay, ou depois de 1,5 s aberta sem close. Close
antes disso conta como tentativa falha, com backoff exponencial: um zumbi que
segura a sala não faz o desktop gastar a cota de upgrades do IP, que o celular
na mesma rede também usa. Os relays Node (embutido e o da Railway) também
respondem ao ping.

Desktop até 0.76.251 e o PWA nunca pingam, e o desktop novo pode perder a rede
antes do primeiro ping. Para eles vale a vaga ociosa: host calado (sem frame e
sem ping) há mais de `RELAY_IDLE_TAKEOVER_MS` (45 s) cede a sala ao próximo
host, e guest calado há esse tempo cede a vaga ao próximo guest quando a sala
está cheia. Quem sai leva 4008, que o desktop novo trata como fatal (outra
conexão assumiu a sala). Host ativo continua protegido por 4009. Quem conhece o
roomId (o link do QR, inclusive o de só assistir) pode assumir a sala de um
desktop antigo que fique 45 s calado; o desktop novo pinga a cada 20 s e nunca
fica calado esse tempo.

O alarme da sala acorda só no primeiro prazo real: TTL ocioso, heartbeat de quem
pinga ou fim da janela de 2 intervalos de quem acabou de entrar. Ele é
recalculado em cada entrada e em cada alarme. Uma conexão calada por 150 s seguiu
aberta na sonda de produção: a borda não derruba conexão ociosa.

## Domínio

A rota é um Custom Domain do Worker. Enquanto `relay.nexuside.app` tiver o CNAME
antigo para a Railway (`jpxd0q57.up.railway.app`, DNS only), o Cloudflare recusa
o domínio com o código 100117. O token OAuth do Wrangler não tem permissão de
DNS, então a troca exige uma destas ações de quem administra a zona:

1. No painel, em **nexuside.app → DNS**, apagar só o CNAME `relay` e rodar
   `npx wrangler@latest deploy` em `relay-worker/`; ou
2. Em **Workers & Pages → nexus-relay → Settings → Domains & Routes**, adicionar
   `relay.nexuside.app` e aceitar a substituição do registro; ou
3. Rodar o deploy com `CLOUDFLARE_API_TOKEN` de um token com **Zone → DNS →
   Edit** na zona, além de Workers Scripts e Workers Routes. Fora de um TTY o
   Wrangler já pede `override_existing_dns_record`.

Nenhum outro registro da zona precisa mudar. O desktop continua configurado com
`wss://relay.nexuside.app`, e o PWA em `https://app.nexuside.app` só aceita esse
host.
