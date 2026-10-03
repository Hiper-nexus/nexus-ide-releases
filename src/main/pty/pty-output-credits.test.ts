import { expect, it } from 'vitest';
import { PtyOutputCredits } from './pty-output-credits';
it('bounds host transport while controls remain independent and resumes without byte loss', () => {
  let output = ''; const flow: boolean[] = [];
  const credits = new PtyOutputCredits({ send: (part) => { output += part; }, pause: () => flow.push(true), resume: () => flow.push(false) }, 64);
  credits.push('é'.repeat(64));
  expect(Buffer.byteLength(output)).toBe(64);
  expect(credits.pendingBytes()).toBe(64);
  expect(flow).toEqual([true]);
  credits.grant(64);
  expect(output).toBe('é'.repeat(64));
  credits.grant(64);
  expect(flow.at(-1)).toBe(false);
  expect(credits.pendingBytes()).toBe(0);
});
it('drains already received output before publishing physical exit', () => {
  const events: string[] = [];
  const credits = new PtyOutputCredits({ send: (part) => events.push(part), pause: () => {}, resume: () => {} }, 4);
  credits.push('abcdef');
  credits.seal(() => events.push('exit'));
  expect(events).toEqual(['abcd', 'ef', 'exit']);
  credits.grant(4);
  expect(events).toEqual(['abcd', 'ef', 'exit']);
});
