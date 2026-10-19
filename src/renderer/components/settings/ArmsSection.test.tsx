/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArmsSection, armsMcpSnippet } from './ArmsSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const WINDOWS_BIN =
  'C:\\Users\\ana\\AppData\\Local\\nexus_ide\\app-0.76.316\\resources\\nexus-arms.mjs';
const WINDOWS_DESCRIPTOR = 'C:\\Users\\ana\\.nexus\\arms-runtime.json';

let mounted: { host: HTMLDivElement; root: Root } | null = null;

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.host.remove();
    mounted = null;
  }
  Reflect.deleteProperty(window, 'nexus');
});

async function renderWithToken(platform: NodeJS.Platform): Promise<HTMLDivElement> {
  const status = {
    configured: false,
    revoked: false,
    createdAt: null,
    rotatedAt: null,
    lastUsedAt: null,
    instance: 'prod' as const,
    descriptorPath: WINDOWS_DESCRIPTOR,
    binPath: WINDOWS_BIN,
  };
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      platform,
      arms: {
        status: vi.fn(async () => status),
        generate: vi.fn(async () => ({ token: 'tok-uma-vez', createdAt: 1 })),
        rotate: vi.fn(),
        revoke: vi.fn(),
      },
    },
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { host, root };
  await act(async () => {
    root.render(<ArmsSection />);
  });
  const generate = [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent === 'Gerar token');
  await act(async () => {
    generate!.click();
  });
  return host;
}

describe('ArmsSection: caminho do conector por sistema (F-1579)', () => {
  it('no Windows mostra o caminho real da instalação, em JSON válido, e avisa que ele muda na atualização', async () => {
    const host = await renderWithToken('win32');
    const snippet = host.querySelector('.arms__snippet')?.textContent ?? '';
    expect(snippet).not.toContain('/Applications');
    const parsed = JSON.parse(snippet) as {
      mcpServers: { 'nexus-arms': { args: string[] } };
    };
    expect(parsed.mcpServers['nexus-arms'].args).toEqual([
      WINDOWS_BIN,
      '--descriptor',
      WINDOWS_DESCRIPTOR,
    ]);
    expect(host.textContent).toContain('muda a cada atualização');
  });

  it('no Mac não mostra o aviso de pasta que muda', async () => {
    const host = await renderWithToken('darwin');
    expect(host.querySelector('.arms__snippet')).not.toBeNull();
    expect(host.textContent).not.toContain('muda a cada atualização');
  });

  it('o trecho escapa a barra invertida dos caminhos', () => {
    expect(armsMcpSnippet('C:\\a\\b.mjs', 'C:\\d.json')).toContain('"C:\\\\a\\\\b.mjs"');
  });
});
