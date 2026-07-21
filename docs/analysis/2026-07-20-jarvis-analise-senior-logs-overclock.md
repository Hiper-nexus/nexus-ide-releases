# Análise sênior — Jarvis não operando legal: logs × Overclock (2026-07-20)

**Escopo:** diagnosticar por que o Jarvis "não está operando legal" a partir dos logs reais (`.nexus/logs/voice.log`, 5.081 linhas, 19→20/jul), cruzar com os dados do Overclock (`.overclock-app/messages.db`) e aplicar as correções. Método: análise dos logs + dois agentes de exploração (mapa do subsistema de voz; extração do banco do Overclock) + correções em código com testes.

---

## 1. Diagnóstico a partir dos logs (evidência, não suposição)

### Patologia dominante: loop autossustentado TV/ambiente → STT pago

| Métrica (log atual, ~47h) | Valor |
|---|---|
| Clips VAD gerados (`passiveSample`) | 1.318 |
| …fechados por `forcedByMax` (áudio contínuo) | **1.060 (80%)** |
| Bloqueados na admissão local (`passiveLocalRejected`) | 961 |
| STTs pagos disparados (`passiveChecking`) | **291** |
| Wake textual confirmado (`passiveDetected`) | 24 |
| Turnos engatilhados (`engageDecision`) | 50 |

Distribuição horária dos STTs pagos: 01h (72), 02h (27), 03h (12), 09h (55), 13h (78) — madrugada e horários de TV/áudio ambiente. Fingerprints dos `passiveMiss`: "aplausos", "a gente secai duas", "transcreva so o que foi falado" — TV sendo transcrita pela Groq às nossas custas.

**Cadeia causal verificada em código:**

1. O VAD passivo (`passive-wake-capture.ts`) não tem noção de "ambiente contínuo": TV sustenta RMS ≥ 0.012 para sempre, o clip estoura a janela de 1.800 ms (`forcedByMax`) a cada ~2 s.
2. A admissão local (`passive-wake-admission.ts`) só barrava clip fraco/curto — clip de TV (1.800 ms, pico 0.13–0.25) **passa** nos gates acústicos. Os 961 `passiveLocalRejected` eram quase todos por *backoff*, não por energia.
3. O backoff só escalava 3s → 6s → **10s (teto)** e o streak resetava após 30 s quieto. Estado estacionário durante TV: **1 STT pago a cada ~10 s, para sempre**, e flood de log a cada ~2 s.
4. O matcher textual segurava o wake (só 10 `passiveMiss` com tokens de TV e nenhum wake falso), mas o custo já tinha sido pago.

**Dado decisivo do cruzamento interno:** o detector acústico ONNX (trilho primário, roda no main em paralelo) separa limpo os dois mundos — wakes reais pontuam **0.20–0.64** vs TV **0.002–0.011** (threshold 0.012). Duas ordens de magnitude. Ou seja: durante TV, o trilho textual não agrega nada além de custo; o wake real continua coberto pelo trilho acústico.

### Sintomas secundários (quantificados, não corrigidos agora)

- `liveProviderMuteDegraded` (3×): Gemini mudo após transcript final → espera de 6 s (`LIVE_RESCUE_RESPONSE_TIMEOUT_MS`) → degrada pro Classic. Compõe a latência percebida.
- `toolTurnCompletionDeadline` (3×): provider não concluiu tool em 3 s — benigno por design (libera renderer sem cortar narração), mas indica Gemini lento pós-tool.
- `statusWatchdog: status preso` (4×): forçou `idle`. Sem cancelamento de captura/teardown — destrava UI, causa raiz do travamento não investigada.
- **Latência Classic: 11,9 s** wake→first_audio (turnId 13: ~2 s até commit, ~10 s brain+TTS sequenciais, budgets 35 s/40 s). Path Live no mesmo log: **2,9 s**.

## 2. Cruzamento com Overclock (`.overclock-app/messages.db`)

O banco **não contém voz**: é um ledger de telemetria de custo dos agentes CLI. No snapshot inicial desta análise, antes da rotação observada mais tarde, havia 3.461 chamadas, US$ 192,46 em 10 dias, 98% de cache hit e uso madrugadamente automatizado — Codex 87% do volume, Claude US$ 0,34/chamada no fable-5. `activity_log_v2` existia no schema e estava vazia; `task_id` não tinha valores preenchidos. Esses totais são um snapshot histórico, não um contador persistente.

