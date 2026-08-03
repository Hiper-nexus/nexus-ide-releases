# Deadlock de entrega de handoff — diagnóstico, correção e prova

**Data:** 2026-08-02
**Contexto:** execução da destilação
[`2026-08-02-overclock-124-distill.md`](./2026-08-02-overclock-124-distill.md),
seção 7 ("por que eles vivem e nós não").

---

## 1. O bloqueador real

A missão não terminava por um **deadlock circular** entre a entrega de handoff e
o estado do PTY do orquestrador:

1. Workers submetem handoffs → `delivery_state = 'queued'`.
2. `onHandoffSubmitted` resolve a autoridade do orquestrador com sucesso, mas
   `isSessionInjectableIdle(sessionId)` é **falso**, então o handoff vai para a
   fila em memória em vez de ser entregue.
3. A entrega push só cola texto num PTY **idle** — colar dentro de um turno vivo
   corromperia o turno.
4. `nexus_handoff_ack` exigia uma tentativa de entrega **aceita**
   (`handoff_delivery_attempts.state = 'accepted'`).
5. O Maestro, para consumir o resultado, entra em laço
   `handoff_list` → `handoff_ack` → `Bash sleep` — e esse laço o mantém
   `working` pelo turno inteiro.
6. Logo nunca fica idle → nunca há push → nunca há tentativa aceita → o ACK
   sempre falha → o laço recomeça.

O Maestro esperava um handoff que ele **já conseguia ler**, segurando exatamente
o turno cujo fim permitiria a entrega.

### Evidência de campo

Missão `mission-0adf44ce` ("teste de panes"), banco QA:

| Fato | Valor |
|------|-------|
| Handoffs | 3, todos `status=success` |
| `delivery_state` | `queued` nos 3 |
| `handoff_delivery_attempts` | **tabela vazia** |
| Chamadas de `nexus_handoff_ack` | 13+, todas sem efeito |
| `turnId` do orquestrador | `turn-1` do início ao fim |
| Status semântico | `working`, nunca `idle`/`completed` |
| Desfecho | `status=blocked`, `intent_state=blocked_user` |

Log com a instrumentação da sessão anterior:

```
[idle-delivery] authority resolved {... "injectable":false,"pending":false}
```

repetido dezenas de vezes para os mesmos 3 handoffs.

---

## 2. A correção — entrega por leitura (pull)

`src/main/orch/handoff-physical-ack-authority.ts`

Quando não existe tentativa push aceita, o ACK passa a sintetizar uma
**tentativa de entrega por leitura**: o orquestrador está reconhecendo um
handoff que leu via `nexus_handoff_list`, em vez de um que foi colado no seu
terminal.

O texto colado nunca foi a autoridade. A autoridade é o **recibo físico** e a
**sessão de orquestrador corrente da missão** — ambos já provados em
`commitPhysicalAck` antes deste ponto.

### O que continua sendo exigido (nada foi afrouxado)

- `ctx.role === 'orchestrator'` com missão e sessão vivas
- `missions.orch_session_id === input.orchestratorSessionId`
  (sessão stale continua negada)
- Recibo físico inspecionado e consumido (`inspectCurrentAgentTransportPhysicalReceipt`)
- `assertPhysicalAgentToolAuditAuthority` (trilha de auditoria)
- CAS de `delivery_state` em `consumeHandoffRow`
- Proteção de replay via `handoff_ack_receipts.delivery_attempt_id` único
- A tentativa é aceita em `issuedAt`, dentro do turno do próprio chamador, para
  que a comparação de frescor continue significando algo

### Por que não o caminho oposto

Fazer a entrega push injetar num PTY ocupado corromperia o turno do agente — é
justamente para isso que o gate de idle existe. O gate está certo; errado era
**condicionar o consumo à injeção**.

### Sem migração

O schema já aceita: `state IN ('reserved','pasted','accepted','failed')`.

---

## 3. Telemetria abortando o nascimento do processo

`src/main/usage/usage-service.ts`

O lookup de sessão para resume lançava `usage telemetry scope identity
collision` de dentro do caminho de spawn do `pty-manager`, virando
`[nexus] falha ao iniciar o processo` e matando o pane no nascimento.

O lookup só serve para acrescentar `--resume <id>`. Agora degrada para `null`
(sessão nova), que é o resultado estritamente **mais restrito**.

