import { describe, expect, it } from 'vitest';
import { formatCompanionWebUrl } from './companion-web-link';

describe('formatCompanionWebUrl', () => {
  it('keeps the relay secret in the fragment of the Companion URL', () => {
    const relayLink =
      'wss://relay.nexuside.app/r/0123456789abcdef0123456789abcdef#room-secret';

    expect(formatCompanionWebUrl(relayLink)).toBe(
      'https://app.nexuside.app/#wss%3A%2F%2Frelay.nexuside.app%2Fr%2F0123456789abcdef0123456789abcdef%23room-secret',
    );
  });

  it('rejects a malformed relay room link', () => {
    expect(() => formatCompanionWebUrl('not-a-url')).toThrow('invalid relay room link');
  });
});
