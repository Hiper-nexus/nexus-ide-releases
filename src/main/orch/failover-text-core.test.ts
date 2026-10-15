import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FailoverTextReducer } from './failover-text-core';
import { FAILOVER_HANDOFF_FOOTER, FAILOVER_HANDOFF_HEADER } from '../../shared/failover-handoff';

// Logical timestamps drive ordering; unrelated host pauses must not trigger the scan budget.
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(1_000); });
afterEach(() => { vi.restoreAllMocks(); });

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

it('F-1484: confirmação do provedor no rearme de um hit textual o promove, uma vez', () => {
  const reducer = new FailoverTextReducer();
  const confirmed = { kind: 'rate-limit' as const, reason: 'Claude StopFailure (limite de uso)', cooldownMs: 900_000,
    confirmed: true, confirmedAt: 1_200 };
  // O texto do PTY chega antes do hook e dispara sem confirmação.
  expect(hits(reducer.feed('usage limit reached\n', 1_000))[0]?.hit?.confirmed).toBeUndefined();
  // Erro de hook SEM confirmação no rearme continua descartado.
  expect(hits(reducer.observer({ kind: 'rate-limit', reason: 'usage limit reached', cooldownMs: 60_000 }, 1_100))).toEqual([]);
  // A confirmação estruturada promove o limite em vez de sumir.
  expect(hits(reducer.observer(confirmed, 1_200))[0]?.hit).toMatchObject({ confirmed: true, confirmedAt: 1_200 });
  // Já confirmado: nem outra confirmação nem texto disparam de novo no rearme.
  expect(hits(reducer.observer({ ...confirmed, confirmedAt: 1_300 }, 1_300))).toEqual([]);
  expect(hits(reducer.feed('usage limit reached\n', 1_400))).toEqual([]);
});

it('F-1517: a slow scan keeps queued quota evidence and replays it after backoff', () => {
  const reducer = new FailoverTextReducer();
  // One scan costs 40 ms; subsequent scans use a stable clock.
  vi.mocked(Date.now).mockReturnValueOnce(1_000).mockReturnValue(1_040);
  expect(reducer.feed('x'.repeat(2_000), 1_000)).toContainEqual(expect.objectContaining({ slowScanMs: 40 }));
  expect(reducer.slowUntil).toBe(6_000);
  expect(reducer.feed('\nusage limit reached\n', 1_200)).toEqual([]);
  expect(reducer.feed('', 5_999, true)).toEqual([]);
  expect(reducer.feed('', 6_000, true)).toContainEqual(expect.objectContaining({ hit: expect.objectContaining({ kind: 'rate-limit' }) }));
});

it('F-1517: slow-scan overflow becomes unavailable instead of reporting incomplete coverage', () => {
  const reducer = new FailoverTextReducer();
  vi.mocked(Date.now).mockReturnValueOnce(1_000).mockReturnValue(1_040);
  reducer.feed('x'.repeat(2_000), 1_000);
  expect(reducer.feed('x'.repeat(262_144), 1_100)).toEqual([]);
  expect(reducer.feed('x', 1_200)).toContainEqual(expect.objectContaining({ unavailable: true }));
  const afterBackoff = reducer.feed('\nusage limit reached\n', 6_000, true);
  expect(afterBackoff).toContainEqual(expect.objectContaining({ unavailable: true }));
  expect(afterBackoff.some((proposal) => proposal.hit)).toBe(false);
});
