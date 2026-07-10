import { describe, expect, it } from 'vitest';

import { validateUpdateFeedUrl } from './update-feed-policy';

describe('update feed trust policy', () => {
  it('accepts only HTTPS Nexus/GitHub release origins', () => {
    expect(
      validateUpdateFeedUrl('https://api.nexuside.app/v1/updates/darwin/'),
    ).toBe('https://api.nexuside.app/v1/updates/darwin/');
    expect(
      validateUpdateFeedUrl(
        'https://github.com/cleofasvolarehost/nexus-ide/releases/download/v0.12.0/',
      ),
    ).toBe(
      'https://github.com/cleofasvolarehost/nexus-ide/releases/download/v0.12.0/',
    );
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
  ])('rejects untrusted executable update feed %s', (url) => {
    expect(validateUpdateFeedUrl(url)).toBeNull();
  });
});
