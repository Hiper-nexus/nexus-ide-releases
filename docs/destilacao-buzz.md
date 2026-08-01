# Destilação do block/buzz — decisão e roadmap

Análise funcional completa em 01/08/2026 (repo lido inteiro, HEAD `8e81afa4`).
Licença do buzz: **Apache 2.0** (sem NOTICE). Conceitos/schemas/protocolos:
destilação livre. Porte de código traduzido: atribuição em
`third_party/licenses/` + comentário no arquivo derivado.

## Aplicado no working tree (ainda não publicado)

1. **Watchdog de fila com deadline + dead-letter** (design de
   `crates/buzz-acp/src/queue.rs`): nada fica in-flight para sempre na fila de
   merge. Fecha o abandono em `candidate-validating` (22 min no mesmo processo
   sem watchdog) que causava timeout de gate.
2. **Receipts encadeados por hash** (design de `crates/buzz-audit/src/hash.rs`):
   receipt N inclui o hash do N−1; `verifyChain` valida a trilha da missão de
   ponta a ponta. Armadilhas herdadas do original: timestamp truncado à
   precisão de storage ANTES do hash; JSON canônico; presence-tags.
3. **Reply guard no waiver** (design do reply guard de `buzz-agent`): falha de
   provider sem NENHUMA evidência de execução consulta o reroute do roster
   antes de gravar done; roster esgotado vira waiver com motivo explícito.
   Fecha o "waiver mascara task que nunca executou" (401 no attempt 0).

## Fundações grandes — fundação implementada; integração de produção pendente

Cada fundação entra como incremento funcional testado; o que fica para o
incremento 2 está declarado no módulo, não escondido.

- **Plano de observabilidade tipada** (NIP-AO + VISION_ACTIVITY):
  `src/shared/observer-frame.ts` (schema de frames com seq monotônico e kinds
  discriminados) + `src/main/orch/observer-bus.ts` (ring de 1000/sessão) com
  emissão REAL a partir dos hook events canônicos. A projeção persistente de
  `mission_events` e a timeline semântica da UI já existem. O failover agora
  consome `provider_error` tipado quando o hook fornece erro canônico; o parser
  de scrollback permanece somente como fallback para CLIs sem hook.
- **ACP como driver de harness** (`buzz-acp`): `src/shared/acp-protocol.ts`
  (tipos + parser NDJSON), `src/shared/harness-catalog.ts` (schema BYOH — env
  reservado stripped, base da portabilidade multi-PC) e
  `src/main/acp/acp-client.ts` (JSON-RPC sobre stdio, timeouts bounded,
  process-group kill em toda saída), provado contra peer fake em teste. Falta
  plugar o cliente no dispatch real por provider (Claude/Codex) e expor a
  escolha BYOH no fluxo de provider.
- **Identidade criptográfica por agente** (NIP-OA):
  `src/shared/agent-attestation.ts` (credencial compacta, preimage
  determinístico, gramática estrita de conditions, fixtures da spec portados)
  + `src/main/orch/agent-keyring.ts` (keypair por agente por missão,
  revogação por dono). Adaptação deliberada: ed25519 nativo do node:crypto no
  lugar de Schnorr/secp256k1 — o protocolo é o destilado, não a curva. Falta
  persistir o keyring e exigir atestação assinada em handoff, receipt e
  reroute; a fundação em memória ainda não é um gate de release.

## Armadilha registrada

As duas peças mais tentadoras — approval gate com resume e merge exigindo N
aprovações — são exatamente as NÃO terminadas no buzz (`buzz-workflow` marca
runs que atingem `request_approval` como **Failed**; `require-approval N` não
existe em `git_perms.rs`). Destilamos schema e desenho de segurança
(token de aprovação hasheado SHA-256, uso único); o loop completo o Nexus
prova sozinho.

## Não vale destilar

Substrato Nostr inteiro (relay/kinds/Postgres), Buzz Mesh, delegation-tree
kinds 43001–43006 (menos maduros que nosso dispatch), web-of-trust (vaporware),
git-sign-nostr (sequestra gpg.x509.program por worktree — intrusivo; NIP-OA dá
a mesma prova sem tocar o git do usuário), persona packs (Squad Editor +
forge-registry já cobrem; roubar só a checklist de validação de path
traversal se endurecermos o registry).
