import { describe, expect, it } from 'vitest';

import { validateUpdateFeedUrl } from './update-feed-policy';

describe('update feed trust policy', () => {
  it('accepts only HTTPS Nexus/GitHub release origins', () => {
    expect(
      validateUpdateFeedUrl('https://api.nexuside.app/v1/updates/darwin/'),
    ).toBe('https://api.nexuside.app/v1/updates/darwin/');
    expect(
      validateUpdateFeedUrl(
        'https://github.com/Hiper-nexus/nexus-ide/releases/download/v0.32.16/',
      ),
    ).toBe(
      'https://github.com/Hiper-nexus/nexus-ide/releases/download/v0.32.16/',
    );
    expect(
      validateUpdateFeedUrl(
        'https://github.com/cleofasvolarehost/nexus-ide/releases/download/v0.12.0/',
      ),
    ).toBe(
      'https://github.com/cleofasvolarehost/nexus-ide/releases/download/v0.12.0/',
    );
    expect(
      validateUpdateFeedUrl(
        'https://github.com/cleofasvolarehost/nexus-ide-releases/releases/download/v0.32.16/',
      ),
    ).toBe(
      'https://github.com/cleofasvolarehost/nexus-ide-releases/releases/download/v0.32.16/',
    );
  });

  it('accepts only the exact stable Windows x64 path on the official update service', () => {
    expect(
      validateUpdateFeedUrl(
        'https://update.electronjs.org/Hiper-nexus/nexus-ide-releases/win32-x64/0.76.23',
      ),
    ).toBe(
      'https://update.electronjs.org/Hiper-nexus/nexus-ide-releases/win32-x64/0.76.23',
    );
  });

  it.each([
    'http://update.electronjs.org/Hiper-nexus/nexus-ide-releases/win32-x64/0.76.23',
    'https://user:pass@update.electronjs.org/Hiper-nexus/nexus-ide-releases/win32-x64/0.76.23',
    'https://update.electronjs.org/Hiper-nexus/nexus-ide/win32-x64/0.76.23',
    'https://update.electronjs.org/Hiper-nexus/nexus-ide-releases/win32-arm64/0.76.23',
    'https://update.electronjs.org/Hiper-nexus/nexus-ide-releases/win32-x64/v0.76.23',
    'https://update.electronjs.org/Hiper-nexus/nexus-ide-releases/win32-x64/0.76.23/extra',
    'https://update.electronjs.org/Hiper-nexus/nexus-ide-releases/win32-x64/0.76.23?channel=beta',
    'https://update.electronjs.org/Hiper-nexus/nexus-ide-releases/win32-x64/0.76.23#fragment',
  ])('rejects invalid official Windows feed %s', (url) => {
    expect(validateUpdateFeedUrl(url)).toBeNull();
  });

  it.each([
    'http://api.nexuside.app/updates',
    'https://127.0.0.1/updates',
    'https://nexuside.app.evil.test/updates',
    'https://user:pass@api.nexuside.app/updates',
    'https://api.nexuside.app:8443/updates',
    'https://stale-preview.nexuside.app/updates',
    'https://github.com/example/nexus/releases/download/v9/malware.zip',
    'https://github.com/cleofasvolarehost/nexus-ide/issues/1',
    'https://github.com/Hiper-nexus/nexus-ide/issues/1',
  ])('rejects untrusted executable update feed %s', (url) => {
    expect(validateUpdateFeedUrl(url)).toBeNull();
  });
});
