import { describe, expect, it } from 'vitest';
import rendererConfig from './vite.renderer.config';

describe('renderer asset packaging', () => {
  it('emits AudioWorklet modules as files allowed by the production CSP', () => {
    expect(rendererConfig.build?.assetsInlineLimit).toBe(0);
  });

  it('bundles the diff highlight worker as an ES module so its lazy imports can split', () => {
    expect(rendererConfig.worker?.format).toBe('es');
  });
});
