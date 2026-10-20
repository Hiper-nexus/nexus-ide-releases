/**
 * Prova ao vivo do Grok Imagine (xAI) pelo motor do Nexus (F-1599): roda o
 * mesmo `generateImage`/`generateVideo` do app, com `fetch`, DNS e transporte
 * fixado reais, e mostra o que a xAI respondeu (estrutura, `usage`, polling,
 * host e redirects do download), sem nunca imprimir a chave nem a imagem em
 * base64. Cada execução GERA MÍDIA PAGA.
 *
 * A chave vem só do ambiente do processo (`XAI_API_KEY`), posta por quem
 * roda; o app guarda a dele no cofre, que este script não lê.
 *
 *   npx tsx scripts/xai-imagine-live-check.mts [--kind image|video|both]
 *     [--model <id>] [--resolution 480p|720p|1080p] [--duration 1-15]
 *     [--aspect 16:9] [--image caminho.png] [--prompt "texto"]
 *
 * Padrão (o mais barato da tabela de 10/10/2026): imagem `grok-imagine-image`
 * 1K (US$ 0,02) e vídeo `grok-imagine-video-1.5-lite` 480p de 3 s
 * (US$ 0,02/s = US$ 0,06). Os arquivos ficam numa pasta temporária, impressa
 * no fim.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateImage, generateVideo, type MediaDeps } from '../src/main/media/media-generation.ts';
import { fetchPinnedProviderAsset, type PinnedMediaFetch } from '../src/main/media/media-download.ts';
import { resolveBrowserHostname } from '../src/main/browser/url-policy.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const key = process.env.XAI_API_KEY?.trim();
if (!key) {
  console.error('XAI_API_KEY não está no ambiente deste terminal; nada foi chamado.');
  process.exit(2);
}

const kind = arg('kind') ?? 'both';
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-xai-live-'));
const image = arg('image');
if (image) fs.copyFileSync(path.resolve(image), path.join(baseDir, path.basename(image)));

/** Resumo do corpo sem base64 (a imagem vem em `b64_json`). */
function describeBody(body: unknown): unknown {
  return JSON.parse(
    JSON.stringify(body, (field, value: unknown) =>
      field === 'b64_json' && typeof value === 'string' ? `<${value.length} chars base64>` : value,
    ),
  );
}

const loggingFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const t0 = Date.now();
  const res = await fetch(input, init);
  console.log(`${init?.method ?? 'GET'} ${url.replace(/\?.*$/u, '')} → HTTP ${res.status} em ${Date.now() - t0} ms`);
  if (url.startsWith('https://api.x.ai/')) {
    // O corpo de erro da xAI não ecoa a chave ("Incorrect API key provided").
    const text = await res.clone().text().catch(() => '<corpo ilegível>');
    try {
      console.log(JSON.stringify(describeBody(JSON.parse(text)), null, 2).slice(0, 4000));
    } catch {
      console.log(text.slice(0, 2000));
    }
  }
  return res;
};

/** O download real vai pelo transporte fixado: registra host, status e redirect. */
const loggingPinned: PinnedMediaFetch = async (url, addresses, init) => {
  const t0 = Date.now();
  const res = await fetchPinnedProviderAsset(url, addresses, init);
  const location = res.headers.get('location');
  console.log(
    `download ${url.host}${url.pathname} (IP ${addresses.join(', ')}) → HTTP ${res.status} em ${Date.now() - t0} ms` +
      `${location ? ` · redirect para ${new URL(location, url).host}` : ''}` +
      ` · content-type=${res.headers.get('content-type') ?? '?'} · content-length=${res.headers.get('content-length') ?? '?'}`,
  );
  return res;
};

const deps: MediaDeps = {
  fetchFn: loggingFetch,
  resolveHostname: resolveBrowserHostname,
  fetchPinned: loggingPinned,
  getKey: (def) => (def.envVar === 'XAI_API_KEY' ? key : undefined),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

function report(label: string, result: { path: string }, started: number): void {
  console.log(`\n=== ${label} ===`);
  console.log(
    JSON.stringify({ ...result, bytes: fs.statSync(result.path).size, totalMs: Date.now() - started }, null, 2),
  );
}

let failed = false;
const prompt = arg('prompt');

if (kind === 'image' || kind === 'both') {
  const started = Date.now();
  try {
    const result = await generateImage(
      {
        prompt: prompt ?? 'A lighthouse on a rocky coast during a storm at dusk, dramatic light.',
        provider: 'xai-image',
        model: arg('model') && kind === 'image' ? arg('model') : 'grok-imagine-image',
        aspectRatio: arg('aspect') ?? '16:9',
        ...(image ? { imagePath: path.basename(image) } : {}),
        baseDir,
      },
      deps,
    );
    report('IMAGEM', result, started);
  } catch (err) {
    failed = true;
    console.error('\n=== IMAGEM FALHOU ===');
    console.error(err instanceof Error ? err.message : String(err));
  }
}

if (kind === 'video' || kind === 'both') {
  const started = Date.now();
  try {
    const result = await generateVideo(
      {
        prompt: prompt ?? 'A lighthouse on a rocky coast during a storm at dusk, waves crashing, slow cinematic push-in.',
        provider: 'xai-video',
        model: arg('model') && kind === 'video' ? arg('model') : 'grok-imagine-video-1.5-lite',
        resolution: arg('resolution') ?? '480p',
        durationSeconds: Number(arg('duration') ?? 3),
        aspectRatio: arg('aspect') ?? '16:9',
        ...(image ? { imagePath: path.basename(image) } : {}),
        outPath: 'xai-live.mp4',
        baseDir,
      },
      deps,
    );
    report('VÍDEO', result, started);
    console.log(`\nConfira com: ffprobe -v error -show_entries format=duration:stream=codec_name,width,height -of compact "${result.path}"`);
  } catch (err) {
    failed = true;
    console.error('\n=== VÍDEO FALHOU ===');
    console.error(err instanceof Error ? err.message : String(err));
  }
}

console.log(`\n(pasta: ${baseDir})`);
process.exit(failed ? 1 : 0);
