# Remote Ops (Fase 5) — companion thin client

Nexus **não** embute o React Native do Orca. O caminho de produto é o **thin client PWA** servido pela remote bridge (HTTPS + WebSocket), com pairing por código.

## Stack

| Peça | Path |
|------|------|
| Bridge TLS + WS | `src/main/remote/remote-bridge.ts` |
| Thin client HTML | `src/main/remote/remote-client-page.ts` |
| Policy mobile RPCs | `src/main/remote/mobile-companion-policy.ts` |
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

## Próximos passos (pós fase 5)

- Conta ativa no `ops.snapshot` (secret-free).
- Stream terminal em tempo real no thin client (hoje poll `pane.read`).
- QR pairing na UI Settings (já há rotate pairing no IPC).
