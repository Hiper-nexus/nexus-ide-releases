# Brief — investigar o pareamento do celular por QR (Nexus Companion)

Papel: investigador SOMENTE LEITURA. Não edite, não commite, não rode build que escreva na árvore.

Código: Nexus IDE em `C:\Users\Administrador\Documents\Projetos\nexus-ide-rel`
(branch `release/0.76.249`, HEAD `7b7d4823b` = v0.76.250, a versão que o cliente usa no Windows).
Ignore as mudanças não commitadas em `src/main/orch/*-manifest.ts`.
O `main` está em `C:\Users\Administrador\Documents\Projetos\nexus-ide` (`152c77e82`), se precisar comparar.

## Sintoma (cliente leigo, v0.76.250)
Configurações › Integrações › Celular. O relay está configurado como `wss://relay.nexuside.app`
(botões "Parar" e "Atualizar" visíveis, ou seja, ligado). A tela mostra dois QR (Full = controle,
View = somente leitura) e os links `wss://relay.nexuside.app/r/<sala>#<chave>`. Mais abaixo:
"Celular na rede local — ONLINE". O cliente aponta a câmera do celular para o QR: "abre o link mas
não conecta em nada".

## O que já sei
- `src/main/remote/relay/companion-web-link.ts:1-4`: o QR aponta para o PWA `https://app.nexuside.app`,
  não direto para o `wss://`.
- `https://app.nexuside.app/` responde 200 (HTML) e `/manifest.webmanifest` 200.
- `https://relay.nexuside.app/` responde 404 JSON (esperado: o relay só aceita WebSocket,
  ver `docs/deploy-relay-railway.md`). DNS: Railway atrás de Cloudflare.
- `docs/deploy-relay-railway.md`: `RELAY_ALLOWED_ORIGINS=https://app.nexuside.app`.
- Arquivos: `src/renderer/components/settings/CompanionRelaySection.tsx`,
  `src/main/remote/relay/*` (blind-relay, companion-relay-transport, companion-relay-pty-bridge,
  room-link, relay-socket, relay-server-main), `companion/worker.js` e `companion/` (PWA?),
  `server/` (Dockerfile.relay).

## Perguntas (responda com arquivo:linha)
1. O que exatamente o QR codifica (formato da URL, onde vão sala e chave)? O PWA em
   `app.nexuside.app` lê esse formato? O PWA publicado é a mesma versão do código em `companion/`?
   Compare o HTML/JS servido por `https://app.nexuside.app/` (pode baixar com curl, é público) com o
   que o repositório gera, inclusive o protocolo/versão de handshake.
2. Teste o relay sem segredo: faça um upgrade WebSocket para `wss://relay.nexuside.app/r/<sala-aleatória>`
   com `Origin: https://app.nexuside.app` e sem Origin. Diga o status (101? 403? 404?). Use uma sala
   inventada; NUNCA use o link real do cliente. Node está disponível (`node -e` com o módulo `ws` do
   `node_modules` do repo, ou `curl -i -N` com cabeçalhos de upgrade).
3. Fluxo completo desktop → relay → PWA: o desktop entra na sala quando? A sala expira
   (`RELAY_ROOM_TTL_MS`)? O QR é regenerado? O que o PWA mostra quando não conecta (há mensagem de erro
   ou fica mudo)?
4. "Celular na rede local": que URL/QR esse modo usa (http LAN?) e por que o celular não conecta
   (firewall do Windows, bind em 127.0.0.1, http vs https no PWA, mixed content)?
5. Hipóteses ranqueadas para "abre o link mas não conecta", com a evidência que separa cada uma.
6. A menor correção para a causa principal (arquivo:linha) e um teste vitest que falharia hoje.
   Sugira também mensagens claras em PT-BR no PWA para cada falha (leigo).

Não exponha chaves, tokens ou links de sala reais no relatório.

## Entrega
Termine com `nexus_handoff_submit` uma vez, com o relatório em PT-BR (até ~900 palavras):
causas ranqueadas com evidência, resultado dos testes de rede, plano de correção e plano de teste.
