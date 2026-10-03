import { describe, expect, it } from 'vitest';
import { detectDevServerUrls } from './dev-server-detect';

describe('detectDevServerUrls', () => {
  it('detects the Vite banner (with ANSI colors)', () => {
    const chunk = [
      '\x1b[32m  VITE v5.4.0\x1b[39m  ready in 300 ms',
      '',
      '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m',
      '  \x1b[32m➜\x1b[39m  \x1b[1mNetwork\x1b[22m: use --host to expose',
    ].join('\r\n');
    expect(detectDevServerUrls(chunk)).toEqual(['http://localhost:5173/']);
  });

  it('detects Next.js and normalizes 0.0.0.0 to localhost', () => {
    expect(
      detectDevServerUrls('ready - started server on 0.0.0.0:3000, url: http://0.0.0.0:3000'),
    ).toEqual(['http://localhost:3000']);
    expect(
      detectDevServerUrls('▲ Next.js 14.2.3\n- Local:        http://localhost:3000\n'),
    ).toEqual(['http://localhost:3000']);
  });

  it('detects CRA/webpack style output', () => {
    const chunk = [
      'You can now view my-app in the browser.',
      '  Local:            http://localhost:3000',
      '  On Your Network:  http://192.168.0.42:3000',
    ].join('\n');
    expect(detectDevServerUrls(chunk)).toEqual([
      'http://localhost:3000',
      'http://192.168.0.42:3000',
    ]);
  });

  it('ignores public URLs (docs links are not dev servers)', () => {
    expect(
      detectDevServerUrls('see https://vitejs.dev/config and http://example.com:3000'),
    ).toEqual([]);
  });

  it('deduplicates and strips trailing punctuation', () => {
    const chunk =
      'server at http://localhost:8080. retry http://localhost:8080, done http://localhost:8080';
    expect(detectDevServerUrls(chunk)).toEqual(['http://localhost:8080']);
  });

  it('returns [] for output without URLs', () => {
    expect(detectDevServerUrls('npm run dev\ncompiling...')).toEqual([]);
    expect(detectDevServerUrls('')).toEqual([]);
  });

  it('accepts 127.0.0.1 and private ranges with ports', () => {
    expect(detectDevServerUrls('Listening on http://127.0.0.1:4321/')).toEqual([
      'http://127.0.0.1:4321/',
    ]);
    expect(detectDevServerUrls('http://10.0.0.5:8000 ready')).toEqual([
      'http://10.0.0.5:8000',
    ]);
  });
});

it('bounds long URL punctuation runs whose last character is meaningful', () => {
  const url = 'http://localhost:5173/' + '.'.repeat(32_000) + 'x';
  const before = performance.now(); expect(detectDevServerUrls('Local: ' + url + '\n')).toEqual([url]);
  expect(performance.now() - before).toBeLessThan(50);
  expect(detectDevServerUrls('http://localhost:5173/hello...')).toEqual(['http://localhost:5173/hello']);
});
