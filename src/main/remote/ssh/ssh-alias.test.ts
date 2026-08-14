import { describe, expect, it } from 'vitest';
import {
  classifySshBootstrapError,
  hashEndpoint,
  isSshAlias,
  looksLikeEndpoint,
  looksLikeIpv4,
  redactSshEndpoint,
  requireSshAlias,
} from './ssh-alias';

describe('ssh-alias', () => {
  it('accepts operator aliases and rejects IPs or user@host', () => {
    expect(isSshAlias('vps-1')).toBe(true);
    expect(isSshAlias('radarbi-hostgator')).toBe(true);
    expect(isSshAlias('10.0.0.8')).toBe(false);
    expect(isSshAlias('user@10.0.0.8')).toBe(false);
    expect(isSshAlias('-evil')).toBe(false);
    expect(looksLikeIpv4('10.0.0.8')).toBe(true);
    expect(looksLikeEndpoint('ubuntu@10.0.0.8')).toBe(true);
    expect(() => requireSshAlias('ubuntu@box')).toThrow('use a registered ssh alias');
  });

  it('redacts IPs from agent-visible text and hashes endpoints for debug', () => {
    expect(redactSshEndpoint('ssh: connect to host 10.0.0.8 port 22')).toBe(
      'ssh: connect to host [redacted-host] port 22',
    );
    expect(redactSshEndpoint('failed on box.internal', ['box.internal'])).toBe(
      'failed on [redacted-host]',
    );
    expect(hashEndpoint('10.0.0.8')).toMatch(/^[0-9a-f]{12}$/);
    expect(hashEndpoint('10.0.0.8')).not.toContain('10.0.0');
  });

  it('classifies honest bootstrap failures', () => {
    expect(classifySshBootstrapError('Permission denied (publickey,password)')).toBe(
      'auth',
    );
    expect(classifySshBootstrapError('Connection timed out')).toBe('timeout');
    expect(
      classifySshBootstrapError('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED'),
    ).toBe('host_key');
    expect(classifySshBootstrapError('Could not resolve hostname')).toBe(
      'unreachable',
    );
  });
});
