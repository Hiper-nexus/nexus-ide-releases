import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MEDIA_REFERENCE_DIR,
  MEDIA_REFERENCE_MAX_BYTES,
} from '../../shared/media-reference-types';
import {
  detectReferenceFormat,
  listReferences,
  readReferenceDataUrl,
  referenceBaseName,
  removeReference,
  saveReference,
} from './media-references';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypqt  '), Buffer.alloc(8)]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');

let root = '';

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-media-refs-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('detectReferenceFormat', () => {
  it.each([
    ['png', PNG, 'image', false],
    ['jpg', JPG, 'image', false],
    ['webp', WEBP, 'image', false],
    ['gif', GIF, 'image', false],
    ['svg', SVG, 'image', true],
    ['mp4', MP4, 'video', false],
    ['mov', MOV, 'video', false],
    ['webm', WEBM, 'video', false],
  ] as const)('reconhece %s pelos bytes', (ext, data, kind, vector) => {
    expect(detectReferenceFormat(data)).toMatchObject({ ext, kind, vector });
  });

  it('recusa o que não é imagem nem vídeo, mesmo com nome de imagem', () => {
    expect(detectReferenceFormat(Buffer.from('MZ\x90\x00 executável', 'latin1'))).toBeNull();
    expect(detectReferenceFormat(Buffer.from('<html><body>oi</body></html>'))).toBeNull();
    expect(detectReferenceFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe('referenceBaseName', () => {
  it('tira acento, espaço, pasta e extensão', () => {
    expect(referenceBaseName('Logo Café (final).PNG')).toBe('logo-cafe-final');
    expect(referenceBaseName('C:\\fotos\\Ação.jpg')).toBe('acao');
    expect(referenceBaseName('../../segredo.png')).toBe('segredo');
    expect(referenceBaseName('!!!.png')).toBe('referencia');
  });
});

describe('saveReference', () => {
  it('copia para media/referencias com a extensão do formato real', () => {
    const res = saveReference(root, 'Minha Logo.jpeg', PNG, () => 1_700_000_000_000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reference).toMatchObject({
      kind: 'image',
      vector: false,
      bytes: PNG.length,
      name: 'minha-logo.png',
    });
    expect(res.reference.storageKey.startsWith(`${MEDIA_REFERENCE_DIR}/`)).toBe(true);
    expect(res.reference.storageKey.endsWith('-minha-logo.png')).toBe(true);
    expect(fs.readFileSync(path.join(root, res.reference.storageKey))).toEqual(PNG);
  });

  it('não sobrescreve um arquivo com o mesmo nome no mesmo instante', () => {
    const now = () => 1_700_000_000_000;
    const a = saveReference(root, 'logo.png', PNG, now);
    const b = saveReference(root, 'logo.png', PNG, now);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.reference.storageKey).not.toBe(b.reference.storageKey);
    expect(b.reference.storageKey.endsWith('-logo-2.png')).toBe(true);
  });

  it('recusa formato desconhecido, arquivo vazio e tamanho acima do teto', () => {
    expect(saveReference(root, 'x.png', Buffer.from('nada'))).toMatchObject({ ok: false });
    expect(saveReference(root, 'x.png', Buffer.alloc(0))).toEqual({
      ok: false,
      error: 'O arquivo está vazio.',
    });
    const huge = Buffer.concat([MP4, Buffer.alloc(MEDIA_REFERENCE_MAX_BYTES.video)]);
    const res = saveReference(root, 'filme.mp4', huge);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Corte um trecho curto/u);
    expect(fs.existsSync(path.join(root, MEDIA_REFERENCE_DIR))).toBe(false);
  });

  it('não grava fora do projeto quando a pasta de referências é um symlink', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-refs-out-')));
    try {
      fs.mkdirSync(path.join(root, 'media'));
      fs.symlinkSync(outside, path.join(root, MEDIA_REFERENCE_DIR));
      expect(() => saveReference(root, 'logo.png', PNG)).toThrow(/escapa o workspace/u);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('listReferences', () => {
  it('lista só arquivos aceitos, o mais novo primeiro, sem o prefixo no nome', () => {
    expect(listReferences(root)).toEqual([]);
    const a = saveReference(root, 'a.png', PNG, () => 1_700_000_000_000);
    const b = saveReference(root, 'b.mp4', MP4, () => 1_700_000_000_001);
    expect(a.ok && b.ok).toBe(true);
    const dir = path.join(root, MEDIA_REFERENCE_DIR);
    fs.writeFileSync(path.join(dir, 'notas.txt'), 'x');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
    const older = new Date(Date.now() - 60_000);
    if (a.ok) fs.utimesSync(path.join(root, a.reference.storageKey), older, older);
    const list = listReferences(root);
    expect(list.map((r) => [r.name, r.kind])).toEqual([
      ['b.mp4', 'video'],
      ['a.png', 'image'],
    ]);
  });

  it('ignora a pasta quando ela é um symlink para fora do projeto', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-refs-out-')));
    try {
      fs.writeFileSync(path.join(outside, 'segredo.png'), PNG);
      fs.mkdirSync(path.join(root, 'media'));
      fs.symlinkSync(outside, path.join(root, MEDIA_REFERENCE_DIR));
      expect(listReferences(root)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('removeReference', () => {
  it('manda para a Lixeira só o que está na pasta de referências', async () => {
    const saved = saveReference(root, 'logo.png', PNG);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const trash = vi.fn(async (abs: string) => fs.rmSync(abs));
    await expect(removeReference(root, saved.reference.storageKey, trash)).resolves.toEqual({
      ok: true,
    });
    expect(trash).toHaveBeenCalledWith(path.join(root, saved.reference.storageKey));

    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    for (const key of ['package.json', `${MEDIA_REFERENCE_DIR}/../../package.json`, `${MEDIA_REFERENCE_DIR}/`]) {
      await expect(removeReference(root, key, trash)).resolves.toMatchObject({ ok: false });
    }
    expect(trash).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
  });
});

describe('readReferenceDataUrl', () => {
  it('devolve a prévia com o tipo certo e recusa caminho fora da pasta', () => {
    const saved = saveReference(root, 'logo.svg', SVG);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const res = readReferenceDataUrl(root, saved.reference.storageKey);
    expect(res.ok).toBe(true);
    expect(res.dataUrl?.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(readReferenceDataUrl(root, 'package.json')).toMatchObject({ ok: false });
  });
});
