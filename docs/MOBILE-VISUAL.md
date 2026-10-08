# Harness visual do app mobile (host Nexus) — F-1035

`npm run mobile:visual` renderiza o app Expo de verdade (`mobile/`) no **alvo web**
(React Native Web), num Chrome headless em viewport de celular (390×844, DPR 3),
contra a **Remote Bridge real** do desktop, e percorre o fluxo do host Nexus de ponta
a ponta tirando um screenshot por estado em `docs/qa/evidence/mobile-web/`.

> **Não é teste de aparelho.** Prova layout e o protocolo de ponta a ponta. O que
> depende do iOS/Android (WebSocket nativo, Keychain/Keystore, câmera, notificações,
> haptics, ditado, Tailscale) não roda aqui — ver [Limites](#limites).

## Como rodar

```sh
npm run mobile:visual                 # export web + fluxo + screenshots (~2-3 min)
npm run mobile:visual -- --no-build   # reaproveita mobile/web-build (iterar no fluxo)
npm run mobile:visual -- --serve      # só sobe bridge + app e imprime o link de pareamento
```

Requisitos: `node_modules` na raiz e em `mobile/` (inclusive os arquivos gerados pelo
`postinstall` do mobile) e o Google Chrome instalado (ou `CHROME_PATH`). Nada é
instalado da rede. Dentro de um pane do Nexus, rode como job do launchd (o Chrome
headless não renderiza dentro do pane).

Saída: `docs/qa/evidence/mobile-web/NN-<estado>.png` e `report.json` (passos,
verificações, auditoria de layout por tela, escritas que chegaram ao PTY simulado e
erros/avisos do console). Código de saída 1 se qualquer passo falhar (e um
`99-falha.png` do estado em que parou).

## O que acontece

1. **Export web** (`scripts/mobile-visual/run.mjs`): `expo export --platform web
   --clear` com `EXPO_PUBLIC_NEXUS_VISUAL_HARNESS=1` → `mobile/web-build/` (ignorado
   pelo git). O `--clear` existe porque a flag é embutida no bundle pelo babel e o
   cache do Metro não a considera.
2. **Fixture** (`scripts/mobile-visual/bridge-fixture.ts`): o mesmo arranjo de
   `src/main/remote/remote-bridge.mobile-app.test.ts`, fora do vitest. O esbuild
   empacota o harness trocando só os cinco módulos que dependem do Electron por
   `desktop-fakes.ts` (registro de panes, PTY, missões, autorização por projeto,
   diálogo de confirmação) e `electron` por um módulo vazio. Todo o resto é o código
   real do Main: HTTPS/WSS com certificado autoassinado, código de pareamento,
   token por aparelho, desafio assinado, política mobile, broker de aprovação e o
   Git/arquivos do checkout (F-1014). `HOME` vira um diretório temporário antes de
   importar a bridge — o perfil real do operador nunca é tocado.
   - 3 panes com saída (`Claude · x8…` ocupado, `Codex · revisão…`, `zsh`), 3 missões,
     uma aprovação aberta durante o fluxo, e um checkout git real com alteração não
     preparada, preparada, arquivo novo e `.env` (protegido).
   - Na frente da bridge, um servidor HTTPS local serve o export web (SPA) e repassa
     o upgrade WebSocket para a bridge **sem o header `Origin`**. Por quê: o WebSocket
     nativo do React Native não manda `Origin`, e a bridge recusa `Origin` de outro
     site (defesa contra sequestro de WebSocket). Tirar o header no repasse reproduz
     o app nativo sem afrouxar a bridge; como o Tailscale Serve, o repasse chega pelo
     loopback.
3. **Driver** (`scripts/mobile-visual/drive.ts` + `cdp.ts`): Chrome headless pelo
   DevTools Protocol com `ws` cru (como `scripts/spikes/cdp-shot.mjs`), perfil
   temporário (`--user-data-dir`), `--use-mock-keychain` e, só aqui,
   `--ignore-certificate-errors` para o certificado autoassinado local. Cliques são
   eventos de mouse reais (`Input.dispatchMouseEvent`) e o texto entra por
   `Input.insertText`.

### Fluxo e verificações

| # | Estado | Verifica |
|---|--------|----------|
| 01–03 | início sem host → pair-scan → colar o link `https://127.0.0.1:<porta>/#code=…` | — |
| 04–05 | onboarding do 1º pareamento → host na lista | o pareamento real gastou o código e salvou o host; o onboarding não oferece "Usar UI de chat" para host Nexus; a Início está em pt-BR, o card diz "Conectado · Desktop Nexus" (sem worktree/caminho) e não há Tarefas nem "Novo workspace" (F-1037) |
| 06–07 | host conectado → aprovação aberta no desktop | snapshot (missões + panes); o card chega pelo push `approvals.changed` |
| 08–10 | pane: saída inicial, digitar `git status`, enviar | a linha chegou ao PTY simulado com Enter; nenhum diálogo no desktop (comando de rotina); a saída volta pelo stream |
| 11 | responder **Permitir** | o broker recebeu `accept`; nenhuma tecla no PTY |
| 12–14 | Alterações → diff do README → diff de código | git status/diff do checkout do pane |
| 15–16 | Arquivos → leitura do README | `.env` fora da listagem |
| 17–18 | desktop revoga os aparelhos → "Parear de novo" → pair-scan | `auth-failed` ao vivo, sem loop; o arquivo/diff aberto some e as abas ficam desabilitadas (F-1037) |

## A exceção de host 127.0.0.1 (só no harness)

O pareamento do app recusa IP/localhost por desenho: só o Tailscale Serve
(`https://<máquina>.<tailnet>.ts.net`) tem certificado que o celular confia
(`NEXUS_SELF_SIGNED_MESSAGE`). O harness precisa parear com `https://127.0.0.1:<porta>`,
então existe uma exceção que só vale com as três travas juntas:

1. **alvo web** — ela mora em `mobile/src/transport/nexus-bridge-visual-harness.web.ts`;
   o Metro só usa `.web.ts` no web, e o bundle iOS/Android recebe
   `nexus-bridge-visual-harness.ts`, que sempre devolve `false`;
2. **flag de build** `EXPO_PUBLIC_NEXUS_VISUAL_HARNESS=1` no momento do export — o
   babel-preset-expo troca a leitura por literal; sem a flag, o ramo vira `false`;
3. **host exatamente `127.0.0.1`** — `localhost`, IPs da LAN e do tailnet continuam
   recusados.

`nexus-bridge-pairing.test.ts` e `nexus-bridge-visual-harness.test.ts` travam isso.

## Limites

O que **não** é exercitado (precisa de aparelho/simulador):

- WebSocket nativo do React Native (no web é o do navegador; o TLS autoassinado é
  aceito pelo Chrome com `--ignore-certificate-errors`, o que o celular nunca faz) e,
  portanto, a confiança real do certificado do Tailscale Serve;
- Tailscale (tailnet, MagicDNS, Serve) — o caminho é loopback;
- Keychain/Keystore (`expo-secure-store`): no web a chave do aparelho e o token ficam
  no `AsyncStorage` (localStorage), caminho que o app já tinha para o web;
- câmera/leitor de QR (no web só o "colar código"), notificações locais e push,
  haptics, ditado pelo microfone, teclado do sistema, safe areas e gestos;
- fontes e métricas nativas (o web usa as fontes do sistema do Chrome): quebras de
  linha podem diferir um pouco no aparelho;
- desempenho e consumo de memória num celular real;
- o desktop é simulado onde depende do Electron (panes, PTY, missões, diálogo de
  confirmação) — a bridge, a política e o broker são os reais.
