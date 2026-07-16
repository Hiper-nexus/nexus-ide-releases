# Remote Ops (Fase 5) — companion thin client

Nexus **não** embute o React Native do Orca. O caminho de produto é o **thin client PWA** servido pela remote bridge (HTTPS + WebSocket), com pairing por código.

## Stack

| Peça | Path |
|------|------|
| Bridge TLS + WS | `src/main/remote/remote-bridge.ts` |
| Thin client HTML | `src/main/remote/remote-client-page.ts` |
| Policy mobile RPCs | `src/main/remote/mobile-companion-policy.ts` (ligada em `handleAuthedMessage` via `mobileRpcKindForBridgeType`) |
| Pairing | `src/main/remote/device-pairing.ts` |
| IPC desktop | `src/main/remote/remote-ipc.ts` |

## RPCs de leitura (ops)

| type | Uso |
|------|-----|
| `ops.snapshot` | **Home phone**: missões + panes + summary |
| `mission.list` | Lista missões + contagens por status |
| `panes.list` | Panes visíveis do projeto |
| `pane.read` / `pane.input` | Terminal remoto (input cap 8KB) |

Escrita destrutiva (`git.push`, `fs.delete`, `mission.complete`) exige confirmação de device; `mission.complete` **negado** no mobile (evidência fica no desktop).

## Fluxo de uso

1. Desktop: iniciar Remote Bridge (Config / remote IPC).
2. Telemóvel: abrir URL HTTPS da bridge (aceitar cert dev se preciso).
3. Inserir código de pareamento.
4. Ecrã **Ops**: resumo + missões + panes; tocar pane → output + input.

## Relação com Orca mobile

Inspiração: home com hosts/stats + lista de trabalho.  
Implementação: thin client embutido (sem App Store lag), protocol versionável no bridge.

## Stream em tempo real e sessão persistente (feito)

- A bridge empurra `pane.stream.data` (terminal-stream-protocol, mesmo domínio
  de seq do `pane.read`) para clientes que abriram `pane.stream.open`;
  backpressure derruba frames (nunca acumula buffer) e o gap de seq resultante
  é curado pelo cliente com um `pane.read` de reconciliação.
- O thin client consome os pushes e mantém o poll só como reconciliação
  (15 s com stream vivo; 2,5 s em bridges antigas sem push).
- Token persistido em `localStorage` da origem HTTPS da bridge: reload não
  re-pareia; revogação no desktop invalida server-side e o cliente volta
  sozinho para a tela de pareamento.

## Próximos passos (pós fase 5)

- Conta ativa no `ops.snapshot` (secret-free).
- PWA (manifest + service worker) e notificações push locais.
- Push também no caminho do relay (companion-relay-transport hoje mantém
  contrato request/response; o parâmetro `pushTarget` do
  `handleAuthedMessage` já aceita um sink futuro).
