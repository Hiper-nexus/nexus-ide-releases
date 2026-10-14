import { describe, expect, it } from 'vitest';
import {
  shortenWorkspacePath,
  workspacePathLabels,
} from './workspace-path-label';

describe('shortenWorkspacePath', () => {
  it('drops the prefix every folder shares and keeps the tail that names it', () => {
    expect(shortenWorkspacePath('/Users/ana/dev/nexus-ide')).toBe(
      '…/dev/nexus-ide',
    );
  });

  it('leaves a path shorter than the cut exactly as it is', () => {
    expect(shortenWorkspacePath('/srv/app')).toBe('/srv/app');
    expect(shortenWorkspacePath('/')).toBe('/');
    expect(shortenWorkspacePath('')).toBe('');
  });

  it('trata caminho Windows com barra invertida como segmentos', () => {
    expect(
      shortenWorkspacePath('C:\\Users\\ana\\dev\\nexus-ide'),
    ).toBe('…/dev/nexus-ide');
    expect(shortenWorkspacePath('C:\\srv\\app')).toBe('…/srv/app');
  });

  it('normalizes trailing separators instead of spending a segment on them', () => {
    expect(shortenWorkspacePath('/Users/ana/dev/nexus-ide/')).toBe(
      '…/dev/nexus-ide',
    );
  });
});

describe('workspacePathLabels', () => {
  it('grows a label only until it stops colliding with the other folders', () => {
    const labels = workspacePathLabels([
      { id: 'a', path: '/Users/ana/dev/lupygo/apps/web' },
      { id: 'b', path: '/Users/ana/dev/volare/apps/web' },
      { id: 'c', path: '/Users/ana/dev/nexus-ide' },
    ]);

    // Os dois `web` só se separam no nome do repositório.
    expect(labels.get('a')).toBe('…/lupygo/apps/web');
    expect(labels.get('b')).toBe('…/volare/apps/web');
    // O que já é único fica curto e cabe no rail estreito.
    expect(labels.get('c')).toBe('…/dev/nexus-ide');
  });

  it('stops at the full path instead of inventing depth that does not exist', () => {
    const labels = workspacePathLabels([
      { id: 'a', path: '/srv/web' },
      { id: 'b', path: '/opt/web' },
    ]);
    expect(labels.get('a')).toBe('/srv/web');
    expect(labels.get('b')).toBe('/opt/web');
  });

  it('ignores workspaces with no path at all', () => {
    const labels = workspacePathLabels([
      { id: 'a' },
      { id: 'b', path: '/Users/ana/dev/nexus-ide' },
    ]);
    expect(labels.has('a')).toBe(false);
    expect(labels.get('b')).toBe('…/dev/nexus-ide');
  });

  it('terminates on duplicate paths rather than looping for a difference', () => {
    const labels = workspacePathLabels([
      { id: 'a', path: '/Users/ana/dev/web' },
      { id: 'b', path: '/Users/ana/dev/web' },
    ]);
    expect(labels.get('a')).toBe('/Users/ana/dev/web');
    expect(labels.get('b')).toBe('/Users/ana/dev/web');
  });
});
