import { describe, expect, it } from 'vitest';
import {
  credentialLinkForEnv,
  credentialLinkForProvider,
} from './credential-links';

describe('credential links', () => {
  it('routes Grok to the official XAI_API_KEY credential slot', () => {
    expect(credentialLinkForProvider('grok')).toEqual(
      credentialLinkForEnv('XAI_API_KEY'),
    );
    expect(credentialLinkForEnv('GROK_API_KEY')).toBeNull();
  });
});
