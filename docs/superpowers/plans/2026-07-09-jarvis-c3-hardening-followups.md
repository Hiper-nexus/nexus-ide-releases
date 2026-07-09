# JARVIS C3 Hardening Follow-ups Implementation Plan (parte 1/2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Parte 2 (Tasks 4-6):** `2026-07-09-jarvis-c3-hardening-followups-part2.md`

**Goal:** Fechar os 5 follow-ups de hardening do gate de confirmação por voz (spec C3) levantados na revisão final da Fase 0 — matcher de afirmativa estrito, validação de `paneId` contra o `PendingQuestionRouter` + alvo restrito a panes de agente, testes de integração da interceptação, re-prompt quando a missão é descartada, e watchdog de `speaking` ciente do playback clássico.

**Architecture:** Cada fix é um módulo puro (ou extensão de um existente) + wiring fino nos pontos de efeito. A validação autoritativa de `paneId` fica no MAIN (onde o `PendingQuestionRouter` vive, em `dispatchNexusAction`); o renderer ganha defesa em profundidade com um resolvedor puro de alvo (`send-to-pane-target.ts`). O matcher estrito de afirmativa (item 1) é o que torna SEGURO deixar a pendência sobreviver ao re-wake (item 4a): só confirmação isolada despacha.

**Tech Stack:** TypeScript strict, Vitest (`npx vitest run <arquivo>`), Electron main/renderer.

## Global Constraints

- Arquivos ≤800 linhas; funções pequenas; módulos puros com clock/deps injetados (padrão do diretório `src/renderer/voice/`).
- Strings faladas SEMPRE em PT-BR (persona JARVIS); comentários de código no idioma do arquivo tocado (os módulos C3 usam PT).
- Commits convencionais `fix(voice):` / `test(voice):` — SEM footer de atribuição (desabilitado em `~/.claude/settings.json`).
- Falhar SEMPRE na direção segura: nenhuma mudança pode criar um caminho que despache missão sem "sim" isolado, nem escrever texto de LLM em pane que não seja agente/orquestrador.
- Teste completo da suíte ao final de cada task: `npx vitest run` (deve passar 100%).

---

### Task 1: Matcher estrito de afirmativa (follow-up 1 — MEDIUM)

`AFFIRMATIVE_RE` hoje casa por substring (`pode|vai|isso|ok|beleza|manda|bora|claro|positivo|demorou`): com o mic quente do Live por 15s, "pode abrir o terminal" classifica `yes` e despacha a missão pendente. A fala INTEIRA precisa ser uma confirmação curta e isolada.

**Files:**
- Modify: `src/renderer/voice/delegation-confirm.ts:49-61`
- Test: `src/renderer/voice/delegation-confirm.test.ts`

**Interfaces:**
- Consumes: `norm(text)` (já existe no módulo).
- Produces: `classifyConfirmationReply(text: string): 'yes' | 'no' | 'other'` (assinatura INALTERADA — só o critério de `yes` aperta). Tasks 2 e 5 dependem desse comportamento.

- [ ] **Step 1: Escrever os testes que falham**

Em `src/renderer/voice/delegation-confirm.test.ts`, dentro do `describe('classifyConfirmationReply')`, ADICIONAR após o teste `'resto é other (mudou de assunto)'`:

```ts
  it('afirmativa embutida em comando NÃO confirma — só confirmação isolada (follow-up 1)', () => {
    for (const t of [
      'pode abrir o terminal',
      'vai lá e conserta o bug do login',
      'isso que eu falei ontem tá errado',
      'manda um email pro chefe',
      'beleza, agora abre o navegador',
      'ok jarvis me mostra o board de missões agora',
    ]) {
      expect(classifyConfirmationReply(t)).toBe('other');
    }
  });

  it('confirmações curtas naturais seguem valendo', () => {
    for (const t of [
      'sim',
      'sim, pode mandar',
      'confirmo',
      'confirmado',
      'pode mandar pro squad',
      'manda ver',
      'isso aí',
      'demorou',
      'com certeza',
      'beleza, manda',
    ]) {
      expect(classifyConfirmationReply(t)).toBe('yes');
    }
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/renderer/voice/delegation-confirm.test.ts`
Expected: FAIL — os casos de comando embutido retornam `'yes'` com o regex atual.

- [ ] **Step 3: Implementar o matcher de afirmativa isolada**

Em `src/renderer/voice/delegation-confirm.ts`, SUBSTITUIR o bloco (linhas 49-61):

