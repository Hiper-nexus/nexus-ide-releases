import { describe, expect, it } from 'vitest';
import { appBundlePathFromExecPath } from './mic-tcc';

describe('appBundlePathFromExecPath', () => {
  it('extrai o bundle de um app empacotado', () => {
    expect(
      appBundlePathFromExecPath('/Applications/Nexus.app/Contents/MacOS/Nexus'),
    ).toBe('/Applications/Nexus.app');
  });

  it('extrai o bundle do shell dev (.dev-electron)', () => {
    expect(
      appBundlePathFromExecPath(
        '/Users/x/dev/nexus-ide/.dev-electron/Electron.app/Contents/MacOS/Electron',
      ),
    ).toBe('/Users/x/dev/nexus-ide/.dev-electron/Electron.app');
  });

  it('null fora de um bundle .app', () => {
    expect(appBundlePathFromExecPath('/usr/local/bin/electron')).toBeNull();
  });
});
