#!/usr/bin/env node
// Vendored/derived from can1357/oh-my-pi@03c48d073 (MIT)
/**
 * Recorte vendorado do catálogo de modelos do oh-my-pi.
 *
 * Fonte: can1357/oh-my-pi @ 03c48d073 (MIT) — packages/catalog/src/models.json
 * (~1.8MB, 59 providers). Copiar o arquivo inteiro para o bundle seria abuso;
 * este script extrai apenas os providers relevantes ao Nexus e os campos que o
 * main process consome (id, name, api, cost, contextWindow, maxTokens,
 * reasoning, input) para src/vendor/omp/catalog/models-rich.json.
 *
 * Modelos que chegaram pelo catálogo dinâmico depois desse SHA ficam em
 * RELEASE_AUDITED_MODEL_OVERLAYS. Cada entrada exige evidência do seletor
 * exato no OMP release-pinned e mantém a geração do JSON determinística.
 *
 * Uso (re-sync):
 *   git clone https://github.com/can1357/oh-my-pi /tmp/oh-my-pi
 *   git -C /tmp/oh-my-pi checkout <SHA-pinado>
 *   node scripts/vendor-omp-catalog.mjs /tmp/oh-my-pi
 *
 * O JSON gerado é commitado no repo; ver src/vendor/omp/catalog/README.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(root, 'src', 'vendor', 'omp', 'catalog', 'models-rich.json');

/** Providers do omp relevantes aos adapters do Nexus (claude/codex/glm/kimi/grok/agy/omp). */
const PROVIDERS = [
  'anthropic',
  'openai',
  'openai-codex',
  'zai',
  'zhipu-coding-plan',
  'deepseek',
  'xai',
  'google',
  'google-gemini-cli',
  'kimi-code',
  'moonshot',
  'openrouter',
  'sakana',
];

/** Do openrouter (catálogo agregador, ~370 modelos) só interessam estas famílias. */
const OPENROUTER_FAMILY_FILTER = /claude|gpt|glm|deepseek|kimi|grok|gemini/i;

/**
 * Entradas do catálogo dinâmico auditadas contra o OMP 17.0.4 local.
 * Evidência (2026-07-26): `omp models find claude-opus-5 --json
 * --no-extensions` retornou o seletor exato `anthropic/claude-opus-5` e os
 * metadados abaixo.
 */
const RELEASE_AUDITED_MODEL_OVERLAYS = {
  anthropic: {
    // Claude Code 2.1.284 (2026-09-28), registry first_party + tier_2_10.
    'claude-sonnet-5-5': {
      id: 'claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
      api: 'anthropic-messages',
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ['text', 'image'],
    },
    'claude-opus-5-5': {
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      api: 'anthropic-messages',
      cost: {
        input: 5,
        output: 25,
        cacheRead: 0.5,
        cacheWrite: 6.25,
      },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ['text', 'image'],
    },
    'claude-opus-5': {
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      api: 'anthropic-messages',
      cost: {
        input: 5,
        output: 25,
        cacheRead: 0.5,
        cacheWrite: 6.25,
      },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ['text', 'image'],
    },
  },
  openai: {
    'gpt-6-sol': {
      id: 'gpt-6-sol',
      name: 'GPT-6 Sol',
      api: 'openai-responses',
      cost: {
        input: 5,
        output: 30,
        cacheRead: 0.5,
        cacheWrite: 6.25,
      },
      contextWindow: 400_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ['text', 'image'],
    },
    'gpt-6-luna': {
      id: 'gpt-6-luna',
      name: 'GPT-6 Luna',
      api: 'openai-responses',
      cost: {
        input: 1,
        output: 6,
        cacheRead: 0.1,
        cacheWrite: 1.25,
      },
      contextWindow: 400_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ['text', 'image'],
    },
  },
  'openai-codex': {
    'gpt-6-sol': {
      id: 'gpt-6-sol',
      name: 'GPT-6 Sol',
      api: 'openai-codex-responses',
      cost: {
        input: 5,
        output: 30,
        cacheRead: 0.5,
        cacheWrite: 6.25,
      },
      contextWindow: 400_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ['text', 'image'],
    },
    'gpt-6-luna': {
      id: 'gpt-6-luna',
      name: 'GPT-6 Luna',
      api: 'openai-codex-responses',
      cost: {
        input: 1,
        output: 6,
        cacheRead: 0.1,
        cacheWrite: 1.25,
      },
      contextWindow: 400_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ['text', 'image'],
    },
  },
};

/** Campos preservados no recorte — manter em sincronia com RichModelEntry. */
function pickFields(entry) {
  const out = {};
  if (typeof entry.id === 'string') out.id = entry.id;
  if (typeof entry.name === 'string') out.name = entry.name;
  if (typeof entry.api === 'string') out.api = entry.api;
  if (entry.cost && typeof entry.cost === 'object') {
    const cost = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      if (typeof entry.cost[key] === 'number' && Number.isFinite(entry.cost[key])) {
        cost[key] = entry.cost[key];
      }
    }
    if (Object.keys(cost).length > 0) out.cost = cost;
  }
  if (typeof entry.contextWindow === 'number' && Number.isFinite(entry.contextWindow)) {
    out.contextWindow = entry.contextWindow;
  }
  if (typeof entry.maxTokens === 'number' && Number.isFinite(entry.maxTokens)) {
    out.maxTokens = entry.maxTokens;
  }
  if (typeof entry.reasoning === 'boolean') out.reasoning = entry.reasoning;
  if (Array.isArray(entry.input) && entry.input.every((v) => typeof v === 'string')) {
    out.input = entry.input;
  }
  return out;
}

function main() {
  const sourceRoot = process.argv[2];
  if (!sourceRoot) {
    console.error('Uso: node scripts/vendor-omp-catalog.mjs /caminho/para/oh-my-pi');
    console.error('(raiz do clone do oh-my-pi no SHA pinado — ver src/vendor/omp/catalog/README.md)');
    process.exit(1);
  }
  const modelsFile = path.join(sourceRoot, 'packages', 'catalog', 'src', 'models.json');
  if (!fs.existsSync(modelsFile)) {
    console.error(`Fonte não encontrada: ${modelsFile}`);
    process.exit(1);
  }

  const full = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
  const slim = {};
  let totalModels = 0;

  for (const providerId of PROVIDERS) {
    const models = full[providerId];
    if (!models || typeof models !== 'object') {
      console.error(`aviso: provider "${providerId}" ausente na fonte — pulando`);
      continue;
    }
    const candidates = {
      ...models,
      ...(RELEASE_AUDITED_MODEL_OVERLAYS[providerId] ?? {}),
    };
    const kept = {};
    for (const modelId of Object.keys(candidates).sort()) {
      if (providerId === 'openrouter' && !OPENROUTER_FAMILY_FILTER.test(modelId)) continue;
      kept[modelId] = pickFields(candidates[modelId]);
    }
    if (Object.keys(kept).length === 0) continue;
    slim[providerId] = kept;
    totalModels += Object.keys(kept).length;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(slim, null, 2)}\n`);

  const bytes = fs.statSync(OUT_FILE).size;
  console.log(
    `models-rich.json gerado: ${Object.keys(slim).length} providers, ${totalModels} modelos, ${(bytes / 1024).toFixed(1)}KB`,
  );
}

main();
