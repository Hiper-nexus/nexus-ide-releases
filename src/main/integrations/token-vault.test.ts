import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  resolveVoiceApiKey: vi.fn(),
  hasStoredVoiceApiKey: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }));
vi.mock('../voice/voice-secrets', () => ({
  resolveVoiceApiKey: mocks.resolveVoiceApiKey,
  hasStoredVoiceApiKey: mocks.hasStoredVoiceApiKey,
  setVoiceApiKey: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.resolveVoiceApiKey.mockReturnValue(null);
  mocks.hasStoredVoiceApiKey.mockReturnValue(false);
});
afterEach(() => vi.unstubAllEnvs());

describe('forge token provenance', () => {
  it.each([undefined, 'github.enterprise.example'])('pins gh to github.com regardless of GH_HOST=%s', async (host) => {
    vi.stubEnv('GH_HOST', host);
    mocks.execFileSync.mockImplementation((_bin, args) =>
      args.includes('--hostname') && args.includes('github.com')
        ? 'github-test-token\n'
        : 'enterprise-test-token\n');
    const { getGithubToken } = await import('./token-vault');
    expect(getGithubToken()).toBe('github-test-token');
    expect(mocks.execFileSync).toHaveBeenCalledWith('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  });

  it('preserves the glab lookup contract', async () => {
    mocks.execFileSync.mockReturnValue('gitlab-test-token\n');
    const { getGitlabToken } = await import('./token-vault');
    expect(getGitlabToken()).toBe('gitlab-test-token');
    expect(mocks.execFileSync).toHaveBeenCalledWith('glab', ['auth', 'token'], expect.any(Object));
  });

  it('fails closed without falling back to another gh host', async () => {
    vi.stubEnv('GH_HOST', 'github.enterprise.example');
    mocks.execFileSync.mockImplementation(() => { throw new Error('missing github.com session'); });
    const { getGithubToken } = await import('./token-vault');
    expect(getGithubToken()).toBeNull();
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.execFileSync.mock.calls[0]?.[1]).toEqual(['auth', 'token', '--hostname', 'github.com']);
  });

  it('preserves explicit configured credentials without consulting the CLI', async () => {
    mocks.resolveVoiceApiKey.mockReturnValue('configured-test-token');
    const { getGithubToken } = await import('./token-vault');
    expect(getGithubToken()).toBe('configured-test-token');
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });
});