```ts
const NEGATIVE_RE =
  /\b(nao|cancela|cancelar|espera|pera|para|deixa|esquece|negativo)\b/;
const AFFIRMATIVE_RE =
  /\b(sim|pode|confirmo|confirma|confirmado|manda|vai|bora|positivo|isso|beleza|ok|okay|claro|com certeza|demorou)\b/;

/** Negativa GANHA de afirmativa: "não pode" é não. */
export function classifyConfirmationReply(text: string): 'yes' | 'no' | 'other' {
  const n = norm(text);
  if (!n) return 'other';
  if (NEGATIVE_RE.test(n)) return 'no';
  if (AFFIRMATIVE_RE.test(n)) return 'yes';
  return 'other';
}
```

por:

```ts
const NEGATIVE_RE =
  /\b(nao|cancela|cancelar|espera|pera|para|deixa|esquece|negativo)\b/;

/**
 * Follow-up 1: afirmativa só vale ISOLADA — a fala inteira precisa ser uma
 * confirmação curta ("sim", "pode mandar", "beleza, manda ver"). Um comando não
 * relacionado que apenas CONTÉM palavra afirmativa ("pode abrir o terminal")
 * não despacha: com o mic quente do Live por 15s, substring era gatilho de
 * despacho espúrio. Negativa continua ampla — cancelar é sempre barato.
 */
const AFFIRMATIVE_CORE = new Set([
  'sim',
  'confirmo',
  'confirma',
  'confirmado',
  'pode',
  'manda',
  'mandar',
  'bora',
  'beleza',
  'ok',
  'okay',
  'claro',
  'positivo',
  'demorou',
  'certeza',
  'isso',
]);
/** Apoio tolerado dentro de uma confirmação curta ("manda ver", "isso aí"). */
const AFFIRMATIVE_FILLER = new Set([
  'com',
  'ver',
  'ai',
  'la',
  'e',
  'jarvis',
  'pro',
  'pra',
  'para',
  'o',
  'a',
  'squad',
  'missao',
]);
const AFFIRMATIVE_MAX_WORDS = 6;

function isIsolatedAffirmative(normalized: string): boolean {
  const words = normalized.split(' ');
  if (words.length > AFFIRMATIVE_MAX_WORDS) return false;
  if (!words.some((w) => AFFIRMATIVE_CORE.has(w))) return false;
  return words.every((w) => AFFIRMATIVE_CORE.has(w) || AFFIRMATIVE_FILLER.has(w));
}

/** Negativa GANHA de afirmativa: "não pode" é não. */
export function classifyConfirmationReply(text: string): 'yes' | 'no' | 'other' {
  const n = norm(text);
  if (!n) return 'other';
  if (NEGATIVE_RE.test(n)) return 'no';
  if (isIsolatedAffirmative(n)) return 'yes';
  return 'other';
}
```

Nota: `norm()` já remove acentos e pontuação — "missão"→`missao`, "aí"→`ai`, "não"→`nao`. "vai" saiu do vocabulário de propósito (é começo de imperativo, não confirmação).

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/renderer/voice/delegation-confirm.test.ts`
Expected: PASS (novos + existentes: 'sim', 'pode mandar', 'confirmo', 'manda ver', 'beleza', 'ok' seguem `yes`).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/voice/delegation-confirm.ts src/renderer/voice/delegation-confirm.test.ts
git commit -m "fix(voice): C3 confirm gate exige afirmativa isolada (mata despacho espúrio por substring)"
```

---

### Task 2: Pendência sobrevive re-wake; descarte vira aviso (follow-up 4a)

Hoje `beginListening` limpa a pendência em qualquer captura não-`reply` — "Hey Jarvis, sim" após "Confirmo?" descarta a missão MUDO. Com o matcher estrito da Task 1, é seguro deixar a pendência viver até a primeira fala: "sim" isolado despacha, outro assunto descarta COM aviso no HUD, e o TTL de 15s segue de guarda.

**Files:**
- Modify: `src/renderer/voice/delegation-confirm.ts:63-83`
- Modify: `src/renderer/voice/voice-run-jarvis-turn.ts:89-126`
- Modify: `src/renderer/voice/voice-controller.ts:94,565-569`
- Test: `src/renderer/voice/delegation-confirm.test.ts`

**Interfaces:**
- Consumes: `classifyConfirmationReply` (Task 1).
- Produces: `DelegationReply` ganha a variante `{ kind: 'drop'; delegation: PendingDelegation }` — retornada quando HAVIA pendência mas a resposta foi `other`. `{ kind: 'none' }` passa a significar apenas "não havia pendência viva". Task 5 depende disso.

