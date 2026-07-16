import { describe, expect, it } from 'vitest';
import { isAcceptableBackendUrl, resolveBackendUrl } from './backend-url';

describe('backend-url (L6)', () => {
  it('accepts https origins', () => {
    expect(isAcceptableBackendUrl('https://api.nexuside.app')).toBe(true);
    expect(isAcceptableBackendUrl('https://staging.example.com')).toBe(true);
  });

  it('accepts http only for loopback dev', () => {
    expect(isAcceptableBackendUrl('http://localhost:8787')).toBe(true);
    expect(isAcceptableBackendUrl('http://127.0.0.1:8787')).toBe(true);
  });

  it('rejects non-loopback http and junk', () => {
    expect(isAcceptableBackendUrl('http://attacker.example')).toBe(false);
    expect(isAcceptableBackendUrl('ftp://x')).toBe(false);
    expect(isAcceptableBackendUrl('not a url')).toBe(false);
  });

  it('falls back to the HTTPS default for an insecure override', () => {
    expect(resolveBackendUrl('http://attacker.example')).toBe(
      'https://api.nexuside.app',
    );
  });

  it('uses a valid override and the default when unset', () => {
    expect(resolveBackendUrl('https://staging.example.com')).toBe(
      'https://staging.example.com',
    );
    expect(resolveBackendUrl(undefined)).toBe('https://api.nexuside.app');
  });
});
