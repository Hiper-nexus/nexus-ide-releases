import { describe, expect, it, vi } from 'vitest';
import {
  extractPetSlug,
  importGalleryPet,
  parseInstallScript,
} from './pet-gallery';

const SCRIPT = [
  '#!/bin/sh',
  '# Petdex installer',
  '# https://petdex.dev/pets/navi',
  '',
  'set -e',
  '',
  'PET_DIR="$HOME/.codex/pets/navi"',
  "DISPLAY_NAME='Navi o'\\''Barber'",
  'PETDEX_REFERER="https://petdex.dev/"',
  '',
  'mkdir -p "$PET_DIR"',
  '',
  `curl -fsSL -e "$PETDEX_REFERER" -o "$PET_DIR/pet.json" 'https://assets.example.r2.dev/navi/pet.json'`,
  `curl -fsSL -e "$PETDEX_REFERER" -o "$PET_DIR/spritesheet.webp" 'https://assets.example.r2.dev/navi/sheet.webp'`,
].join('\n');

describe('extractPetSlug', () => {
  it('aceita slug puro, URL de página e URL de install (com locale)', () => {
    expect(extractPetSlug('navi')).toBe('navi');
    expect(extractPetSlug('  Fireball-2 ')).toBe('fireball-2');
    expect(extractPetSlug('https://codex-pets.net/pets/navi')).toBe('navi');
    expect(extractPetSlug('https://petdex.dev/install/navi')).toBe('navi');
    expect(extractPetSlug('https://petdex.dev/pt-br/pets/navi/')).toBe('navi');
  });

  it('rejeita domínios fora da galeria, http e lixo', () => {
    expect(extractPetSlug('https://evil.example/pets/navi')).toBeNull();
    expect(extractPetSlug('http://petdex.dev/pets/navi')).toBeNull();
    expect(extractPetSlug('não é um slug')).toBeNull();
    expect(extractPetSlug('')).toBeNull();
  });
});

describe('parseInstallScript', () => {
  it('extrai nome (com aspas escapadas) e URL do sheet', () => {
    expect(parseInstallScript(SCRIPT)).toEqual({
      name: "Navi o'Barber",
      mime: 'image/webp',
      spritesheetUrl: 'https://assets.example.r2.dev/navi/sheet.webp',
    });
  });

  it('rejeita script sem linha de spritesheet ou com URL não-https', () => {
    expect(parseInstallScript('#!/bin/sh\necho oi')).toBeNull();
    expect(
      parseInstallScript(
        SCRIPT.replace('https://assets.example.r2.dev/navi/sheet.webp', 'http://x/s.webp'),
      ),
    ).toBeNull();
  });
});

describe('importGalleryPet', () => {
  const sheetBytes = Buffer.from('fake-webp-bytes');

  function fetchMock(): typeof fetch {
    return vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.includes('/install/navi')) {
        return new Response(SCRIPT, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
      if (href === 'https://assets.example.r2.dev/navi/sheet.webp') {
        return new Response(sheetBytes, {
          status: 200,
          headers: { 'content-type': 'image/webp' },
        });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
  }

  it('importa fim-a-fim e devolve data URL base64', async () => {
    const result = await importGalleryPet('navi', fetchMock());
    expect(result.ok).toBe(true);
    expect(result.name).toBe("Navi o'Barber");
    expect(result.dataUrl).toBe(
      `data:image/webp;base64,${sheetBytes.toString('base64')}`,
    );
  });

  it('manda o Referer da galeria no download do asset', async () => {
    const mock = fetchMock();
    await importGalleryPet('navi', mock);
    const calls = (mock as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const assetCall = calls.find(([u]) => String(u).includes('sheet.webp'));
    expect(assetCall?.[1]?.headers).toMatchObject({
      referer: 'https://petdex.dev/',
    });
  });

  it('slug inexistente devolve erro amigável', async () => {
    const result = await importGalleryPet('nao-existe', fetchMock());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('não encontrado');
  });

  it('sheet acima do teto é rejeitado', async () => {
    const big = Buffer.alloc(2_600_001);
    const mock = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.includes('/install/')) {
        return new Response(SCRIPT, { status: 200 });
      }
      return new Response(big, {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      });
    }) as unknown as typeof fetch;
    const result = await importGalleryPet('navi', mock);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('grande demais');
  });

  it('MIME fora da lista é rejeitado', async () => {
    const mock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/install/')) {
        return new Response(SCRIPT, { status: 200 });
      }
      return new Response(Buffer.from('gif'), {
        status: 200,
        headers: { 'content-type': 'image/gif' },
      });
    }) as unknown as typeof fetch;
    const result = await importGalleryPet('navi', mock);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('não é uma imagem suportada');
  });
});

