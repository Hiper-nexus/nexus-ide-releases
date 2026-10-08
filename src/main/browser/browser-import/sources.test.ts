// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: casos de parseFirefoxProfiles de FirefoxCookies.test.ts sem Effect (path.posix/path.win32 no lugar de NodePath), mais a preferência de Network/Cookies sobre o Cookies legado de Sources.ts.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BROWSER_IMPORT_SOURCES, cookieDatabaseCandidatePaths, parseFirefoxProfiles } from './sources';

describe('cookieDatabaseCandidatePaths', () => {
  it('prefers the Chromium 96+ Network/Cookies jar over the legacy one, and keeps absolute Firefox profiles', () => {
    const context = { path: path.posix, platform: 'linux' as const, home: '/home/user' };
    const chrome = BROWSER_IMPORT_SOURCES.find((source) => source.id === 'chrome')!;
    const firefox = BROWSER_IMPORT_SOURCES.find((source) => source.id === 'firefox')!;
    expect(cookieDatabaseCandidatePaths(chrome, context, 'Default')).toEqual([
      '/home/user/.config/google-chrome/Default/Network/Cookies', '/home/user/.config/google-chrome/Default/Cookies',
    ]);
    expect(cookieDatabaseCandidatePaths(firefox, context, '/mnt/custom/profile')).toEqual(['/mnt/custom/profile/cookies.sqlite']);
    // Arc and Safari have no Linux build: nothing to read there.
    expect(cookieDatabaseCandidatePaths(BROWSER_IMPORT_SOURCES.find((source) => source.id === 'arc')!, context, 'Default')).toEqual([]);
  });
});

describe('parseFirefoxProfiles', () => {
  it('reads named profiles and ignores Install sections', () => {
    expect(parseFirefoxProfiles([
      '[Install4F96D1932A9F858E]', 'Default=Profiles/abcd1234.default-release', 'Locked=1', '',
      '[Profile0]', 'Name=default-release', 'IsRelative=1', 'Path=Profiles/abcd1234.default-release', '',
      '[Profile1]', 'Name=Work', 'IsRelative=0', 'Path=/Volumes/External/firefox-work', '',
      '[General]', 'StartWithLastProfile=1',
    ].join('\n'), path.posix, '/home/user/.mozilla/firefox')).toEqual([
      { directory: 'Profiles/abcd1234.default-release', name: 'default-release' },
      { directory: '/Volumes/External/firefox-work', name: 'Work' },
    ]);
  });

  it('falls back to the path when a profile has no name', () => {
    expect(parseFirefoxProfiles('[Profile0]\nPath=Profiles/x.default', path.posix, '/home/user/.mozilla/firefox'))
      .toEqual([{ directory: 'Profiles/x.default', name: 'Profiles/x.default' }]);
  });

  it.each(['/home/user/.mozilla/firefox', '/Users/user/Library/Application Support/Firefox'])('validates relative and absolute profile paths under %s', (root) => {
    expect(parseFirefoxProfiles([
      '[Profile0]', 'Name=Relative', 'IsRelative=1', 'Path=Profiles/relative.default',
      '[Profile1]', 'Name=Custom', 'IsRelative=0', 'Path=/mnt/custom/firefox-profile',
      '[Profile2]', 'IsRelative=1', 'Path=../../escape',
      '[Profile3]', 'IsRelative=1', 'Path=/absolute-marked-relative',
      '[Profile4]', 'IsRelative=0', 'Path=relative-marked-absolute',
      '[Profile5]', 'IsRelative=1', 'Path=Profiles/nul\u0000escape',
    ].join('\n'), path.posix, root)).toEqual([
      { directory: 'Profiles/relative.default', name: 'Relative' },
      { directory: '/mnt/custom/firefox-profile', name: 'Custom' },
    ]);
  });

  it('uses Windows path rules for relative and absolute profiles', () => {
    expect(parseFirefoxProfiles([
      '[Profile0]', 'Name=Relative', 'IsRelative=1', 'Path=Profiles\\relative.default',
      '[Profile1]', 'Name=Custom', 'IsRelative=0', 'Path=D:\\Firefox Profiles\\Work',
      '[Profile2]', 'IsRelative=1', 'Path=..\\..\\escape',
      '[Profile3]', 'IsRelative=1', 'Path=D:\\absolute-marked-relative',
      '[Profile4]', 'IsRelative=0', 'Path=relative-marked-absolute',
    ].join('\n'), path.win32, 'C:\\Users\\user\\Firefox')).toEqual([
      { directory: 'Profiles\\relative.default', name: 'Relative' },
      { directory: 'D:\\Firefox Profiles\\Work', name: 'Custom' },
    ]);
  });
});
