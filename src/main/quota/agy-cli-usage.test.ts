import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchAgyCliUsageWindows, parseAgyCliUsage } from './agy-cli-usage';

const homes: string[] = [];
const payload = {
  status: 'SUCCESS', num_turns: 0,
  command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.75, reset_time: '2026-09-28T12:00:00Z' },
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.9 },
    ] },
    { name: 'Claude and GPT models', buckets: [
      { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1 },
    ] },
  ] } },
};

function binary(body: string, supported = true): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-usage-test-'));
  homes.push(home);
  const file = path.join(home, 'agy');
  fs.writeFileSync(file, `#!${process.execPath}\n// ${supported ? 'non-interactive answers for the read-only slash commands' : 'older CLI'}\n${body}`, { mode: 0o700 });
  return file;
}

afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

describe('AGY native read-only quota', () => {
  it('preserves group identity, cadence, reset and exact remaining fractions', () => {
    const windows = parseAgyCliUsage(JSON.stringify(payload));
    expect(windows).toHaveLength(3);
    expect(windows[0]).toMatchObject({ label: 'Gemini Models · 5 Horas', kind: 'hours' });
    expect(windows[0].usedRatio).toBeCloseTo(0.1);
    expect(windows[1]).toMatchObject({ label: 'Gemini Models · Semanal', kind: 'weekly', usedRatio: 0.25, resetsAt: Date.parse('2026-09-28T12:00:00Z') });
    expect(windows[2]).toMatchObject({ label: 'Claude and GPT models · 5 Horas', usedRatio: 0 });
  });

  it.each([
    'not json', '{}', JSON.stringify({ ...payload, status: 'ERROR' }),
    JSON.stringify({ ...payload, num_turns: 1 }),
    JSON.stringify({ ...payload, command: { name: 'model', data: payload.command.data } }),
    JSON.stringify({ ...payload, command: { name: 'usage', data: { groups: [{ name: 'bad', buckets: [{ remaining_fraction: '1' }] }] } } }),
  ])('does not fabricate quota from malformed or non-command output: %s', (output) => {
    expect(parseAgyCliUsage(output)).toEqual([]);
  });

  it('runs only the bounded read-only command and parses its structured output', async () => {
    const file = binary(`const args = process.argv.slice(2); if (JSON.stringify(args) !== JSON.stringify(['--print', '/quota', '--output-format', 'json', '--print-timeout', '15s'])) process.exit(2); console.log(${JSON.stringify(JSON.stringify(payload))});`);
    expect((await fetchAgyCliUsageWindows({ binary: file }))?.[1].usedRatio).toBe(0.25);
  });

  it('does not execute an older binary without the read-only print capability', async () => {
    const file = binary('require("node:fs").writeFileSync(__filename + ".ran", "yes")', false);
    expect(await fetchAgyCliUsageWindows({ binary: file })).toBeNull();
    expect(fs.existsSync(`${file}.ran`)).toBe(false);
  });

  it('terminates a wedged owned process and returns no reading', async () => {
    const file = binary('setInterval(() => {}, 1000)');
    expect(await fetchAgyCliUsageWindows({ binary: file, timeoutMs: 100 })).toBeNull();
  });
});
