// A Qwen Code REAL contra o overlay do Nexus, com SAFE e EVIL em loopback.
//
//   npx tsx run.mjs --wt <raiz do nexus-ide> [--scenarios scenarios.mjs] [--only <trecho>]
//                   [-c 4] [--timeout 60000] [--json saida.json] [--keep] [--debug]
//
// O `--wt` aponta para uma árvore com `src/main/orch/cli-mcp-session-qwen.ts`: a
// atual ou uma exportada com `git archive <sha> src shared` (linha de base).
// Precisa do `qwen` 0.25.2 no PATH, do `openssl` e do Node 22. HOME e QWEN_HOME
// são descartáveis; nada do perfil real do operador é lido.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CA_FILE, scripts, startServers } from './servers.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : fallback;
};
const ROOT = path.resolve(option('--wt', process.env.WT ?? ''));
const ONLY = option('--only', '');
const CONCURRENCY = Number(option('-c', '3'));
const TIMEOUT_MS = Number(option('--timeout', '60000'));
const JSON_OUT = option('--json', '');
const KEEP = argv.includes('--keep');
const DEBUG = argv.includes('--debug');
if (!fs.existsSync(path.join(ROOT, 'src/main/orch/cli-mcp-session-qwen.ts'))) {
  console.error('--wt precisa apontar para uma árvore do nexus-ide');
  process.exit(2);
}

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { prepareQwenMcpSession } = await load('src/main/orch/cli-mcp-session-qwen.ts');
const { cleanupCliMcpSession } = await load('src/main/orch/cli-mcp-session-artifacts.ts');
const { scenarios } = await import(pathToFileURL(path.resolve(option('--scenarios', 'scenarios.mjs'))).href);
const servers = await startServers();

/** Substitui os marcadores (@SAFE@, @EVIL@, @KEY@…) em qualquer string do valor. */
function fill(value, ctx) {
  if (typeof value === 'string') {
    return value
      .replaceAll('@SAFE@', ctx.safeUrl)
      .replaceAll('@EVIL@', ctx.evilUrl)
      .replaceAll('@EVILHTTP@', ctx.evilHttpUrl)
      .replaceAll('@KEYLOWER@', ctx.keyEnv.toLowerCase())
      .replaceAll('@KEYMIXED@', ctx.keyEnv.replace(/NEXUS_QWEN/, 'Nexus_Qwen'))
      .replaceAll('@KEYVALUE@', ctx.keyValue)
      .replaceAll('@KEY@', ctx.keyEnv)
      .replaceAll('@OLD@', ctx.oldSecret);
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, ctx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [fill(key, ctx), fill(item, ctx)]));
  }
  return value;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const asText = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/** Arquivos do overlay (fora de links) que contêm algum dos segredos. */
function scanForSecrets(dir, needles) {
  const found = [];
  const walk = (current) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(file); continue; }
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const needle of needles) if (text.includes(needle)) found.push(`${path.relative(dir, file)} contém ${needle.slice(0, 14)}…`);
    }
  };
  walk(dir);
  return found;
}

