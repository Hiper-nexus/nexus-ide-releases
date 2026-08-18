# Spec: daemon de PTY (destino arquitetural)

Rodada 3 R6 — 2026-08-18. Porte da doutrina Orca (`src/main/daemon/`,
`daemon/AGENTS.md` deles, PRs #7849/#8697/#10065/#12882) para o idioma e as
dores do Nexus. **Espec primeiro, código depois** — o porte é G (grande) e
não entra sem esta spec revisada.

## A dor que ele mata (nossa, com evidência)

1. **Grant de spawn nunca sobrevive a restart** (memória
   um-orquestrador-por-missao-renderer): `orchRequestId` é memória do main;
   todo boot ressuscita panes com tokens mortos. O daemon torna o conceito
   obsoleto: o PTY sobrevive, nada precisa ser re-autorizado.
2. **Quit/update mata a frota** (A3): handoff aceito-não-ackado dependia de
   reconcile no boot (fix 4024e790). Com PTY vivo, o ack acontece depois do
   app voltar — a janela deixa de existir.
3. **Ressurreição é reconstrução** (SIGKILL → respawn do orquestrador com
   nota de continuidade): caríssia em tokens. Re-anexo por incarnation é
   continuação de verdade.
4. **Usuário fecha o app e as missões param** — o produto promete
   "missões continuam no rail e retomam sozinhas"; o daemon entrega
   literalmente isso.

## Forma

Processo **detached** (filho direto do launchd/sistema, nunca do main),
um por usuário, dono de TODOS os PTYs de agente. O main vira CLIENTE:
pede spawn/read/write/resize/kill por socket de domínio Unix em
`$XDG_RUNTIME_DIR/nexus/ptyd.sock` (fallback `~/Library/Application
Support/NexusIDE/ptyd.sock`).

## Protocolo de posse de endpoint (o coração — copiado do Orca, nominalmente)

1. **Bind privado**: daemon recém-nascido binda num socket PRIVADO
   (`.ptyd.<pid>.sock`) — nunca direto no público.
2. **Link exclusivo**: `link()` do privado → caminho público. `link` é
   atômico e exclusivo por filesystem: só UM daemon é o público por vez.
3. **Provar incumbente morto POR CONEXÃO**: link falha (EEXIST) → o
   nascido CONNECTA no endpoint público. Consegue falar → incumbente VIVO →
   nascido se suicida (ordem determinística de sucessão). Conexão recusada
   → incumbente morto → segue.
4. **Rename atômico**: incumbente provado morto → `rename()` do privado
   sobre o público (atômico, substitui o cadáver sem janela de corrida).

### Regras gravadas (do AGENTS.md deles, traduzidas)

- **Nunca colapse "não sei" em "morto".** Falha de conexão ≠ processo
  morto se o erro for timeout/permissão; só ECONNREFUSED/ENOENT em socket
  legível prova morte. (É o tri-state do R1 no plano de processo.)
- **Sem sweeper.** NENHUM varredor periódico de daemons "antigos". A
  sucessão é dirigida por evento: nasce novo → prova → substitui.
- **Endpoint nunca é removido no shutdown.** Daemon saindo limpo encerra
  seus PTYs e deixa o socket no chão para o sucessor provar e renomear.
  Remover criaria corrida com um nascido em pleno link.

## Protocolo de sessão

- `spawn {spec} → {sessionId, incarnationId}` — incarnation é o nonce por
  PROCESSO físico (já existe no Nexus; vira a identidade no fio).
- `attach {sessionId, since}` — re-anexo pós-restart do main com replay do
  backlog retido (o cap de gap que já existe).
- `write/resize/kill` como hoje; `inventory {}` para a cerca (liveness
  tri-state do R1: live/exited/**unverifiable** quando o daemon não
  responde — a cerca continua contando unverifiable como bloqueio).
- Teardown do app: `goodbye {drainMs}` — o daemon SOBREVIVE (missões
  seguem); PTYs órfãos (missão encerrada pelo operador) são mortos pelo
  main ANTES do goodbye.

## Migração (a parte que quebra se for malfeita)

- **Fase 0 (esta spec) + teste de socket puro** (o coração do protocolo
  sem Electron).
- **Fase 1**: daemon co-existe — spawn novo via daemon, sessões legadas
  no main; renderer não percebe (pty-manager vira fachada com dois
  backends). Flag `feature.ptyd`.
- **Fase 2**: quit NÃO mata PTYs de missão (o goodbye vira no-op para
  missões running); boot re-anexa por incarnation; a ressurreição vira
  re-anexo, e o respawn com nota só para pane realmente morto.
- **Fase 3**: cerca/fence consulta `inventory` do daemon; grants de spawn
  saem do main (a autoridade continua NO MAIN — o daemon é transporte,
  nunca decide).

## Não-goals explícitos

- Daemon não conhece missões, rosters nem autoridade — é um gerenciador
  de PTY com tokens opacos. Toda decisão permanece no main (lição Orca:
  o daemon deles encolheu quanto mais puxavam decisão pra fora).
- Sem multi-usuário remoto nesta spec (federation é outro documento).

## Fase 0 — contrato de teste do protocolo de posse (socket puro, sem Electron)

Módulo: `src/main/pty-daemon/endpoint-ownership.ts`. Funções puras sobre
`node:net` com DI de bind/connect para o teste; SEM import de Electron.

```ts
export type EndpointClaim =
  | { readonly kind: 'claimed'; readonly socketPath: string }
  | { readonly kind: 'incumbent-live'; readonly socketPath: string }
  | { readonly kind: 'unverifiable'; readonly reason: string };

export async function claimDaemonEndpoint(input: {
  readonly publicPath: string;
  readonly probeTimeoutMs?: number; // default 1500
}): Promise<EndpointClaim>;
```

Algoritmo travado em teste (um `it` por regra gravada):

1. **Posse limpa**: dir vazio → bind privado `.ptyd.<pid>.sock` → `link()`
   privado→público → `claimed`; o público ACEITA conexão.
2. **Incumbente vivo**: segundo claim com o primeiro ouvindo → `link` EEXIST
   → CONNECT no público responde → `incumbent-live` (o nascido se suicida;
   o público continua do primeiro; socket privado do nascido é limpo).
3. **Incumbente morto por conexão**: primeiro morre DEIXANDO o arquivo no
   chão → claim novo → connect ECONNREFUSED/ENOENT em socket legível →
   `rename()` privado sobre público → `claimed`; conexão vai pro novo.
4. **Nunca colapsar "não sei" em "morto"**: connect que TIMEOUT ou EACCES
   → `unverifiable` → NUNCA takeover (simular: socket que aceita e não
   responde; socket chmod 000).
5. **Endpoint nunca é removido no shutdown**: `releaseDaemonEndpoint` NÃO
   faz unlink — contrato da função (o sucessor prova e renomeia).
6. **Sem sweeper**: sucessão só por evento (nascer→provar→substituir);
   a inexistência de varredor é propriedade estrutural — nenhum timer no
   módulo, assert por inspecção de exports.

Guard rails: roda em tmpdir (`mkdtempSync`), sem `app.getPath`, sem
processo detached na Fase 0 — é o coração do protocolo isolado.
