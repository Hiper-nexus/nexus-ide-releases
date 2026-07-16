# Relay E2E no Railway

O relay é um serviço separado do backend SaaS. Ele só encaminha frames WebSocket
selados e nunca deve receber chave, token, link de sala ou payload em logs.

## Serviço

No mesmo projeto Railway, crie o serviço `nexus-relay` a partir deste repositório.
Defina **Root Directory** como `server` e use o Dockerfile `Dockerfile.relay`.
Isso evita que o `railway.toml` do backend SaaS seja aplicado ao relay:

```text
Builder: Dockerfile
Dockerfile path: Dockerfile.relay (relativo a `server`)
```

Não configure um healthcheck HTTP no Railway para este serviço: o relay aceita
apenas WebSocket e devolve `404` a HTTP deliberadamente. A disponibilidade deve
ser validada por upgrade WebSocket.

## Variáveis de produção

```text
NODE_ENV=production
RELAY_ALLOWED_ORIGINS=https://app.nexuside.app
RELAY_MAX_ROOMS=128
RELAY_MAX_PEERS_PER_ROOM=8
RELAY_ROOM_TTL_MS=1800000
RELAY_MAX_UPGRADES_PER_IP_PER_MINUTE=60
```

`PORT` é fornecida automaticamente pelo Railway. O entrypoint usa `RELAY_PORT`,
depois `PORT`, e por fim `8787` apenas localmente.

## Domínio e Cloudflare

Associe `relay.nexuside.app` ao serviço na porta fornecida pelo Railway. Na
Cloudflare, mantenha TLS em **Full (strict)**. WebSockets passam pelo proxy da
Cloudflare sem configuração adicional.

Depois do domínio estar ativo, configure o desktop com:

```text
wss://relay.nexuside.app
```

O Companion PWA deverá ser hospedado em `https://app.nexuside.app`; por isso
esse é o único origin de navegador liberado.