async function runScenario(sc) {
  const id = sc.id;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `qwen-loopback-${id}-`));
  const home = path.join(root, 'home');
  const providerHome = path.join(home, '.qwen');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(providerHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const key = `sk-fixture-${id}-${crypto.randomBytes(8).toString('hex')}`;
  const ctx = {
    keyValue: key,
    keyEnv: `NEXUS_QWEN_KEY_${crypto.randomBytes(16).toString('hex')}`,
    oldSecret: `OLDSECRET-${id}-${crypto.randomBytes(4).toString('hex')}`,
    safeUrl: `https://localhost:${servers.safe.port}/${id}/safe/v1`,
    evilUrl: `https://localhost:${servers.evil.port}/${id}/evil/v1`,
    evilHttpUrl: `http://127.0.0.1:${servers.evil.httpPort}/${id}/evilhttp/v1`,
  };
  const resolved = (value) => fill(typeof value === 'function' ? value(ctx) : value, ctx);

  // Arquivos do cenário: operador (~/.qwen), workspace, .env e settings de admin.
  const user = sc.user === undefined ? { model: { name: 'qwen3.8-max' } } : resolved(sc.user);
  if (user !== null) write(path.join(providerHome, 'settings.json'), asText(user));
  if (sc.userEnvFile) write(path.join(providerHome, '.env'), resolved(sc.userEnvFile));
  if (sc.ws !== undefined) write(path.join(workspace, '.qwen', 'settings.json'), asText(resolved(sc.ws)));
  if (sc.wsEnvFile) write(path.join(workspace, '.env'), resolved(sc.wsEnvFile));
  if (sc.wsQwenEnvFile) write(path.join(workspace, '.qwen', '.env'), resolved(sc.wsQwenEnvFile));
  for (const [rel, text] of Object.entries(sc.wsFiles ?? {})) write(path.join(workspace, rel), resolved(text));
  const adminSettings = sc.system === undefined ? undefined : path.join(root, 'admin', 'settings.json');
  const adminDefaults = sc.systemDefaults === undefined ? undefined : path.join(root, 'admin', 'system-defaults.json');
  if (adminSettings) write(adminSettings, asText(resolved(sc.system)));
  if (adminDefaults) write(adminDefaults, asText(resolved(sc.systemDefaults)));

  const token = `loopback-${id}-${crypto.randomBytes(4).toString('hex')}`;
  const prepared = prepareQwenMcpSession('http://127.0.0.1:9/mcp', token, {
    home,
    providerHome,
    userDataPath: path.join(root, 'userData'),
    artifactRoot: path.join(root, 'artifacts'),
    checkoutId: `c-${id}`,
    cwd: workspace,
    workspaceRoot: workspace,
    ...(sc.governed ? { governed: true, allowedSkills: [], allowedTools: [] } : {}),
    qwenSettingsInjection: {
      baseUrl: ctx.safeUrl,
      models: sc.injectionModels ?? ['qwen3.8-max'],
      tokenPlanKey: false,
      envKey: ctx.keyEnv,
    },
    // Ignorados pelo código de antes da correção, que não conhece o layer de sistema.
    ...(adminSettings ? { qwenSystemSettingsPath: adminSettings } : {}),
    ...(adminDefaults ? { qwenSystemDefaultsPath: adminDefaults } : {}),
  });

  const env = {
    PATH: process.env.PATH,
    HOME: home,
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
    ...prepared.env,
    [ctx.keyEnv]: key,
    NODE_EXTRA_CA_CERTS: CA_FILE,
    ...(sc.envExtra ? resolved(sc.envExtra) : {}),
  };
  if (sc.toolCall) scripts.set(id, typeof sc.toolCall === 'function' ? sc.toolCall({ workspace }) : sc.toolCall);
  const args = ['--model', sc.model ?? 'qwen3.8-max', '--approval-mode', sc.approval ?? 'plan', ...prepared.extraArgs, '-p', 'Say hello in one word.'];
  const started = Date.now();
  const outcome = await new Promise((resolve) => {
    const child = spawn('qwen', args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 'timeout', output }); }, TIMEOUT_MS);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
  await new Promise((resolve) => setTimeout(resolve, 150));

  const withKey = (hits) => hits.filter((hit) => JSON.stringify(hit).includes(key));
  const mine = (hits) => hits.filter((hit) => (hit.url ?? '').startsWith(`/${id}/`));
  const wire = JSON.stringify([...mine(servers.safe.hits), ...mine(servers.evil.hits)]);
  const missing = (sc.probe?.has ?? []).filter((marker) => !wire.includes(marker));
  const unexpected = (sc.probe?.lacks ?? []).filter((marker) => wire.includes(marker));
  const collected = Object.fromEntries((sc.collect ?? []).map((rel) => {
    try { return [rel, fs.readFileSync(path.join(workspace, rel), 'utf8').split(key).join('<KEY>')]; } catch (error) { return [rel, `(ausente: ${error.code})`]; }
  }));
  const record = {
    id,
    group: sc.group ?? '',
    expect: sc.expect ?? 'safe-only',
    leak: withKey(servers.evil.hits).length > 0,
    safeKeyHits: withKey(servers.safe.hits).length,
    evilHits: mine(servers.evil.hits).length,
    secretsOnDisk: prepared.artifactDir ? scanForSecrets(prepared.artifactDir, [key, ctx.oldSecret]) : [],
    ...(sc.probe ? { probe: { ok: missing.length === 0 && unexpected.length === 0, missing, unexpected } } : {}),
    ...(Object.keys(collected).length ? { collected } : {}),
    exit: outcome.code,
    ...(DEBUG ? {
      ms: Date.now() - started,
      desc: sc.desc ?? '',
      tail: outcome.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim().split('\n').slice(-3).join(' | ').slice(0, 240),
      overlay: prepared.artifactDir ? fs.readdirSync(prepared.artifactDir).sort() : [],
    } : {}),
    ...(KEEP ? { root, artifactDir: prepared.artifactDir } : {}),
  };
  if (!KEEP) {
    try { cleanupCliMcpSession(token); } catch { /* melhor esforço */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
  return record;
}

const selected = scenarios.filter((sc) => !ONLY || sc.id.includes(ONLY) || (sc.group ?? '').includes(ONLY));
const results = [];
let cursor = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let index = cursor++; index < selected.length; index = cursor++) {
    try {
      const record = await runScenario(selected[index]);
      results.push(record);
      const flag = record.leak ? 'LEAK' : record.secretsOnDisk.length ? 'DISK' : record.probe && !record.probe.ok ? 'PROB' : 'ok  ';
      console.log(`${flag} ${record.id.padEnd(34)} safeKey=${record.safeKeyHits} evil=${record.evilHits} exit=${record.exit}${record.probe && !record.probe.ok ? ` falta=${record.probe.missing.join('|')} sobra=${record.probe.unexpected.join('|')}` : ''}`);
    } catch (error) {
      results.push({ id: selected[index].id, error: String(error?.stack ?? error), leak: false, secretsOnDisk: [] });
      console.log(`ERR  ${selected[index].id}: ${String(error?.message ?? error).slice(0, 200)}`);
    }
  }
}));
await servers.close();

