import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMediaStreamHandler,
  grantMediaStreamUrl,
  MEDIA_STREAM_SCHEME_DEF,
  parseRange,
  resetMediaStreamGrantsForTests,
} from './media-stream-protocol';

let dir: string;
let video: string;

beforeEach(() => {
  resetMediaStreamGrantsForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-media-stream-'));
  video = path.join(dir, 'v.mp4');
  fs.writeFileSync(video, Buffer.from('0123456789'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseRange', () => {
  it('aceita início-fim, aberto e sufixo; recusa o que não cabe', () => {
    expect(parseRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange('bytes=7-', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=4-99', 10)).toEqual({ start: 4, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBeNull();
    expect(parseRange('bytes=5-2', 10)).toBeNull();
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(parseRange('itens=0-1', 10)).toBeNull();
  });
});

describe('nexus-media://', () => {
  it('o esquema é seguro, padrão e com stream (o <video> faz seek)', () => {
    expect(MEDIA_STREAM_SCHEME_DEF).toEqual({
      scheme: 'nexus-media',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    });
  });

  it('serve o arquivo inteiro e por faixa (206) com Content-Range', async () => {
    const url = grantMediaStreamUrl(video);
    expect(url).toMatch(/^nexus-media:\/\/media\/[a-f0-9]{32}$/u);
    const handler = createMediaStreamHandler();
    const whole = await handler(new Request(url));
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(await whole.text()).toBe('0123456789');
    const part = await handler(new Request(url, { headers: { range: 'bytes=3-6' } }));
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 3-6/10');
    expect(part.headers.get('content-length')).toBe('4');
    expect(await part.text()).toBe('3456');
    const head = await handler(new Request(url, { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
  });

  it('faixa impossível é 416; token desconhecido, vencido ou forjado é 404; outro host é 403', async () => {
    let now = 1_000;
    const url = grantMediaStreamUrl(video, now);
    const handler = createMediaStreamHandler(() => now);
    expect((await handler(new Request(url, { headers: { range: 'bytes=50-' } }))).status).toBe(416);
    expect((await handler(new Request('nexus-media://media/' + 'f'.repeat(32)))).status).toBe(404);
    expect((await handler(new Request('nexus-media://media/../../etc/passwd'))).status).toBe(404);
    expect((await handler(new Request(url.replace('://media/', '://outro/')))).status).toBe(403);
    expect((await handler(new Request(url, { method: 'POST' }))).status).toBe(405);
    now += 31 * 60_000;
    expect((await handler(new Request(url))).status).toBe(404);
  });

  it('arquivo apagado depois do token vira 404; tipo sem prévia nem recebe token', async () => {
    const url = grantMediaStreamUrl(video);
    fs.rmSync(video);
    expect((await createMediaStreamHandler()(new Request(url))).status).toBe(404);
    expect(() => grantMediaStreamUrl(path.join(dir, 'segredo.env'))).toThrow(/sem prévia/u);
  });
});