- [ ] **Step 1: Atualizar o teste de "mudou de assunto" para exigir drop explícito**

Em `src/renderer/voice/delegation-confirm.test.ts`, SUBSTITUIR o teste:

```ts
  it('mudou de assunto → none, missão descartada (NUNCA despacha sem sim)', () => {
    setPendingDelegation(delegation);
    expect(resolveDelegationReply('que horas são?', T0 + 1_000)).toEqual({ kind: 'none' });
    expect(peekPendingDelegation(T0 + 2_000)).toBeNull();
  });
```

por:

```ts
  it('mudou de assunto → drop com a delegação (descartada, mas NUNCA muda: sem sim não despacha)', () => {
    setPendingDelegation(delegation);
    expect(resolveDelegationReply('que horas são?', T0 + 1_000)).toEqual({
      kind: 'drop',
      delegation,
    });
    expect(peekPendingDelegation(T0 + 2_000)).toBeNull();
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/renderer/voice/delegation-confirm.test.ts`
Expected: FAIL — retorna `{ kind: 'none' }`.

- [ ] **Step 3: Implementar o kind 'drop'**

Em `src/renderer/voice/delegation-confirm.ts`, SUBSTITUIR:

```ts
export type DelegationReply =
  | { kind: 'dispatch'; delegation: PendingDelegation }
  | { kind: 'cancel' }
  | { kind: 'none' };

/**
 * Resolve a fala seguinte contra a pendência. QUALQUER desfecho limpa o
 * estado: sim despacha, não cancela, outro assunto descarta a missão.
 */
export function resolveDelegationReply(
  transcript: string,
  now: number,
): DelegationReply {
  const delegation = peekPendingDelegation(now);
  if (!delegation) return { kind: 'none' };
  clearPendingDelegation();
  const reply = classifyConfirmationReply(transcript);
  if (reply === 'yes') return { kind: 'dispatch', delegation };
  if (reply === 'no') return { kind: 'cancel' };
  return { kind: 'none' };
}
```

por:

```ts
export type DelegationReply =
  | { kind: 'dispatch'; delegation: PendingDelegation }
  | { kind: 'cancel' }
  | { kind: 'drop'; delegation: PendingDelegation }
  | { kind: 'none' };

/**
 * Resolve a fala seguinte contra a pendência. QUALQUER desfecho limpa o
 * estado: sim despacha, não cancela, outro assunto descarta ('drop' — o
 * chamador AVISA em vez de sumir mudo; follow-up 4a). 'none' = não havia
 * pendência viva.
 */
export function resolveDelegationReply(
  transcript: string,
  now: number,
): DelegationReply {
  const delegation = peekPendingDelegation(now);
  if (!delegation) return { kind: 'none' };
  clearPendingDelegation();
  const reply = classifyConfirmationReply(transcript);
  if (reply === 'yes') return { kind: 'dispatch', delegation };
  if (reply === 'no') return { kind: 'cancel' };
  return { kind: 'drop', delegation };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/renderer/voice/delegation-confirm.test.ts`
Expected: PASS.

- [ ] **Step 5: Tratar 'drop' no turno e parar de limpar no beginListening**

Em `src/renderer/voice/voice-run-jarvis-turn.ts`, SUBSTITUIR o início da interceptação (linhas 89-92):

```ts
  // C3: se há missão aguardando "Confirmo?", esta fala é a resposta — resolve
  // ANTES do cérebro (o cérebro veria "sim" solto e responderia qualquer coisa).
  const delegationReply = resolveDelegationReply(transcript, Date.now());
  if (delegationReply.kind !== 'none') {
```

por:

```ts
  // C3: se há missão aguardando "Confirmo?", esta fala é a resposta — resolve
  // ANTES do cérebro (o cérebro veria "sim" solto e responderia qualquer coisa).
  const delegationReply = resolveDelegationReply(transcript, Date.now());
  if (delegationReply.kind === 'drop') {
    // Follow-up 4a: descarte não pode ser MUDO — HUD avisa e o turno segue
    // normal pro cérebro (a fala era outro assunto, ela ainda merece resposta).
    store.setNote('Missão pro squad descartada — confirmação não veio.');
    logVoiceEvent('info', 'jarvis.delegationDropped', 'pendência descartada sem confirmação', {
      transcript: transcript.slice(0, 120),
      chars: delegationReply.delegation.text.length,
    });
  } else if (delegationReply.kind !== 'none') {
```

(o corpo do bloco dispatch/cancel fica INALTERADO — só a condição de entrada muda de `if` para `else if`.)

