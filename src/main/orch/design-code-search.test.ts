import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserDesignElementContext } from '../../shared/browser-design';
import {
  queryFromSelection,
  searchWorkspaceForSelection,
} from './design-code-search';

let root = '';

function write(relPath: string, content: string): void {
  const filePath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-search-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('searchWorkspaceForSelection', () => {
  it('ranks a component definition first and reports file:line', async () => {
    write(
      'src/components/SaveButton.tsx',
      [
        "import React from 'react';",
        '',
        'export function SaveButton({ label }: { label: string }) {',
        '  return <button className="btn btn-primary">{label}</button>;',
        '}',
      ].join('\n'),
    );
    write(
      'src/App.tsx',
      [
        "import { SaveButton } from './components/SaveButton';",
        'export function App() {',
        '  return <SaveButton label="Salvar" />;',
        '}',
      ].join('\n'),
    );
    write('src/util.ts', 'export const noop = () => {};');

    const candidates = await searchWorkspaceForSelection(root, {
      componentNames: ['SaveButton'],
      classes: ['btn-primary'],
    });
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0].file).toBe(path.join('src', 'components', 'SaveButton.tsx'));
    expect(candidates[0].line).toBe(3);
    expect(candidates[0].score).toBeGreaterThan(candidates[1].score);
    expect(candidates[0].matched.some((m) => m.startsWith('component:'))).toBe(true);
  });

  it('matches ids and visible text', async () => {
    write(
      'src/pages/Home.jsx',
      [
        'export function Home() {',
        '  return (',
        '    <section id="hero-cta">',
        '      <h1>Bem-vindo ao painel</h1>',
        '    </section>',
        '  );',
        '}',
      ].join('\n'),
    );
    write('src/pages/Other.jsx', 'export function Other() { return null; }');

    const candidates = await searchWorkspaceForSelection(root, {
      id: 'hero-cta',
      text: 'Bem-vindo ao painel',
    });
    expect(candidates[0].file).toBe(path.join('src', 'pages', 'Home.jsx'));
    expect(candidates[0].matched).toEqual(
      expect.arrayContaining([expect.stringContaining('id:'), expect.stringContaining('text:')]),
    );
    // Line points at the strongest anchor (the id attribute).
    expect(candidates[0].line).toBe(3);
  });

  it('never searches dependency/build directories and caps at 5 results', async () => {
    write('node_modules/lib/Button.tsx', 'export function SaveButton() {}');
    write('dist/bundle.js', 'function SaveButton() {}');
    write('.git/objects/fake.ts', 'function SaveButton() {}');
    for (let i = 0; i < 8; i += 1) {
      write(`src/c${i}.tsx`, `export function C${i}() { return <div className="card" />; }`);
    }

    const candidates = await searchWorkspaceForSelection(root, {
      componentNames: ['SaveButton'],
      classes: ['card'],
    });
    expect(candidates.length).toBeLessThanOrEqual(5);
    for (const candidate of candidates) {
      expect(candidate.file).not.toContain('node_modules');
      expect(candidate.file).not.toContain('dist');
      expect(candidate.file).not.toContain('.git');
    }
  });

  it('never crosses tool metadata or nested Git worktree boundaries', async () => {
    write('src/RealButton.tsx', 'export function RealButton() { return <button />; }');
    write(
      '.claude/worktrees/other/src/ForeignButton.tsx',
      'export function ForeignButton() { return <button className="foreign" />; }',
    );
    write('.claude/worktrees/other/.git', 'gitdir: /tmp/foreign');
    write(
      'packages/nested/src/NestedButton.tsx',
      'export function NestedButton() { return <button className="foreign" />; }',
    );
    write('packages/nested/.git', 'gitdir: /tmp/nested');
    write('.nexus/cache/Injected.tsx', 'export function Injected() {}');

    const candidates = await searchWorkspaceForSelection(root, {
      componentNames: ['ForeignButton', 'NestedButton', 'Injected'],
      classes: ['foreign'],
    });

    expect(candidates).toEqual([]);
  });

  it('returns [] for an empty query or a workspace without matches', async () => {
    write('src/a.ts', 'export const a = 1;');
    expect(await searchWorkspaceForSelection(root, {})).toEqual([]);
    expect(
      await searchWorkspaceForSelection(root, { componentNames: ['Nowhere'] }),
    ).toEqual([]);
  });
});

describe('queryFromSelection', () => {
  const selection: BrowserDesignElementContext = {
    ref: 'e1',
    tag: 'button',
    id: 'save',
    classes: ['btn', 'btn-primary', 'mx-2'],
    selector: '#save',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    text: 'Salvar alterações do formulário de perfil agora mesmo por favor',
    outerHtml: '<button/>',
    attributes: {},
    computedStyles: {},
    url: 'http://localhost:5173/',
    frameworkHints: {
      framework: 'react',
      componentName: 'SaveButton',
      ownerChain: ['SaveButton', 'Toolbar', 'App', 'Root', 'Providers'],
    },
  };

  it('derives component names (nearest owners), classes, id and truncated text', () => {
    const query = queryFromSelection(selection);
    expect(query.componentNames).toEqual(['SaveButton', 'Toolbar', 'App']);
    expect(query.classes).toEqual(['btn', 'btn-primary', 'mx-2']);
    expect(query.id).toBe('save');
    expect(query.text!.length).toBeLessThanOrEqual(48);
    expect(query.text).toContain('Salvar');
  });

  it('omits fields the selection does not carry', () => {
    const bare = { ...selection, id: undefined, classes: [], text: '', frameworkHints: undefined };
    const query = queryFromSelection(bare);
    expect(query.componentNames).toBeUndefined();
    expect(query.classes).toBeUndefined();
    expect(query.id).toBeUndefined();
    expect(query.text).toBeUndefined();
  });
});
