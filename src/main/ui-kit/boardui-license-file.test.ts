import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  boarduiConfigRoot,
  boarduiLicenseFilePath,
  isProvisionedBoardUiLicense,
  parseBoardUiLicenseFile,
  realBoardUiLicenseFileOps,
  serializeBoardUiLicenseFile,
  type BoardUiLicenseFile,
} from './boardui-license-file';

const OPERATOR: BoardUiLicenseFile = {
  licenseKey: '4889238F-A27C-46BC-8D42-7C7AB11A636E',
  instanceId: '1e124f71-2781-4173-96a3-ff66a5ef2a27',
  instanceName: 'boardui-cli@MacBook-Pro-de-Cleofas.local',
};

describe('boarduiConfigRoot — mirrors the vendored CLI', () => {
  it('prefers XDG_CONFIG_HOME on every platform', () => {
    expect(boarduiConfigRoot({ XDG_CONFIG_HOME: '/xdg' }, 'linux')).toBe('/xdg');
    expect(boarduiConfigRoot({ XDG_CONFIG_HOME: '/xdg', APPDATA: 'C:\\app' }, 'win32')).toBe('/xdg');
    expect(boarduiConfigRoot({ XDG_CONFIG_HOME: '/xdg', HOME: '/users/me' }, 'darwin')).toBe('/xdg');
  });

  it('falls back to APPDATA on Windows only', () => {
    expect(boarduiConfigRoot({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32')).toBe(
      'C:\\Users\\me\\AppData\\Roaming',
    );
    // The same env on another platform must NOT take the Windows branch.
    expect(boarduiConfigRoot({ APPDATA: 'C:\\app', HOME: '/users/me' }, 'linux')).toBe(
      path.normalize('/users/me/.config'),
    );
  });

  it('an empty XDG_CONFIG_HOME is not a root — the CLI checks truthiness', () => {
    expect(boarduiConfigRoot({ XDG_CONFIG_HOME: '', HOME: '/users/me' }, 'linux')).toBe(
      path.normalize('/users/me/.config'),
    );
  });

  it('resolves HOME from the CHILD env, like os.homedir() inside the child', () => {
    expect(boarduiConfigRoot({ HOME: '/Users/op' }, 'darwin')).toBe(path.normalize('/Users/op/.config'));
    expect(boarduiConfigRoot({ HOME: '/home/op' }, 'linux')).toBe(path.normalize('/home/op/.config'));
  });

  it('uses the real homedir when the env carries no HOME', () => {
    expect(boarduiConfigRoot({}, 'linux', () => '/fallback/home')).toBe(path.normalize('/fallback/home/.config'));
  });

  it('the licence file sits in boardui/license.json under the root', () => {
    expect(boarduiLicenseFilePath('/xdg')).toBe(
      path.join('/xdg', 'boardui', 'license.json'),
    );
  });
});

describe('parseBoardUiLicenseFile — the CLI own rules', () => {
  it('round-trips the serialized payload', () => {
    expect(parseBoardUiLicenseFile(serializeBoardUiLicenseFile(OPERATOR))).toEqual(OPERATOR);
  });

  it('accepts the fields the vendor itself writes', () => {
    expect(
      parseBoardUiLicenseFile(
        JSON.stringify(
          {
            licenseKey: 'BUI-1',
            instanceId: 'inst-1',
            instanceName: 'boardui-cli@host',
          },
          null,
          2,
        ),
      ),
    ).toEqual({ licenseKey: 'BUI-1', instanceId: 'inst-1', instanceName: 'boardui-cli@host' });
  });

  it('a missing or empty licenseKey is no licence at all', () => {
    expect(parseBoardUiLicenseFile('{"instanceId":"i"}')).toBeNull();
    expect(parseBoardUiLicenseFile('{"licenseKey":"","instanceId":"i"}')).toBeNull();
    expect(parseBoardUiLicenseFile('{"licenseKey":42}')).toBeNull();
  });

  it('non-string instanceId and instanceName fall back to empty strings', () => {
    expect(parseBoardUiLicenseFile('{"licenseKey":"BUI-1","instanceId":7}')).toEqual({
      licenseKey: 'BUI-1',
      instanceId: '',
      instanceName: '',
    });
  });

  it('unparseable bytes are no licence either', () => {
    expect(parseBoardUiLicenseFile('not json at all')).toBeNull();
    expect(parseBoardUiLicenseFile('[]')).toBeNull();
    expect(parseBoardUiLicenseFile('"just a string"')).toBeNull();
  });
});

describe('isProvisionedBoardUiLicense — what keeps "Remover" local', () => {
  it('matches the exact payload: key AND instanceId', () => {
    expect(isProvisionedBoardUiLicense(OPERATOR, OPERATOR)).toBe(true);
  });

  it('the same key with ANOTHER instanceId is a native activation, not ours', () => {
    expect(
      isProvisionedBoardUiLicense(
        { ...OPERATOR, instanceId: 'server-issued-instance' },
        OPERATOR,
      ),
    ).toBe(false);
  });

  it('another key on the same instance is not ours either', () => {
    expect(
      isProvisionedBoardUiLicense({ ...OPERATOR, licenseKey: 'BUI-CLIENT-OWN' }, OPERATOR),
    ).toBe(false);
  });

  it('no file is never provisioned', () => {
    expect(isProvisionedBoardUiLicense(null, OPERATOR)).toBe(false);
  });
});

describe('realBoardUiLicenseFileOps — the real config root', () => {
  let root = '';
  let ops = realBoardUiLicenseFileOps('linux', {});

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-boardui-license-'));
    ops = realBoardUiLicenseFileOps('linux', { XDG_CONFIG_HOME: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads back what it wrote, under boardui/license.json', () => {
    expect(ops.write(OPERATOR)).toEqual({ ok: true });
    const file = boarduiLicenseFilePath(root);
    expect(fs.existsSync(file)).toBe(true);
    expect(ops.read()).toEqual({ status: 'parsed', file: OPERATOR });
  });

  it.skipIf(process.platform === 'win32')('writes a POSIX licence file with mode 0600', () => {
    // Windows reports synthetic POSIX mode bits; ACLs need a Windows-specific
    // security proof and are not certified by this assertion.
    expect(ops.write(OPERATOR)).toEqual({ ok: true });
    expect(fs.statSync(boarduiLicenseFilePath(root)).mode & 0o777).toBe(0o600);
  });

  it('a missing file is absence, positively established — never confused with unreadable', () => {
    expect(ops.read()).toEqual({ status: 'absent' });
  });

  it('a file the process cannot read is unreadable, not absent', () => {
    // A directory where the file should be: readFileSync answers EISDIR, a
    // non-ENOENT error — the same class as EACCES on a locked-down file.
    fs.mkdirSync(boarduiLicenseFilePath(root), { recursive: true });
    expect(ops.read()).toEqual({ status: 'unreadable' });
  });

  it('an empty bundle env writes under <HOME>/.config, like the child', () => {
    const homeOps = realBoardUiLicenseFileOps('linux', { HOME: root });
    expect(homeOps.write(OPERATOR)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(root, '.config', 'boardui', 'license.json'))).toBe(true);
  });

  it('remove deletes the file and tolerates a missing one', () => {
    expect(ops.remove()).toEqual({ ok: true });
    ops.write(OPERATOR);
    expect(ops.remove()).toEqual({ ok: true });
    expect(ops.read()).toEqual({ status: 'absent' });
    expect(fs.existsSync(boarduiLicenseFilePath(root))).toBe(false);
    // The directory stays — it is the CLI's own home, not ours to prune.
    expect(fs.existsSync(path.join(root, 'boardui'))).toBe(true);
  });

  it('a corrupted file is present but not a licence — re-provisioning may heal it', () => {
    fs.mkdirSync(path.join(root, 'boardui'), { recursive: true });
    fs.writeFileSync(boarduiLicenseFilePath(root), 'corrupted');
    expect(ops.read()).toEqual({ status: 'parsed', file: null });
  });
});
