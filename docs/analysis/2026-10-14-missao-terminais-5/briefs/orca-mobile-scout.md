# Brief — o que herdar do Orca para o pareamento do celular por QR

Papel: investigador SOMENTE LEITURA. Não edite, não commite, não instale dependências.
Outro pane já investiga a falha do QR do Nexus em si (relay, PWA, rede local). O seu foco é a
comparação com o Orca e o que herdar dele. Não repita testes de rede no relay do Nexus.

## Fontes
- **Orca** (MIT, upstream de onde o app móvel do Nexus veio — o Nexus tem até
  `mobile/modules/orca-notification-dismissal`), clone raso da versão atual 1.4.214, commit
  `8a6d6ea8c861f76a82b4e1e7e064e918b3fb13e9`:
  `C:\Users\ADMINI~1\AppData\Local\Temp\claude\C--Users-Administrador-Documents-Projetos-hipergo\d997dd72-1ec7-48fa-8652-ada9ed96a0b3\scratchpad\orca`
  Pontos de partida: `mobile/` (app Expo), `cloud/`, e busque por `pair`, `QR`, `qrcode`, `relay`,
  `deep link`, `scheme`, `orca://`, `tunnel`, `LAN` em `src/` e `mobile/`.
- **Nexus** v0.76.250 (versão do cliente): `C:\Users\Administrador\Documents\Projetos\nexus-ide-rel`.
  Pareamento: `src/renderer/components/settings/CompanionRelaySection.tsx`,
  `src/main/remote/relay/*` (companion-web-link.ts aponta o QR para o PWA `https://app.nexuside.app`),
  `companion/` (PWA/worker), `mobile/` (app nativo: `mobile/src/nexus-host/NexusHostScreen.tsx`,
  `mobile/src/transport/nexus-bridge-rpc-adapter.ts`), `docs/remote-ops.md`,
  `docs/analysis/2026-07-11-mobile-plan.md`, `docs/analysis/2026-07-11-remote-bridge-protocol-map.md`,
  `docs/deploy-relay-railway.md`.

## Sintoma
Cliente leigo, Windows: Configurações › Integrações › Celular mostra QR Full e QR View
(`wss://relay.nexuside.app/r/<sala>#<chave>` nos links) e "Celular na rede local — ONLINE". Ele aponta
a câmera do celular para o QR: abre o link, mas não conecta em nada.

## Perguntas (arquivo:linha nas duas bases)
1. Como o Orca pareia o celular hoje: o que o QR codifica (deep link do app nativo? URL https de
   página? endereço LAN?), como o celular que NÃO tem o app instalado é tratado (página de instalação,
   loja, PWA), como a conexão é estabelecida (relay, túnel, LAN direta), e que feedback o usuário vê
   em cada falha.
2. Como o Nexus diverge disso. O app nativo do Nexus (`mobile/`) é publicado em loja? O QR do Nexus
   abre o app nativo ou só o PWA? O PWA consegue falar o protocolo do relay?
3. Lista concreta do que herdar do Orca (arquivo → destino no Nexus, adaptação, licença MIT com
   attribution) para um leigo apontar a câmera e conectar, e do que NÃO herdar. Priorize o menor
   conjunto.

## Entrega
`nexus_handoff_submit` uma vez, relatório em PT-BR (até ~800 palavras) com arquivo:linha.