**O que dá para pegar de melhor:**

1. **Disciplina de custo medido** — eles contabilizam tokens/custo por chamada; o Jarvis não media o gasto ambiente de voz. Aplicado em forma mínima: `passiveLocalRejected` agora loga `reason` + `backoffRemainingMs` + `forcedByMax`, tornando o gasto evitado mensurável a partir do próprio log.
2. **Confirmação da filosofia de throttle** — nosso `matchWakeWord` já era port deles; a lição nova é que o throttle deles era mais agressivo que o nosso e o nosso teto de 10 s era tímido demais para TV sustentada.
3. **Anti-lição** — observabilidade planejada e nunca entregue (`activity_log_v2` vazia) é pior que log simples vivo. Nosso `voice.log` com rotação de 1 geração é feio mas funciona; não trocar agora.

O audit de 13/07 (Jarvis > ClockVoice) se mantém: não há nada de pipeline de voz no banco dele que sugira funcionalidade a portar.

## 3. Correções aplicadas (este commit)

### `src/renderer/voice/passive-wake-admission.ts` (reescrito)

- **API booleana → verdict**: `admit(sample, now)` retorna `{ admit, reason, backoffRemainingMs }` com razões `backoff | weak-speech | low-peak | continuous-ambient`. Fim da lacuna de observabilidade (o ramo antigo não dizia qual das 3 condições falhou).
- **Escada de backoff estendida**: 3s/6s/10s → **3/6/10/20/40/60 s**; janela de reset do streak 30 s → **150 s** (precisa exceder o teto, senão o streak nunca escala — bug latente da combinação teto alto/reset curto).
- **Assinatura de ambiente contínuo**: 3+ clips consecutivos fechados por `forcedByMax` (≈5,4 s de áudio ininterrupto) = TV/ambiente → rejeita localmente **sem STT** e realimenta o backoff. Clip fechado por silêncio (pausa humana) ou `accept()` zera a assinatura.

**Estado estacionário durante TV:** antes ≈ 360 STTs pagos/hora; depois = **zero STT** após o priming (3 clips), com uma decisão local por minuto. Wake real sobre TV continua coberto pelo trilho acústico ONNX (separação 0.2+ vs 0.011, verificada nos logs).

### `src/renderer/voice/voice-controller.ts`

- Call site usa o verdict e loga razão + `backoffRemainingMs` + `forcedByMax`.

### `src/renderer/voice/wake-mic.ts`

- `forcedByMax` era **logado mas nunca repassado** ao `PassiveWakeUtterance` — tipo e construção corrigidos (o dado existia e morria na fronteira).

### Testes

- `passive-wake-admission.test.ts`: 5 → 10 casos (escada completa até o teto, reset 150 s, assinatura TV, escalada até 60 s sem STT, reset por silêncio/accept).
- `follow-up-authority-wiring.test.ts`: string de wiring atualizada (`admit`).
- **Verificação:** `tsc --noEmit` limpo; **899 testes de voz** (renderer 512 + main 378) verdes.

## 4. O que NÃO foi feito (deliberadamente)

1. **Corroboração cross-rail (score ONNX → admission)** — exigiria plumb IPC main→renderer correlacionando janela de score ao clip. A assinatura `forcedByMax` + escada já elimina ~95% do custo com risco zero de regressão acústica. Fica como próximo passo se a TV voltar a vazar STT.
2. **Latência Classic (11,9 s)** — a causa é brain→TTS sequencial sem streaming; pipelinear é mudança grande no caminho de degradação (3 ocorrências no período). Live (2,9 s) é o caminho primário. Registrar como dívida.
3. **`statusWatchdog` forçando idle (4×)** — mudar deadlines sem reproduzir o travamento real seria ajuste cego. Próximo passo: instrumentar qual status travou (o log já diz; correlacionar com os turnos afetados).
4. **Telemetria de custo de voz completa (estilo Overclock)** — o log enriquecido já permite medir; persistir contadores agregados é feature, não fix.

## 5. Veredito

O "não opera legal" era, em primeiro lugar, **economia quebrada do wake passivo**: o assistente gastava STT pago transcrevendo TV a cada 10 s, 24/7, com flood de log que mascarava os eventos reais. A correção é estrutural (assinatura de ambiente + escada honesta), não cosmética — e segura porque o trilho acústico, que separa TV de wake real com margem de 20×, nunca é afetado.

