#!/usr/bin/env node
// Exporta os benchmarks OFICIAIS que o NexusIDE usa no roteador (nexus-ide/src/main/orch/published-benchmarks.ts) para
// `src/benchmarks/data.js`, que alimenta a página pública /benchmarks/. Os números são os que cada fabricante publicou,
// com a fonte primária; célula ausente significa "o fabricante não publicou" e nunca é estimada.
//
//   npm run benchmarks:update            (usa ../nexus-ide)      NEXUS_IDE_PATH=/outro/caminho npm run benchmarks:update
//
// Falha se aparecer um modelo novo sem nome de exibição (LABELS) ou sem fabricante (VENDORS): é de propósito, para que um
// modelo novo não entre na página com nome técnico feio nem sem revisão.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(process.env.NEXUS_IDE_PATH ?? resolve(HERE, '..', '..', 'nexus-ide'));
const SOURCE_FILE = resolve(APP, 'src/main/orch/published-benchmarks.ts');
const OUTPUT = resolve(HERE, '..', 'src/benchmarks/data.js');

const VENDORS = {
  claude: 'Anthropic', codex: 'OpenAI', grok: 'xAI', glm: 'Z.ai', agy: 'Google', kimi: 'Moonshot AI', devin: 'Cognition',
  longcat: 'Meituan', deepseek: 'DeepSeek', muse: 'Meta', 'mimo-code': 'Xiaomi', 'minimax-code': 'MiniMax',
};

const LABELS = {
  'claude:claude-opus-5-5': 'Claude Opus 5.5', 'claude:claude-opus-5': 'Claude Opus 5', 'claude:claude-fable-5-1': 'Claude Fable 5.1',
  'claude:claude-mythos-5-1': 'Claude Mythos 5.1', 'claude:claude-fable-5': 'Claude Fable 5', 'claude:claude-opus-4-8': 'Claude Opus 4.8',
  'claude:claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude:claude-sonnet-5': 'Claude Sonnet 5', 'claude:claude-haiku-4-5': 'Claude Haiku 4.5',
  'codex:gpt-6.1-sol': 'GPT-6.1 Sol', 'codex:gpt-6-sol': 'GPT-6 Sol', 'codex:gpt-6-luna': 'GPT-6 Luna', 'codex:gpt-6-astra': 'GPT-6 Astra',
  'codex:gpt-5.6-sol': 'GPT-5.6 Sol', 'codex:gpt-5.6-terra': 'GPT-5.6 Terra', 'codex:gpt-5.6-luna': 'GPT-5.6 Luna',
  'grok:grok-4.7': 'Grok 4.7', 'grok:grok-4.7-build-fast': 'Grok 4.7 Build Fast', 'grok:grok-4.6': 'Grok 4.6', 'grok:grok-4.5': 'Grok 4.5',
  'glm:glm-5.3': 'GLM-5.3', 'glm:glm-5.3-flash': 'GLM-5.3 Flash', 'glm:glm-5.2': 'GLM-5.2', 'glm:glm-4.7': 'GLM-4.7',
  'glm:glm-4.5-air': 'GLM-4.5 Air', 'glm:glm-4.7-flash': 'GLM-4.7 Flash',
  'agy:gemini-4-argon': 'Gemini 4 Argon', 'agy:gemini-3.8-flash': 'Gemini 3.8 Flash', 'agy:gemini-3.7-flash': 'Gemini 3.7 Flash', 'agy:gemini-3.6-flash': 'Gemini 3.6 Flash',
  'kimi:kimi-code/k3': 'Kimi K3', 'devin:swe-2': 'SWE-2', 'longcat:LongCat-2.0': 'LongCat 2.0',
  'deepseek:deepseek-flash': 'DeepSeek V4.1 Flash', 'deepseek:deepseek-v4-pro': 'DeepSeek V4 Pro', 'muse:muse-spark-1.3': 'Muse Spark 1.3',
  'mimo-code:xiaomi/mimo-v2.6-pro': 'MiMo V2.6 Pro', 'mimo-code:xiaomi/mimo-v2.6-flash': 'MiMo V2.6 Flash',
  'minimax-code:minimax/MiniMax-M3.1-Flash-Preview': 'MiniMax M3.1 Flash Preview', 'minimax-code:minimax/MiniMax-M3': 'MiniMax M3',
  'minimax-code:minimax/MiniMax-M2.7': 'MiniMax M2.7', 'minimax-code:minimax/MiniMax-M2.7-highspeed': 'MiniMax M2.7 Highspeed',
};

const header = readFileSync(SOURCE_FILE, 'utf8').slice(0, 2500);
const collected = /coletada em (\d{4}-\d{2}-\d{2})/.exec(header);
if (!collected) throw new Error('o cabeçalho de published-benchmarks.ts não traz "coletada em AAAA-MM-DD"');

const dump = execFileSync('npx', ['--no-install', 'tsx', '-e',
  "import { PUBLISHED_BENCHMARKS } from './src/main/orch/published-benchmarks.ts'; console.log(JSON.stringify(PUBLISHED_BENCHMARKS));"],
{ cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const raw = JSON.parse(dump.slice(dump.indexOf('{')));

const models = Object.entries(raw).map(([key, entry]) => {
  const provider = key.slice(0, key.indexOf(':'));
  if (!LABELS[key]) throw new Error(`modelo novo sem nome de exibição: ${key} (acrescente em LABELS)`);
  if (!VENDORS[provider]) throw new Error(`fabricante sem nome: ${provider} (acrescente em VENDORS)`);
  const out = { key, label: LABELS[key], vendor: VENDORS[provider], source: entry.source };
  for (const field of ['deepSWE', 'terminalBench21', 'swebenchVerified']) if (typeof entry[field] === 'number') out[field] = entry[field];
  // Variante que o fabricante declara ser o mesmo modelo, e herança de nota de antecessor: ficam como nota, nunca como número próprio.
  if (entry.sameModelAs) out.sameModelAs = entry.sameModelAs;
  if (entry.successorOf) out.successorOf = entry.successorOf;
  return out;
});

const body = `// GERADO por scripts/update-benchmarks.mjs a partir de nexus-ide/src/main/orch/published-benchmarks.ts. Não edite à mão.
// Números oficiais dos fabricantes, com a fonte primária; sem número publicado, a célula fica vazia (nunca estimada).
export default ${JSON.stringify({ collectedAt: collected[1], source: 'nexus-ide/src/main/orch/published-benchmarks.ts', models }, null, 2)};
`;
writeFileSync(OUTPUT, body);
console.log(`Benchmarks exportados: ${models.length} modelos, coletados em ${collected[1]}.`);