describe('extractPetSlug — hash routing (codex-pets.net)', () => {
  it('resolve /#/pets/<slug> e /#/install/<slug>', () => {
    expect(extractPetSlug('https://codex-pets.net/#/pets/axiom')).toBe('axiom');
    expect(extractPetSlug('https://petdex.dev/#/install/navi')).toBe('navi');
  });
});

describe('fetchGalleryCatalog', () => {
  it('parseia o sitemap, deduplica, rotula e ordena', async () => {
    const { fetchGalleryCatalog, __resetGalleryCatalogCacheForTests } =
      await import('./pet-gallery');
    __resetGalleryCatalogCacheForTests();
    const xml = [
      '<urlset>',
      '<url><loc>https://petdex.dev/pets/zeta-cat</loc></url>',
      '<url><loc>https://petdex.dev/es/pets/zeta-cat</loc></url>',
      '<url><loc>https://petdex.dev/pets/aurelion-sol-2</loc></url>',
      '<url><loc>https://petdex.dev/pets/eve-743f1e0e6b0d</loc></url>',
      '<url><loc>https://petdex.dev/about</loc></url>',
      '</urlset>',
    ].join('');
    const mock = (async () =>
      new Response(xml, { status: 200 })) as unknown as typeof fetch;
    const result = await fetchGalleryCatalog(mock, 1);
    expect(result.ok).toBe(true);
    expect(result.items).toEqual([
      { slug: 'aurelion-sol-2', label: 'Aurelion Sol 2' },
      { slug: 'eve-743f1e0e6b0d', label: 'Eve' },
      { slug: 'zeta-cat', label: 'Zeta Cat' },
    ]);
  });

  it('usa o cache dentro do TTL', async () => {
    const { fetchGalleryCatalog, __resetGalleryCatalogCacheForTests } =
      await import('./pet-gallery');
    __resetGalleryCatalogCacheForTests();
    let calls = 0;
    const mock = (async () => {
      calls += 1;
      return new Response(
        '<url><loc>https://petdex.dev/pets/solo</loc></url>',
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await fetchGalleryCatalog(mock, 1);
    await fetchGalleryCatalog(mock, 2);
    expect(calls).toBe(1);
  });
});

describe('instância self-host (codex-pet-share)', () => {
  it('extractPetShareRef aceita host próprio e rejeita bases petdex/http', async () => {
    const { extractPetShareRef } = await import('./pet-gallery');
    expect(
      extractPetShareRef('https://pets.volarehost.com.br/pets/navi-oficial'),
    ).toEqual({ origin: 'https://pets.volarehost.com.br', id: 'navi-oficial' });
    expect(extractPetShareRef('https://petdex.dev/pets/navi')).toBeNull();
    expect(extractPetShareRef('http://pets.example/pets/x')).toBeNull();
    expect(extractPetShareRef('navi')).toBeNull();
  });

  it('importa manifest + asset direto da instância', async () => {
    const { importGalleryPet } = await import('./pet-gallery');
    const bytes = Buffer.from('sheet-oficial');
    const mock = (async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href === 'https://pets.acme.dev/api/pets/aurora') {
        return new Response(JSON.stringify({ displayName: 'Aurora' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (href === 'https://pets.acme.dev/api/pets/aurora/spritesheet') {
        return new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'image/webp' },
        });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const result = await importGalleryPet(
      'https://pets.acme.dev/pets/aurora',
      mock,
    );
    expect(result.ok).toBe(true);
    expect(result.name).toBe('Aurora');
    expect(result.dataUrl).toBe(
      `data:image/webp;base64,${bytes.toString('base64')}`,
    );
  });

  it('manifest fora do ar não impede o asset (nome cai no id)', async () => {
    const { importGalleryPet } = await import('./pet-gallery');
    const mock = (async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.endsWith('/spritesheet')) {
        return new Response(Buffer.from('x'), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response('down', { status: 500 });
    }) as unknown as typeof fetch;
    const result = await importGalleryPet('https://p.acme.dev/pets/solo', mock);
    expect(result.ok).toBe(true);
    expect(result.name).toBe('solo');
  });
});
