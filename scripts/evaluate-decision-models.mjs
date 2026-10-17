#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const options = process.argv.slice(2);
if (options.some(option => /^--(?:token|key|api-key|credential)/.test(option))) {
  console.error('Credenciais devem vir do ambiente seguro, nunca dos argumentos.');
  process.exit(2);
}
if (options.includes('--help')) {
  console.log('node --import tsx scripts/evaluate-decision-models.mjs --out <relatório fora do git> [--cases <casos rotulados>]');
  console.log('Credenciais só por ambiente: TYPESAFE_API_KEY, NEXUS_CLEF_API_TOKEN e NEXUS_CLEF_ACCOUNT_ID (nunca as CLOUDFLARE_* do wrangler), OPENAI_API_KEY para Luna.');
  process.exit(0);
}
function argument(name) { const index = options.indexOf(name); return index < 0 ? undefined : options[index + 1]; }
const output = argument('--out');
if (!output) { console.error('Informe --out para um relatório local fora do git.'); process.exit(2); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const casesPath = argument('--cases') ?? path.join(root, 'scripts/fixtures/decision-models/nexus-cases.json');
const { evaluateDecisionCases, decisionEvalCasesSchema, DECISION_EVAL_MODELS } = await import('../src/main/decision-models/decision-evaluation.ts');
const { judgeClef } = await import('../src/main/decision-models/clef-client.ts');
const { judgeLuna } = await import('../src/main/decision-models/luna-client.ts');
const { judgeJevTransport } = await import('../src/main/jev/jev-client.ts');
const parsedCases = decisionEvalCasesSchema.safeParse(JSON.parse(await fs.readFile(casesPath, 'utf8')));
if (!parsedCases.success) {
  console.error('Casos de avaliação inválidos.'); process.exit(2);
}
const cases = parsedCases.data;
const available = { jev: Boolean(process.env.TYPESAFE_API_KEY?.trim()),
  clef: Boolean(process.env.NEXUS_CLEF_API_TOKEN?.trim() && /^[a-fA-F0-9]{32}$/.test(process.env.NEXUS_CLEF_ACCOUNT_ID ?? '')),
  luna: Boolean(process.env.OPENAI_API_KEY?.trim()) };
const eligible = DECISION_EVAL_MODELS.filter(model => available[model.startsWith('clef') ? 'clef' : model]);
const report = await evaluateDecisionCases(cases, async (model, input) => {
  if (model === 'jev') return judgeJevTransport(input, { resolveKey: () => process.env.TYPESAFE_API_KEY });
  if (model === 'luna') return judgeLuna(input, process.env.OPENAI_API_KEY);
  return judgeClef(input, { model, token: process.env.NEXUS_CLEF_API_TOKEN,
    accountId: process.env.NEXUS_CLEF_ACCOUNT_ID });
}, eligible);
await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true, mode: 0o700 });
await fs.writeFile(output, JSON.stringify({ available, ...report }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ available, models: report.models }, null, 2));