Em `src/renderer/voice/voice-controller.ts`, REMOVER as linhas 565-569:

```ts
    // C3: um comando NOVO (wake/click/manual/ptt) descarta qualquer confirmação
    // de missão ainda pendente — só a resposta de continuidade ('reply') logo
    // após "Confirmo?" pode resolvê-la, senão uma fala não relacionada mais
    // tarde despacharia a missão obsoleta.
    if (reason !== 'reply') clearPendingDelegation();
```

e SUBSTITUIR por:

```ts
    // C3 (follow-up 4a): a pendência de missão NÃO é mais limpa aqui — "Hey
    // Jarvis, sim" agora CONFIRMA em vez de descartar mudo. As guardas contra
    // despacho espúrio são o matcher estrito (afirmativa isolada), o consumo
    // na primeira fala (runJarvisTurn) e o TTL de 15s.
```

e REMOVER o import correspondente (linha 94):

```ts
import { clearPendingDelegation } from './delegation-confirm';
```

- [ ] **Step 6: Rodar a suíte de voz**

Run: `npx vitest run src/renderer/voice`
Expected: PASS (nenhum teste existente referencia o clear no beginListening).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/voice/delegation-confirm.ts src/renderer/voice/delegation-confirm.test.ts src/renderer/voice/voice-run-jarvis-turn.ts src/renderer/voice/voice-controller.ts
git commit -m "fix(voice): re-wake 'sim' confirma a missão pendente; descarte avisa no HUD (C3 follow-up 4a)"
```

---

### Task 3: Sanitização de paneId no MAIN contra o PendingQuestionRouter (follow-up 2, camada autoritativa)

O produtor legítimo de `send_to_pane.paneId` é `routePendingAnswer` (router-validado, `live-transport-controller.ts:694-709`). O vetor de injeção é o modelo Live chamar `comandar`/`nexus_action` com `paneId` arbitrário (`coarse-voice-tools.ts:336`) — hoje isso vira escrita direta sem confirmação. O registro autoritativo vive no main: `dispatchNexusAction` passa a REMOVER `paneId` que não tenha pergunta pendente registrada, derrubando a ação no gate de delegação do renderer.

**Files:**
- Modify: `src/main/voice/live-tool-dispatch.ts:25-95`
- Modify: `src/main/voice/live-transport-controller.ts:140-142` (vizinhança de `noteNarratedQuestion`)
- Test: `src/main/voice/live-tool-dispatch.test.ts` (novo)

**Interfaces:**
- Consumes: `PendingQuestionRouter.questionFor(paneId: string): string | null` (já existe em `src/main/jarvis/realtime/pending-question-router.ts`).
- Produces:
  - `sanitizeNexusActionArgs(args: NexusRealtimeActionArgs, hasPendingQuestion: (paneId: string) => boolean): { args: NexusRealtimeActionArgs; strippedPaneId: string | null }` (pura, exportada de `live-tool-dispatch.ts`).
  - `ToolDispatchHost.hasPendingQuestion(paneId: string): boolean` (novo membro da interface, implementado no `LiveTransportController`).

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/main/voice/live-tool-dispatch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sanitizeNexusActionArgs } from './live-tool-dispatch';
import type { NexusRealtimeActionArgs } from '../jarvis/realtime/nexus-realtime-tools';

const hasQuestionOn = (validPaneId: string) => (paneId: string) => paneId === validPaneId;

describe('sanitizeNexusActionArgs (C3 follow-up 2)', () => {
  it('mantém paneId de send_to_pane quando o pane TEM pergunta pendente no router', () => {
    const args: NexusRealtimeActionArgs = {
      action: 'send_to_pane',
      text: 'usa o Postgres',
      paneId: 'pane-42',
    };
    const out = sanitizeNexusActionArgs(args, hasQuestionOn('pane-42'));
    expect(out.args).toEqual(args);
    expect(out.strippedPaneId).toBeNull();
  });

  it('REMOVE paneId inventado pelo modelo (sem pergunta pendente) — cai no gate de delegação', () => {
    const args: NexusRealtimeActionArgs = {
      action: 'send_to_pane',
      text: 'rm -rf tudo',
      paneId: 'pane-shell',
    };
    const out = sanitizeNexusActionArgs(args, hasQuestionOn('pane-42'));
    expect(out.args).toEqual({ action: 'send_to_pane', text: 'rm -rf tudo' });
    expect('paneId' in out.args).toBe(false);
    expect(out.strippedPaneId).toBe('pane-shell');
  });

  it('não toca em send_to_pane sem paneId nem em outras ações', () => {
    const plain: NexusRealtimeActionArgs = { action: 'send_to_pane', text: 'oi' };
    expect(sanitizeNexusActionArgs(plain, () => false)).toEqual({
      args: plain,
      strippedPaneId: null,
    });
    const ask: NexusRealtimeActionArgs = {
      action: 'ask_pane',
      pergunta: 'status?',
      paneId: 'pane-1',
    };
    expect(sanitizeNexusActionArgs(ask, () => false)).toEqual({
      args: ask,
      strippedPaneId: null,
    });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/main/voice/live-tool-dispatch.test.ts`
