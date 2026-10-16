import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface CliReport {
  available: Record<string, boolean>;
  observations: Array<{ requestedModel: string; status: string; correct: boolean | null; requestCount?: number }>;
  models: Record<string, { failures: number; heldout: { accuracy: number | null } }>;
}
interface ClientCall { url: string; model: string }

function evaluateWithCredentials(credentials: Record<string, string>) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'nexus-decision-cli-'));
  const output = path.join(directory, 'report.json');
  const requests = path.join(directory, 'requests.jsonl');
  const cases = path.join(directory, 'cases.json');
  const mock = path.join(directory, 'mock-fetch.mjs');
  writeFileSync(cases, JSON.stringify([{
    id: 'synthetic-cli', surface: 'toolPick', split: 'heldout', state: 'synthetic only',
    questions: { ready: { type: 'noul', instructions: 'Is the fixture ready?' } }, expected: { ready: true },
  }]));
  writeFileSync(mock, `import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      appendFileSync(process.env.NEXUS_TEST_REQUESTS, JSON.stringify({ url: String(url), model: body.model }) + '\\n');
      const usage = { input_tokens: 10, output_tokens: 1 };
      if (String(url).startsWith('https://api.openai.com/')) return Response.json({
        model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'q0', probability: 1 }], usage,
      });
      if (String(url).startsWith('https://api.cloudflare.com/')) return Response.json({ success: true, result: {
        model: body.model, answers: { q0: { type: 'noul', noul: 1 } }, usage,
      } });
      if (String(url).startsWith('https://api.typesafe.ai/')) return Response.json({
        model: 'jev-1.13', answers: { ready: { type: 'noul', noul: 1 } }, usage,
      });
      throw Error('Unexpected endpoint; network disabled in this fixture');
    };`);
  try {
    const result = spawnSync(process.execPath, ['--import', mock, '--import', 'tsx',
      'scripts/evaluate-decision-models.mjs', '--cases', cases, '--out', output], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, TYPESAFE_API_KEY: '', NEXUS_CLEF_API_TOKEN: '', NEXUS_CLEF_ACCOUNT_ID: '',
        OPENAI_API_KEY: '', NEXUS_JEV_MODEL: 'jev-latest', ...credentials, NEXUS_TEST_REQUESTS: requests },
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(output, 'utf8')) as CliReport;
    const calls = (() => { try { return readFileSync(requests, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch { return []; } })() as ClientCall[];
    return { report, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('decision evaluation CLI', () => {
  it('rejects credential arguments instead of accepting secrets into shell history', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/evaluate-decision-models.mjs', '--token', 'synthetic-private-token'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Credenciais');
    expect(result.stderr).not.toContain('synthetic-private-token');
  });

  it('evaluates Luna through its real client when only an OpenAI key is available', () => {
    const { report, calls } = evaluateWithCredentials({ OPENAI_API_KEY: 'synthetic-openai-key' });
    expect(report.available).toEqual({ jev: false, clef: false, luna: true });
    expect(report.observations).toHaveLength(1);
    expect(report.observations[0]).toMatchObject({ requestedModel: 'luna', status: 'answered', correct: true, requestCount: 1 });
    expect(calls).toEqual([{ url: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna' }]);
  });

  it('does not manufacture failed evaluations for providers without credentials', () => {
    const { report, calls } = evaluateWithCredentials({});
    expect(report.observations).toEqual([]);
    expect(calls).toEqual([]);
    expect(Object.values(report.models).every(model => model.failures === 0 && model.heldout.accuracy === null)).toBe(true);
  });

  it('uses each real provider client once when all evaluation credentials exist', () => {
    const { report, calls } = evaluateWithCredentials({ TYPESAFE_API_KEY: 'synthetic-jev-key',
      NEXUS_CLEF_API_TOKEN: 'synthetic-clef-token', NEXUS_CLEF_ACCOUNT_ID: 'a'.repeat(32), OPENAI_API_KEY: 'synthetic-openai-key' });
    expect(report.observations).toHaveLength(5);
    expect(report.observations.every(row => row.status === 'answered' && row.correct && row.requestCount === 1)).toBe(true);
    expect(calls.filter(call => call.url.startsWith('https://api.openai.com/'))).toHaveLength(1);
    expect(calls.filter(call => call.url.startsWith('https://api.cloudflare.com/'))).toHaveLength(3);
    expect(calls.filter(call => call.url.startsWith('https://api.typesafe.ai/'))).toHaveLength(1);
  });
});