results.sort((a, b) => a.id.localeCompare(b.id));
const kind = (record) => record.expect ?? 'safe-only';
const declarative = results.filter((r) => !r.error && ['safe-only', 'safe-key'].includes(kind(r)));
const leaks = declarative.filter((r) => r.leak);
const controlFails = declarative.filter((r) => kind(r) === 'safe-key' && r.safeKeyHits < 1);
const sanity = results.filter((r) => kind(r) === 'leak-expected');
const sanityFails = sanity.filter((r) => !r.leak);
const probes = results.filter((r) => r.probe);
const probeFails = probes.filter((r) => !r.probe.ok);
const onDisk = results.filter((r) => r.secretsOnDisk.length);
const errors = results.filter((r) => r.error);
console.log(`\ndeclarativos=${declarative.length} VAZAMENTOS=${leaks.length}/${declarative.length} controles-que-falharam=${controlFails.length} probes=${probes.length - probeFails.length}/${probes.length} segredo-em-disco=${onDisk.length} erros=${errors.length}`);
console.log(`sanidade do detector: ${sanity.length - sanityFails.length}/${sanity.length} viram o vazamento plantado`);
console.log(`classe de execução de código (informativo): ${results.filter((r) => kind(r) === 'exec-class').map((r) => `${r.id}=${r.leak ? 'VAZA' : 'não vaza'}`).join(' ') || '-'}`);
if (leaks.length) console.log('VAZARAM:', leaks.map((r) => r.id).join(', '));
if (probeFails.length) console.log('PROBES FALHARAM:', probeFails.map((r) => r.id).join(', '));
if (controlFails.length) console.log('CONTROLES FALHARAM:', controlFails.map((r) => r.id).join(', '));
if (JSON_OUT) fs.writeFileSync(JSON_OUT, `${JSON.stringify(results, null, 2)}\n`);
process.exit(leaks.length || errors.length || controlFails.length || sanityFails.length || probeFails.length || onDisk.length ? 1 : 0);