Expected: FAIL — `sanitizeNexusActionArgs` não é exportada ainda.

- [ ] **Step 3: Implementar sanitização + host capability**

Em `src/main/voice/live-tool-dispatch.ts`:

(a) ADICIONAR à interface `ToolDispatchHost` (após `armToolResultTimeout`):

```ts
  /** C3 defesa (follow-up 2): o pane tem pergunta pendente narrada no router? */
  hasPendingQuestion(paneId: string): boolean;
```

(b) ADICIONAR a função pura (antes de `dispatchNexusAction`):

```ts
/**
 * C3 defesa (follow-up 2): paneId em send_to_pane só é legítimo quando veio do
 * roteamento de pergunta pendente (PendingQuestionRouter). Um paneId inventado
 * pelo modelo (fora do schema) seria escrita direta SEM confirmação em qualquer
 * pane — aqui ele é removido, derrubando a ação no gate de confirmação de
 * delegação do renderer.
 */
export function sanitizeNexusActionArgs(
  args: NexusRealtimeActionArgs,
  hasPendingQuestion: (paneId: string) => boolean,
): { args: NexusRealtimeActionArgs; strippedPaneId: string | null } {
  if (args.action !== 'send_to_pane' || !args.paneId || hasPendingQuestion(args.paneId)) {
    return { args, strippedPaneId: null };
  }
  const { paneId, ...rest } = args;
  return { args: rest, strippedPaneId: paneId };
}
```

(c) Em `dispatchNexusAction`, RENOMEAR o parâmetro `args` para `rawArgs` e sanitizar na entrada — o corpo existente continua usando `args`:

```ts
export function dispatchNexusAction(
  host: ToolDispatchHost,
  call: RealtimeToolCallEvent,
  rawArgs: NexusRealtimeActionArgs,
): void {
  const { args, strippedPaneId } = sanitizeNexusActionArgs(rawArgs, (paneId) =>
    host.hasPendingQuestion(paneId),
  );
  if (strippedPaneId) {
    logVoice(
      'warn',
      'live.paneIdStripped',
      'send_to_pane com paneId sem pergunta pendente — rebaixado pro gate de delegação',
      { paneId: strippedPaneId },
    );
  }
  const action = realtimeArgsToJarvisAction(args);
  // ... resto do corpo INALTERADO (usa `args`/`argsRecord` como antes) ...
```

Em `src/main/voice/live-transport-controller.ts`, ADICIONAR logo após `noteNarratedQuestion` (linha ~142):

```ts
  /** C3 defesa (follow-up 2): o pane tem pergunta pendente narrada no router? */
  hasPendingQuestion(paneId: string): boolean {
    return this.pendingQuestionRouter.questionFor(paneId) !== null;
  }
```

Nota: o caminho legítimo (`routePendingAnswer` → `dispatchNexusAction`) passa ileso — `decide()` só roteia quando existe pergunta narrada viva, então `hasPendingQuestion(decision.paneId)` é `true` por construção.

- [ ] **Step 4: Rodar e ver passar + typecheck**

Run: `npx vitest run src/main/voice`
Expected: PASS (inclui `live-transport-controller.test.ts` existente — se algum teste construir um host fake estrutural para `dispatchNexusAction`, adicionar `hasPendingQuestion: () => false` a ele).

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/live-tool-dispatch.ts src/main/voice/live-tool-dispatch.test.ts src/main/voice/live-transport-controller.ts
git commit -m "fix(voice): paneId de send_to_pane validado contra o PendingQuestionRouter no main (C3 follow-up 2)"
```

---

**Continua na parte 2** (`2026-07-09-jarvis-c3-hardening-followups-part2.md`): Task 4 (alvo de agente no renderer + pane sumido, follow-ups 2B/4b), Task 5 (testes de integração/wiring, follow-up 3), Task 6 (watchdog de speaking com playback clássico, follow-up 5) e a tabela de cobertura spec→task.