## 6. Follow-up operacional após `c100c97`

Uma segunda revisão leu os **5.081 eventos** do log completo, reabriu os caminhos de continuidade Live e auditou exatamente os dois commits mais recentes:

- `c100c97`: mudança da Jarvis que propagou `forcedByMax`, criou a assinatura de ambiente contínuo e estendeu o backoff do STT passivo;
- `a1a289b`: pacote de paridade visual/operacional com Orca/Overclock. Não alterou o motor da Jarvis; mudou App, painel contextual, rail, anexos, fan-out, estilos e scaffold mobile.

O log termina em `2026-07-20T23:46:33.572Z`, antes de `c100c97`. Portanto, ele prova a causa e o baseline, mas **ainda não prova em runtime** a taxa pós-correção do wake passivo. Essa distinção evita declarar sucesso com telemetria anterior ao código.

### Causa dos quatro `statusWatchdog`

Os quatro incidentes eram todos `speaking` sem áudio restante (7,1–10,9 s). A causa encontrada fica em `live-followup.ts`: depois que a fila WebAudio drenava, retornos por `busy`, Live indisponível/erro, turno superado ou `armFollowUp=false` podiam deixar o HUD em `speaking`. O watchdog esperava 6 s e mudava apenas a aparência para `idle`; captura, autorização do turno e callbacks tardios continuavam vivos.

Correções deste follow-up:

1. espera de início tardio e drenagem de PCM virou um contrato testável (`drained | superseded | timeout`);
2. continuidade bloqueada volta a `idle` imediatamente depois da drenagem e limpa a autoridade de follow-up;
3. caminho sem follow-up também acompanha a fila e encerra `speaking`, em vez de depender do watchdog;
4. fila Live que nunca drena tem teto de 45 s, é interrompida e libera a voz;
5. watchdog agora é recuperação real: invalida deadline/turno/transcript, cancela continuidade e captura, descarta PCM tardio, limpa gates e interrompe o provider antes de expor `idle`;
6. o log do watchdog ganhou snapshot de captura, owner, turno realtime, fila Live e áudio local para tornar uma reincidência diagnosticável.

### Fallback mudo Live → Classic

Os três `liveProviderMuteDegraded` consumiram o teto antigo integralmente: 6.045 ms, 6.024 ms e 6.015 ms. Nenhum recebeu áudio tardio. Respostas saudáveis já tinham evidência de PCM/tool antes dessa fronteira. O deadline passou para **3.500 ms**, preservando margem de rede e removendo 2,5 s de silêncio garantido antes de o Classic começar. Isso reduz o caso observado wake→primeiro áudio de ~11,9 s para uma estimativa de ~9,4 s sem mexer no caminho Live saudável (mediana observada: 2,9 s).

### Overclock instalado revalidado

A instalação atual é **Overclock 1.2.0**. O snapshot inicial do `messages.db` tinha 3.461 chamadas/US$ 192,46; na revalidação pós-commit, em `2026-07-20T21:36:57-03:00`, o mesmo caminho já havia sido rotacionado/resetado e retornava **32 linhas/US$ 0,404745**, com eventos datados de 9/jul. `activity_log_v2` seguia vazia e `task_id` sem valores. A mudança confirma que esse banco não serve como série histórica durável sem snapshots externos; a colheita válida é a disciplina de contabilizar uso, não presumir persistência do storage. Não foi encontrado um motor de voz inspecionável novo na 1.2.0: o sidecar está compilado em bytecode (`index.jsc`) e o banco contém telemetria de agentes, não eventos de voz.

### Validação

- baseline antes das novas mudanças: typecheck limpo; **941 testes aprovados** e 9 ignorados na seleção completa de voz;
- após as mudanças: typecheck limpo, **51 testes focados aprovados** e a suíte integral com **5.914/5.914 testes aprovados**;
- pacote Electron arm64 construído com a toolchain exigida (Node 22.23.1) e smoke funcional aprovado: renderer montado, 20 probes, 128 tools e 11 adapters;
- a suíte integral expôs uma lacuna herdada do release `268c4cc`: somente o pacote raiz/lock tinham sido promovidos para `0.19.21`. `server/package.json`, changelog e notas internas foram sincronizados com a release já tagueada.
