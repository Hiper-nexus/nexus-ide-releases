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