Causa raiz ainda aberta: a chave de cache é `projectId + checkoutId`, mas a
comparação `sameProjectScope` também exige `installationId` e `rootRealPath`.
Mesma chave com caminho diferente colide. Rodar de um worktree torna isso
trivialmente alcançável.

---

## 4. PREVC: por que NÃO foi removido

Havia autorização explícita para arrancar o PREVC. **A evidência não sustentou a
remoção**, e removê-lo teria destruído o app sem corrigir nada:

- PREVC aparece em ~170 arquivos.
- Nas missões travadas, `handoffs.context_revision` estava **vazio** — a lane
  sequer engajava PREVC.
- O deadlock provado acima não passa por nenhum código de PREVC.

Remover o PREVC teria sido demolição sem relação causal com o sintoma. Se no
futuro ele voltar a ser o bloqueador, o rastro está aqui: o alvo seria
`mission-freeze-authority.ts`, `guided-mission-prevc.ts` e
`guided-prevc-mcp-fence.ts`, e a invariante que protegem é o congelamento do
contrato de contexto entre aprovação e despacho.

---

## 5. Prova ao vivo

App de dev do worktree, `.dev-user-data-qa`, missão real "teste de panes":

```
[02:11:24] status=running panes=4 handoffs=queued
[02:11:44] status=running panes=4 handoffs=queued,queued
[02:11:51] status=running panes=4 handoffs=consumed,queued
[02:12:03] status=running panes=4 handoffs=consumed,consumed
HANDOFF_PROOF=PASS
```

Estado final no SQLite:

| Tabela | Resultado |
|--------|-----------|
| `handoffs` | 2 × `delivery_state=consumed`, `delivered=1` |
| `handoff_delivery_attempts` | 2 × `state=accepted`, `attempt_no=1` (pull) |
| `handoff_ack_receipts` | 2 (cadeia de auditoria intacta) |

Nenhuma tentativa push existiu — a transição `queued → consumed`, antes
impossível, aconteceu inteiramente pelo caminho pull.

Reprodução: `node scripts/spikes/e2e-handoff-proof.mjs` com o app de dev no ar.

---

## 6. O que ainda NÃO está resolvido

1. **A missão não fecha em `done`.** Terminou em `blocked_user` — mas por
   decisão **correta** do Maestro. Ele relatou:

   > 2 de 3 especialistas nasceram e responderam com sucesso via handoff, ambos
   > reconhecidos com `nexus_handoff_ack`. O pane do Executor principal nasceu e
   > carregou o modelo, mas travou antes de processar o prompt: os MCP servers
   > `cloudflare-api` e `higgsfield` não estão autenticados e o MCP `figma`
   > falhou o handshake. Output idêntico byte a byte em 4 janelas de 30s.

   Ou seja: **falha de ambiente do usuário**, não do Nexus. Ainda assim é um bug
   real que um worker cujo CLI tem MCP quebrado **trave** em vez de falhar
   rápido com causa legível.

2. **A colisão de identidade de escopo continua.** Foi impedida de matar o pane,
   não curada na chave.

3. **Os ~23 gates pré-PTY restantes não foram varridos.** O deadlock era o
   bloqueador dominante; a varredura ampla ficou sem justificativa por evidência
   nesta rodada.

4. **`node_modules` é compartilhado com o checkout principal**, então a ABI
   nativa alterna entre Electron e Node e quebra testes ou app conforme quem
   rebuildou por último.

5. **Vitest varre `.dev-user-data-qa/`** e roda cópias obsoletas dos testes
   dentro dos worktrees de task (12 cópias do mesmo arquivo observadas).

---

## 7. Verificação executada

| Gate | Resultado |
|------|-----------|
| `npm run typecheck` | limpo |
| `npx vitest run src/main/orch/` | **257 arquivos, 3012 testes, 0 falhas** |
| `npm run security:renderer-sinks` | 0 sinks executáveis |
| Missão ao vivo | `HANDOFF_PROOF=PASS` |

O teste que codificava o deadlock
(`http-mcp-boundary.integration.test.ts`, "ACK em `queued` deve falhar") foi
atualizado, e um teste novo cobre o caminho pull ponta a ponta. As invariantes
de push, replay e sessão stale seguem cobertas.
