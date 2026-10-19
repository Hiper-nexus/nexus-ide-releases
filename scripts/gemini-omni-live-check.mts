/**
 * Prova ao vivo do Gemini Omni Flash pelo motor do Nexus (F-1587): roda o
 * mesmo `generateVideo` do app, com `fetch`, DNS e transporte fixado reais, e
 * mostra o que o Google respondeu (estrutura, `usage`, Files API), sem nunca
 * imprimir a chave nem o vídeo em base64. Cada execução GERA UM VÍDEO PAGO.
 *
 * A chave vem só do ambiente do processo (`GEMINI_API_KEY`), posta por quem
 * roda; o app guarda a dele no cofre, que este script não lê.
 *
 *   npx tsx scripts/gemini-omni-live-check.mts [--resolution 360p|720p|1080p|4k]
 *     [--aspect 16:9|9:16] [--image caminho.png] [--prompt "texto"]
 *
 * Padrão: 360p (US$ 0,03/s de lista, o mais barato). O vídeo fica numa pasta
 * temporária, impressa no fim.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateVideo, type MediaDeps } from '../src/main/media/media-generation.ts';
import { fetchPinnedProviderAsset } from '../src/main/media/media-download.ts';
import { resolveBrowserHostname } from '../src/main/browser/url-policy.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const key = process.env.GEMINI_API_KEY?.trim();
if (!key) {
  console.error('GEMINI_API_KEY não está no ambiente deste terminal; nada foi chamado.');
  process.exit(2);
}

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-omni-live-'));
const image = arg('image');
if (image) fs.copyFileSync(path.resolve(image), path.join(baseDir, path.basename(image)));

/** Resumo da interação sem o vídeo em base64. */
function describeInteraction(body: Record<string, unknown>): unknown {
  const steps = Array.isArray(body.steps) ? (body.steps as Array<Record<string, unknown>>) : [];
  return {
    keys: Object.keys(body),
    id: body.id,
    status: body.status,
    usage: body.usage,
    steps: steps.map((step) => ({
      type: step.type,
      content: Array.isArray(step.content)
        ? (step.content as Array<Record<string, unknown>>).map((item) => ({
            type: item.type,
            mime_type: item.mime_type,
            data: typeof item.data === 'string' ? `<${item.data.length} chars base64>` : undefined,
            uri: item.uri,
            text: typeof item.text === 'string' ? item.text.slice(0, 200) : undefined,
          }))
        : undefined,
    })),
    output_video: body.output_video ? Object.keys(body.output_video as object) : undefined,
  };
}

const started = Date.now();
const loggingFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const t0 = Date.now();
  const res = await fetch(input, init);
  const where = url.replace(/\?.*$/u, '');
  console.log(`${init?.method ?? 'GET'} ${where} → HTTP ${res.status} em ${Date.now() - t0} ms`);
  if (url.endsWith('/interactions') && !res.ok) {
    // O corpo de erro do Google não ecoa a chave: traz a cota recusada
    // (`quotaId`, `quotaMetric`) e, às vezes, o projeto que consumiu a chamada.
    console.log((await res.clone().text().catch(() => '<corpo ilegível>')).slice(0, 4000));
  } else if (url.endsWith('/interactions')) {
    const body = (await res.clone().json().catch(() => null)) as Record<string, unknown> | null;
    console.log(JSON.stringify(body ? describeInteraction(body) : '<corpo ilegível>', null, 2));
  } else if (/\/files\/[^/:]+$/u.test(where)) {
    const file = (await res.clone().json().catch(() => null)) as Record<string, unknown> | null;
    console.log(`  arquivo: state=${String(file?.state)} mimeType=${String(file?.mimeType)} sizeBytes=${String(file?.sizeBytes)}`);
  }
  return res;
};

const deps: MediaDeps = {
  fetchFn: loggingFetch,
  resolveHostname: resolveBrowserHostname,
  fetchPinned: fetchPinnedProviderAsset,
  getKey: (def) => (def.envVar === 'GEMINI_API_KEY' ? key : undefined),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

try {
  const result = await generateVideo(
    {
      prompt:
        arg('prompt') ??
        'A lighthouse on a rocky coast during a storm at dusk, waves crashing, slow cinematic push-in.',
      provider: 'google-video',
      model: 'gemini-omni-1.1-flash',
      resolution: arg('resolution') ?? '360p',
      aspectRatio: arg('aspect') ?? '16:9',
      ...(image ? { imagePath: path.basename(image) } : {}),
      outPath: 'omni-live.mp4',
      baseDir,
    },
    deps,
  );
  console.log('\n=== RESULTADO ===');
  console.log(
    JSON.stringify(
      { ...result, bytes: fs.statSync(result.path).size, totalMs: Date.now() - started },
      null,
      2,
    ),
  );
  console.log(`\nConfira a duração com: ffprobe -v error -show_entries format=duration -of csv=p=0 "${result.path}"`);
} catch (err) {
  console.error('\n=== FALHOU ===');
  console.error(err instanceof Error ? err.message : String(err));
  console.error(`(pasta: ${baseDir}, ${Date.now() - started} ms)`);
  process.exit(1);
}
