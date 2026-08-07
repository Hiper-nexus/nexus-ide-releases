/** @vitest-environment jsdom */
import { describe, expect, it, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';
import { OverlayLayer, getOverlayRoot, resetOverlayRootForTest } from './overlay-layer';

const REPO = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');

function render(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div');
  host.id = 'root';
  document.body.appendChild(host);
  act(() => createRoot(host).render(node));
  return host;
}

beforeEach(() => {
  document.body.replaceChildren();
  resetOverlayRootForTest();
});

describe('OverlayLayer — a camada existe FORA da árvore do grid', () => {
  it('portala para um irmão de #root, direto no body', () => {
    const host = render(
      <OverlayLayer>
        <div data-testid="modal" />
      </OverlayLayer>,
    );

    const modal = document.querySelector('[data-testid="modal"]');
    expect(modal).not.toBeNull();
    // O ponto inteiro do H6: o overlay NÃO pode estar dentro da árvore da app.
    expect(host.contains(modal!)).toBe(false);
    expect(modal!.closest('.overlay-layer')?.parentElement).toBe(document.body);
  });

  it('reusa a mesma raiz entre instâncias (uma camada, não N)', () => {
    render(
      <>
        <OverlayLayer>
          <div data-testid="a" />
        </OverlayLayer>
        <OverlayLayer>
          <div data-testid="b" />
        </OverlayLayer>
      </>,
    );
    expect(document.querySelectorAll('.overlay-layer')).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid="a"], [data-testid="b"]')).toHaveLength(2);
  });

  it('sobrevive a um nó já presente no DOM (hot-reload)', () => {
    const first = getOverlayRoot();
    resetOverlayRootForTest();
    expect(getOverlayRoot()).toBe(first);
  });

  it('não cria área de acerto: a camada tem tamanho zero', () => {
    const css = read('src/renderer/styles/overlay-layer.css');
    const layer = css.slice(css.indexOf('.overlay-layer {'), css.indexOf('/* ============================ SCRIM'));
    expect(layer).toMatch(/width:\s*0;/);
    expect(layer).toMatch(/height:\s*0;/);
    // isolation: isolate é o que devolve autoridade à ladder interna.
    expect(layer).toMatch(/isolation:\s*isolate;/);
    expect(layer).toMatch(/z-index:\s*var\(--z-overlay-root\);/);
  });
});

describe('contrato de tokens H6 (DESIGN.md é a autoridade, base.css a fonte)', () => {
  const base = read('src/renderer/styles/base.css');
  const design = read('DESIGN.md');

  const TOKENS: Record<string, string> = {
    '--z-overlay-root': '100000',
    '--ease-spring-in': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    '--ease-overlay-smooth': 'cubic-bezier(0.22, 0.8, 0.2, 1)',
    '--dur-overlay-modal': '180ms',
    '--dur-overlay-pulse': '2.2s',
    '--overlay-blur': '16px',
    '--overlay-saturate': '160%',
    '--overlay-scrim': 'rgba(4, 6, 10, 0.55)',
  };

  for (const [token, value] of Object.entries(TOKENS)) {
    it(`${token} é declarado em :root com ${value}`, () => {
      expect(base).toContain(`${token}: ${value};`);
    });
    it(`${token} é DECLARADO em DESIGN.md (o sensor compara os dois)`, () => {
      expect(design).toContain(`| \`${token}\` | \`${value}\` |`);
    });
  }

  it('o valor alto aparece uma vez só, no token — nunca solto num componente', () => {
    const styleDir = path.join(REPO, 'src/renderer/styles');
    const offenders = fs
      .readdirSync(styleDir)
      .filter((f) => f.endsWith('.css'))
      .flatMap((f) => {
        const body = read(`src/renderer/styles/${f}`);
        return /z-index:\s*100000/.test(body) && f !== 'base.css' ? [f] : [];
      });
    expect(offenders).toEqual([]);
  });
});

describe('motion: spring só na entrada, reduced-motion em todo keyframe novo', () => {
  const overlayCss = read('src/renderer/styles/overlay-layer.css');
  const overlaysCss = read('src/renderer/styles/overlays.css');

  it('o spring com overshoot nunca é usado em saída/hover/transition', () => {
    for (const css of [overlayCss, overlaysCss, read('src/renderer/styles/panels.css')]) {
      for (const line of css.split('\n')) {
        if (!line.includes('--ease-spring-in')) continue;
        expect(line).not.toMatch(/transition/);
        expect(line).toMatch(/-in |-in,|-in\b/);
      }
    }
  });

  it('todo keyframe novo tem kill switch de reduced-motion', () => {
    const newKeyframes = ['overlay-panel-in', 'overlay-fade-in', 'overlay-pulse'];
    for (const name of newKeyframes) {
      expect(overlayCss).toContain(`@keyframes ${name}`);
    }
    const reduced = overlayCss.slice(overlayCss.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.overlay-enter');
    expect(reduced).toContain('.overlay-scrim-enter');
    expect(reduced).toContain('.overlay-live');
    expect(reduced).toContain('animation: none');

    // Keyframes de centralização vivem em overlays.css/panels.css e precisam
    // do mesmo tratamento.
    for (const [file, klass] of [
      ['src/renderer/styles/overlays.css', '.palette__panel'],
      ['src/renderer/styles/overlays.css', '.cheatsheet__panel'],
      ['src/renderer/styles/panels.css', '.confirm__panel'],
    ] as const) {
      const body = read(file);
      const blocks = body.split('@media (prefers-reduced-motion: reduce)').slice(1);
      expect(blocks.some((b) => b.slice(0, 200).includes(klass))).toBe(true);
    }
  });

  it('o vidro fica no scrim, nunca no painel nem em .pane', () => {
    const all = fs
      .readdirSync(path.join(REPO, 'src/renderer/styles'))
      .filter((f) => f.endsWith('.css'))
      .map((f) => [f, read(`src/renderer/styles/${f}`)] as const);

    for (const [file, body] of all) {
      for (const line of body.split('\n')) {
        if (!/backdrop-filter:\s*blur\(var\(--overlay-blur\)\)/.test(line)) continue;
        // A regra dona da linha tem de ser um scrim/backdrop, nunca um painel.
        const rule = body.slice(0, body.indexOf(line)).split('{').slice(-1)[0];
        expect(`${file}: ${rule.trim()}`).toMatch(/overlay|scrim|backdrop/i);
      }
    }
  });
});
