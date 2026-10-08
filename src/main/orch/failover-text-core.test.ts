import { expect, it } from 'vitest';
import { FailoverTextReducer } from './failover-text-core';
import { FAILOVER_HANDOFF_FOOTER, FAILOVER_HANDOFF_HEADER } from '../../shared/failover-handoff';
it('orders transient errors before progress and distinguishes repaint from a fresh retry', () => {
  const reducer = new FailoverTextReducer();
  const error = 'API Error: 503 service unavailable attempt 1/10\n';
  expect(reducer.feed(error, 1_000).find((v) => v.hit)?.hit?.kind).toBe('transient');
  const response = 'A new response from the model with meaningful content. '.repeat(10) + '\n';
  expect(reducer.feed(response, 1_100).at(-1)?.progressChars).toBeGreaterThan(400);
  expect(reducer.feed(error, 1_200).at(-1)?.progressChars).toBeGreaterThan(400);
  expect(reducer.feed(error.replace('1/10', '2/10'), 1_300).at(-1)?.progressChars).toBe(0);
});
it('a real limit after 503 bypasses transient rearm, then Main episode controls revoke progress', () => {
  const reducer = new FailoverTextReducer();
  reducer.feed('API Error: 503 service unavailable\n', 1_000);
  expect(reducer.feed('usage limit reached\n', 1_100).at(-1)?.hit?.kind).toBe('rate-limit');
  expect(reducer.feed('usage limit reached\n', 1_200)).toEqual([]);
  reducer.control({ firedAt: 1_100, endTransient: true });
  expect(reducer.feed('A real response from the model after the event.\n', 1_300)).toEqual([]);
});

/** Eco de um pack de continuidade na sessão nova (o header abre a janela de confirmação). */
const PACK_ECHO = `${FAILOVER_HANDOFF_HEADER}\nAccount "x" hit a provider limit (kind model).\nContinue as the agent from the next pending step.\n${FAILOVER_HANDOFF_FOOTER}\n`;
const hits = (proposals: ReturnType<FailoverTextReducer['feed']>) => proposals.filter((proposal) => proposal.hit);

it('F-999: sinal de modelo logo depois do pack só vale na 2ª ocorrência fora do eco', () => {
  const reducer = new FailoverTextReducer();
  expect(hits(reducer.feed(PACK_ECHO, 1_000))).toEqual([]);
  // O worker novo cita o motivo em prosa depois de ler o pack: não é sinal vivo.
  const quoted = reducer.feed('Retomando: a sessão anterior caiu com model_not_found, sigo daqui.\n', 5_000);
  expect(hits(quoted)).toEqual([]);
  expect(quoted.find((proposal) => proposal.held)?.held?.kind).toBe('model');
  // A mesma frase de novo, em saída NOVA (a CLI repetiu o erro): confirma.
  expect(hits(reducer.feed('Error: model_not_found\n', 40_000))[0]?.hit?.kind).toBe('model');
});

it('F-999: sem pack de continuidade o sinal de modelo vale na 1ª ocorrência', () => {
  const reducer = new FailoverTextReducer();
  expect(hits(reducer.feed('Error: model_not_found\n', 5_000))[0]?.hit?.kind).toBe('model');
});

it('F-999: a própria CLI (observer) confirma na hora, mesmo logo depois do pack', () => {
  const reducer = new FailoverTextReducer();
  reducer.feed(PACK_ECHO, 1_000);
  const proposals = reducer.observer({ kind: 'model', reason: 'model_not_found', cooldownMs: 300_000 }, 2_000);
  expect(hits(proposals)[0]?.hit?.kind).toBe('model');
});

it('F-999: limite de conta logo depois do pack não espera (a sonda do provider decide)', () => {
  const reducer = new FailoverTextReducer();
  reducer.feed(PACK_ECHO, 1_000);
  expect(hits(reducer.feed('usage limit reached\n', 2_000))[0]?.hit?.kind).toBe('rate-limit');
});

it('F-999: passada a janela de confirmação, o sinal de modelo vale na hora', () => {
  const reducer = new FailoverTextReducer();
  reducer.feed(PACK_ECHO, 1_000);
  expect(hits(reducer.feed('Error: model_not_found\n', 1_000 + 121_000))[0]?.hit?.kind).toBe('model');
});
