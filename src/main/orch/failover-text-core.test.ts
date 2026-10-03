import { expect, it } from 'vitest';
import { FailoverTextReducer } from './failover-text-core';
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
