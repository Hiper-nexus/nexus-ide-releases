import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { armsBinPath } from './arms-bin-path';

describe('caminho do conector Arms (F-1579)', () => {
  it('no app empacotado aponta para a pasta resources real da instalação', () => {
    const resourcesPath = path.join('C:', 'Users', 'ana', 'AppData', 'Local', 'nexus_ide', 'app-0.76.316', 'resources');
    expect(armsBinPath({ isPackaged: true, resourcesPath, appPath: 'ignorado' }))
      .toBe(path.join(resourcesPath, 'nexus-arms.mjs'));
  });

  it('em desenvolvimento aponta para bin/ do repositório', () => {
    const appPath = path.join('repo', 'nexus-ide');
    expect(armsBinPath({ isPackaged: false, resourcesPath: 'ignorado', appPath }))
      .toBe(path.join(appPath, 'bin', 'nexus-arms.mjs'));
  });
});
