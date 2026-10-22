import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uiKitProjectFit } from './ui-kit-project';

let cwd = '';
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-project-'));
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function pkg(value: Record<string, unknown>): void {
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(value));
}

describe('uiKitProjectFit — both kits are React for the web on Tailwind v4', () => {
  it('accepts a React project on Tailwind v4', () => {
    pkg({ dependencies: { react: '^19.0.0', next: '16.0.0' }, devDependencies: { tailwindcss: '^4.1.0' } });
    expect(uiKitProjectFit(cwd)).toEqual({ ok: true });
  });

  it.each([
    [{ vue: '^3.5.0' }, 'Vue'],
    [{ nuxt: '^4.0.0' }, 'Nuxt'],
    [{ svelte: '^5.0.0' }, 'Svelte'],
    [{ '@angular/core': '^20.0.0' }, 'Angular'],
    [{ 'solid-js': '^1.9.0' }, 'Solid'],
  ])('refuses %o and names it', (dependencies, name) => {
    pkg({ dependencies });
    const fit = uiKitProjectFit(cwd);
    expect(fit).toMatchObject({ ok: false, reason: 'framework_unsupported' });
    expect(fit.ok ? '' : fit.detail).toContain(name);
  });

  it('refuses React Native / Expo: these kits write web DOM components', () => {
    pkg({ dependencies: { react: '19.0.0', 'react-native': '0.81.0', expo: '^54.0.0' } });
    expect(uiKitProjectFit(cwd)).toMatchObject({ ok: false, reason: 'framework_unsupported' });
  });

  it('warns BoardUI about Tailwind v3 and leaves shadcn alone (its CLI adapts)', () => {
    pkg({ dependencies: { react: '^18.3.0' }, devDependencies: { tailwindcss: '^3.4.17' } });
    const boardui = uiKitProjectFit(cwd, 'boardui');
    expect(boardui.ok).toBe(true);
    expect(boardui.ok && boardui.warning).toMatch(/@tailwindcss\/upgrade/);
    expect(uiKitProjectFit(cwd, 'shadcn')).toEqual({ ok: true });
  });

  it('lets a monorepo root through: React lives in the packages', () => {
    pkg({ workspaces: ['apps/*'], devDependencies: { turbo: '^2.0.0' } });
    expect(uiKitProjectFit(cwd)).toEqual({ ok: true });
  });

  it('cannot tell without a package.json, so it does not refuse', () => {
    expect(uiKitProjectFit(cwd)).toEqual({ ok: true });
  });

  it('does not guess from a version it cannot read', () => {
    pkg({ dependencies: { react: 'catalog:' }, devDependencies: { tailwindcss: 'workspace:*' } });
    expect(uiKitProjectFit(cwd)).toEqual({ ok: true });
  });
});
