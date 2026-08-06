import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getCatalogIndex,
  installCatalogItem,
  reviewCatalogInstall,
} from './catalog';
import { PLUGIN_MANIFEST_SCHEMA } from './agent-plugin-manifest';
import { listInstalledCatalogItems } from './catalog-installed';

const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
const REPO = 'davila7/claude-code-templates';
const API_BASE = `https://api.github.com/repos/${REPO}`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${COMMIT_SHA}`;

function responseAt(
  url: string,
  body: BodyInit | null,
  init: ResponseInit = {},
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function jsonAt(
  url: string,
  value: unknown,
  init: ResponseInit = {},
): Response {
  return responseAt(url, JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function commitResponse(): Response {
  const url = `${API_BASE}/commits/main`;
  return jsonAt(url, { sha: COMMIT_SHA });
}

describe('catalog immutable supply chain', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-catalog-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('resolves main once then fetches and caches the index by immutable SHA', async () => {
    const treeUrl = `${API_BASE}/git/trees/${COMMIT_SHA}?recursive=1`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(commitResponse())
      .mockResolvedValueOnce(
        jsonAt(treeUrl, {
          truncated: false,
          tree: [
            { path: 'cli-tool/components/agents/researcher.md' },
            { path: 'cli-tool/components/skills/coding/SKILL.md' },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getCatalogIndex(true);

    expect(result.ok).toBe(true);
    expect(result.index?.provenance).toMatchObject({
      repository: REPO,
      commitSha: COMMIT_SHA,
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${API_BASE}/commits/main`,
      treeUrl,
    ]);
    expect(
      fetchMock.mock.calls.every(([, init]) => init?.redirect === 'error'),
    ).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(home, '.nexus', 'catalog-cache.json'),
          'utf8',
        ),
      ).provenance.commitSha,
    ).toBe(COMMIT_SHA);
  });

  it('shows an installed Agent Plugins skill in the live catalog as installed', async () => {
    const pluginRoot = path.join(home, '.nexus', 'plugins', 'acme');
    const skillRoot = path.join(pluginRoot, 'skills', 'review');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        $schema: PLUGIN_MANIFEST_SCHEMA,
        name: 'acme',
        version: '1.0.0',
        description: 'Acme plugin',
      }),
    );
    fs.writeFileSync(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: review\ndescription: Review code.\n---\n',
    );
    const treeUrl = `${API_BASE}/git/trees/${COMMIT_SHA}?recursive=1`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(commitResponse())
        .mockResolvedValueOnce(
          jsonAt(treeUrl, { truncated: false, tree: [] }),
        ),
    );

    const result = await getCatalogIndex(true);
    const installed = listInstalledCatalogItems(home);

    expect(result.index?.skills).toContainEqual({
      kind: 'skill',
      slug: 'agent-plugin/acme/review',
      name: 'acme:review',
      category: 'agent-plugin',
    });
    expect(installed).toContainEqual(
      expect.objectContaining({ kind: 'skill', name: 'acme:review' }),
    );
  });

  it('deduplicates concurrent index refreshes into one bounded network flight', async () => {
    const treeUrl = `${API_BASE}/git/trees/${COMMIT_SHA}?recursive=1`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(commitResponse())
      .mockResolvedValueOnce(jsonAt(treeUrl, {
        truncated: false,
        tree: [{ path: 'cli-tool/components/agents/researcher.md' }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all(
      Array.from({ length: 100 }, () => getCatalogIndex(true)),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((result) => result.index)).size).toBe(1);
  });

  it('installs an agent from the resolved SHA and records its digest', async () => {
    const agentUrl = `${RAW_BASE}/cli-tool/components/agents/researcher.md`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(commitResponse())
      .mockResolvedValueOnce(responseAt(agentUrl, '# Researcher\n'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await installCatalogItem({
      kind: 'agent',
      slug: 'researcher',
    });

    expect(result).toMatchObject({
      ok: true,
      installed: { name: 'researcher.md' },
      provenance: {
        repository: REPO,
        commitSha: COMMIT_SHA,
        fileCount: 1,
        totalBytes: 13,
      },
    });
    expect(result.provenance?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      fs.readFileSync(
        path.join(home, '.claude', 'agents', 'researcher.md'),
        'utf8',
      ),
    ).toBe('# Researcher\n');
    if (process.platform !== 'win32') {
      expect(
        fs.statSync(path.join(home, '.claude', 'agents', 'researcher.md')).mode &
          0o777,
      ).toBe(0o600);
    }
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      `https://raw.githubusercontent.com/${REPO}/main/cli-tool/components/agents/researcher.md`,
    );
  });

  it('reviews only a cached exact catalog member without fetching or writing', async () => {
    const treeUrl = `${API_BASE}/git/trees/${COMMIT_SHA}?recursive=1`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(commitResponse())
      .mockResolvedValueOnce(jsonAt(treeUrl, {
        truncated: false,
        tree: [{ path: 'cli-tool/components/agents/researcher.md' }],
      }));
    vi.stubGlobal('fetch', fetchMock);
    await getCatalogIndex(true);
    fetchMock.mockClear();

    const reviewed = reviewCatalogInstall({
      kind: 'agent',
      slug: 'researcher',
    });
    expect(reviewed).toMatchObject({
      ok: true,
      candidate: {
        repository: REPO,
        commitSha: COMMIT_SHA,
        slug: 'researcher',
        targetPath: path.join(home, '.claude', 'agents', 'researcher.md'),
      },
    });
    expect(reviewCatalogInstall({
      kind: 'agent',
      slug: 'not-in-reviewed-index',
    })).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('keeps staging private and removes it when exact payload consent is denied', async () => {
    const agentUrl = `${RAW_BASE}/cli-tool/components/agents/researcher.md`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(commitResponse())
        .mockResolvedValueOnce(responseAt(agentUrl, '# Researcher\n')),
    );
    const beforePublish = vi.fn(async (candidate) => {
      expect(candidate).toMatchObject({
        repository: REPO,
        commitSha: COMMIT_SHA,
        kind: 'agent',
        slug: 'researcher',
        fileCount: 1,
        totalBytes: 13,
      });
      expect(candidate.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(fs.existsSync(candidate.targetPath)).toBe(false);
      return false;
    });

    const result = await installCatalogItem(
      { kind: 'agent', slug: 'researcher' },
      { beforePublish },
    );

    expect(result).toEqual({ ok: false, error: 'user_denied' });
    expect(beforePublish).toHaveBeenCalledOnce();
    const parent = path.join(home, '.claude', 'agents');
    expect(fs.existsSync(path.join(parent, 'researcher.md'))).toBe(false);
    expect(
      fs.existsSync(parent)
        ? fs.readdirSync(parent).filter((name) => name.includes('.staging-'))
        : [],
    ).toEqual([]);
  });

  it('rehashes staged agent bytes after review and refuses a changed candidate', async () => {
    const agentUrl = `${RAW_BASE}/cli-tool/components/agents/researcher.md`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(commitResponse())
        .mockResolvedValueOnce(responseAt(agentUrl, '# Researcher\n')),
    );

    const result = await installCatalogItem(
      { kind: 'agent', slug: 'researcher' },
      {
        beforePublish: async () => {
          const parent = path.join(home, '.claude', 'agents');
          const staging = fs.readdirSync(parent).find((name) =>
            name.includes('.staging-'),
          );
          expect(staging).toBeDefined();
          fs.writeFileSync(path.join(parent, staging!, 'payload'), 'changed');
          return true;
        },
      },
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/changed after review/i);
    expect(
      fs.existsSync(path.join(home, '.claude', 'agents', 'researcher.md')),
    ).toBe(false);
  });

  it('preserves a dangling symlink target and performs zero network access', async () => {
    if (process.platform === 'win32') return;
    const parent = path.join(home, '.claude', 'agents');
    fs.mkdirSync(parent, { recursive: true });
    const target = path.join(parent, 'researcher.md');
    fs.symlinkSync(path.join(home, 'missing-target'), target);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const result = await installCatalogItem({
      kind: 'agent',
      slug: 'researcher',
    });

    expect(result).toEqual({ ok: true, skipped: true });
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows only one active catalog prepare and performs zero fetch for the contender', async () => {
    const firstUrl = `${RAW_BASE}/cli-tool/components/agents/first.md`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(commitResponse())
      .mockResolvedValueOnce(responseAt(firstUrl, '# First\n'));
    vi.stubGlobal('fetch', fetchMock);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const prepared = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = installCatalogItem(
      { kind: 'agent', slug: 'first' },
      {
        beforePublish: async () => {
          started();
          await gate;
          return true;
        },
      },
    );
    await prepared;

    const second = await installCatalogItem({
      kind: 'agent',
      slug: 'second',
    });
    expect(second).toEqual({ ok: false, error: 'catalog_install_busy' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    release();
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it('uses the immutable ref for contents and raw skill files', async () => {
    const rootPath = 'cli-tool/components/skills/coding';
    const contentsUrl = `${API_BASE}/contents/${rootPath}?ref=${COMMIT_SHA}`;
    const skillUrl = `${RAW_BASE}/${rootPath}/SKILL.md`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(commitResponse())
      .mockResolvedValueOnce(
        jsonAt(contentsUrl, [
          {
            type: 'file',
            name: 'SKILL.md',
            path: `${rootPath}/SKILL.md`,
            download_url: skillUrl,
          },
        ]),
      )
      .mockResolvedValueOnce(responseAt(skillUrl, '# Coding\n'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await installCatalogItem({ kind: 'skill', slug: 'coding' });

    expect(result).toMatchObject({
      ok: true,
      provenance: { commitSha: COMMIT_SHA, fileCount: 1, totalBytes: 9 },
    });
    expect(
      fs.readFileSync(
        path.join(home, '.claude', 'skills', 'coding', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# Coding\n');
    if (process.platform !== 'win32') {
      expect(
        fs.statSync(path.join(home, '.claude', 'skills', 'coding')).mode & 0o777,
      ).toBe(0o700);
      expect(
        fs.statSync(
          path.join(home, '.claude', 'skills', 'coding', 'SKILL.md'),
        ).mode & 0o777,
      ).toBe(0o600);
    }
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${API_BASE}/commits/main`,
      contentsUrl,
      skillUrl,
    ]);
  });

  it('rewalks the staged skill and rejects an added symlink before publish', async () => {
    if (process.platform === 'win32') return;
    const rootPath = 'cli-tool/components/skills/coding';
    const contentsUrl = `${API_BASE}/contents/${rootPath}?ref=${COMMIT_SHA}`;
    const skillUrl = `${RAW_BASE}/${rootPath}/SKILL.md`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(commitResponse())
        .mockResolvedValueOnce(jsonAt(contentsUrl, [{
          type: 'file',
          name: 'SKILL.md',
          path: `${rootPath}/SKILL.md`,
          download_url: skillUrl,
        }]))
        .mockResolvedValueOnce(responseAt(skillUrl, '# Coding\n')),
    );

    const result = await installCatalogItem(
      { kind: 'skill', slug: 'coding' },
      {
        beforePublish: async () => {
          const parent = path.join(home, '.claude', 'skills');
          const staging = fs.readdirSync(parent).find((name) =>
            name.includes('.staging-'),
          );
          expect(staging).toBeDefined();
          fs.symlinkSync('/tmp', path.join(parent, staging!, 'late-link'));
          return true;
        },
      },
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/symlink/i);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'coding'))).toBe(
      false,
    );
  });

  it('does not overwrite a target created while payload confirmation is open', async () => {
    const agentUrl = `${RAW_BASE}/cli-tool/components/agents/researcher.md`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(commitResponse())
        .mockResolvedValueOnce(responseAt(agentUrl, '# Researcher\n')),
    );
    const target = path.join(home, '.claude', 'agents', 'researcher.md');

    const result = await installCatalogItem(
      { kind: 'agent', slug: 'researcher' },
      {
        beforePublish: async () => {
          fs.writeFileSync(target, 'concurrent owner', { flag: 'wx' });
          return true;
        },
      },
    );

    expect(result).toEqual({ ok: true, skipped: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('concurrent owner');
  });

  it('rejects a download URL outside the pinned raw GitHub path', async () => {
    const rootPath = 'cli-tool/components/skills/coding';
    const contentsUrl = `${API_BASE}/contents/${rootPath}?ref=${COMMIT_SHA}`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(commitResponse())
        .mockResolvedValueOnce(
          jsonAt(contentsUrl, [
            {
              type: 'file',
              name: 'SKILL.md',
              path: `${rootPath}/SKILL.md`,
              download_url: 'https://attacker.test/payload',
            },
          ]),
        ),
    );

    const result = await installCatalogItem({ kind: 'skill', slug: 'coding' });

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/unexpected.*URL|URL.*unexpected/i);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'coding'))).toBe(
      false,
    );
  });

  it('rejects redirected or mismatched responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonAt('https://attacker.test/commits/main', { sha: COMMIT_SHA }),
        ),
    );

    const result = await installCatalogItem({
      kind: 'agent',
      slug: 'researcher',
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/unexpected.*URL|URL.*unexpected/i);
  });

  it('enforces file byte limits before allocating the advertised body', async () => {
    const agentUrl = `${RAW_BASE}/cli-tool/components/agents/researcher.md`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(commitResponse())
        .mockResolvedValueOnce(
          responseAt(agentUrl, 'small', {
            headers: { 'content-length': String(64 * 1024 * 1024) },
          }),
        ),
    );

    const result = await installCatalogItem({
      kind: 'agent',
      slug: 'researcher',
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/too large|byte limit/i);
    expect(
      fs.existsSync(path.join(home, '.claude', 'agents', 'researcher.md')),
    ).toBe(false);
  });

  it('keeps the timeout active while a response body is stalled', async () => {
    vi.useFakeTimers();
    const agentUrl = `${RAW_BASE}/cli-tool/components/agents/researcher.md`;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === `${API_BASE}/commits/main`) return commitResponse();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new Error('catalog body aborted by deadline'));
          }, { once: true });
        },
      });
      return responseAt(agentUrl, stream);
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = installCatalogItem({
      kind: 'agent',
      slug: 'researcher',
    });
    await vi.advanceTimersByTimeAsync(20_001);
    const result = await pending;

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/aborted|deadline/i);
    expect(
      fs.existsSync(path.join(home, '.claude', 'agents', 'researcher.md')),
    ).toBe(false);
  });

  it('enforces one total deadline across individually fast requests and releases the install lock', async () => {
    vi.useFakeTimers();
    const rootPath = 'cli-tool/components/skills/coding';
    const contentsUrl = `${API_BASE}/contents/${rootPath}?ref=${COMMIT_SHA}`;
    const skillUrl = `${RAW_BASE}/${rootPath}/SKILL.md`;
    const delayed = (
      response: Response,
      signal: AbortSignal | null | undefined,
    ): Promise<Response> =>
      new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(signal?.reason ?? new Error('catalog operation aborted'));
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(response);
        }, 40);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      if (url === `${API_BASE}/commits/main`) {
        return delayed(commitResponse(), init?.signal);
      }
      if (url === contentsUrl) {
        return delayed(
          jsonAt(contentsUrl, [
            {
              type: 'file',
              name: 'SKILL.md',
              path: `${rootPath}/SKILL.md`,
              download_url: skillUrl,
            },
          ]),
          init?.signal,
        );
      }
      return delayed(responseAt(skillUrl, '# Coding\n'), init?.signal);
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = installCatalogItem(
      { kind: 'skill', slug: 'coding' },
      { operationTimeoutMs: 100 },
    );
    await vi.advanceTimersByTimeAsync(101);
    const result = await pending;

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/operation deadline/i);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'coding'))).toBe(
      false,
    );
    const skillsParent = path.join(home, '.claude', 'skills');
    expect(
      fs.existsSync(skillsParent)
        ? fs
            .readdirSync(skillsParent)
            .filter((name) => name.includes('.staging-'))
        : [],
    ).toEqual([]);

    vi.useRealTimers();
    const agentUrl = `${RAW_BASE}/cli-tool/components/agents/researcher.md`;
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(responseAt(agentUrl, '# Researcher\n'));
    const retry = await installCatalogItem(
      { kind: 'agent', slug: 'researcher' },
      { expectedCommitSha: COMMIT_SHA },
    );
    expect(retry).toMatchObject({ ok: true, installed: { name: 'researcher.md' } });
  });

  it('keeps the lane occupied until a native confirmation settles after its deadline', async () => {
    vi.useFakeTimers();
    const agentUrl = `${RAW_BASE}/cli-tool/components/agents/researcher.md`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(responseAt(agentUrl, '# Researcher\n'));
    vi.stubGlobal('fetch', fetchMock);
    let settleConfirmation!: (approved: boolean) => void;
    let markConfirmationStarted!: () => void;
    const confirmationStarted = new Promise<void>((resolve) => {
      markConfirmationStarted = resolve;
    });
    const beforePublish = vi.fn(
      () => {
        markConfirmationStarted();
        return new Promise<boolean>((resolve) => {
          settleConfirmation = resolve;
        });
      },
    );

    const pending = installCatalogItem(
      { kind: 'agent', slug: 'researcher' },
      {
        expectedCommitSha: COMMIT_SHA,
        operationTimeoutMs: 100,
        beforePublish,
      },
    );
    await confirmationStarted;
    expect(beforePublish).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(101);
    const overlap = await installCatalogItem(
      { kind: 'agent', slug: 'writer' },
      { expectedCommitSha: COMMIT_SHA, beforePublish },
    );
    expect(overlap).toEqual({ ok: false, error: 'catalog_install_busy' });
    expect(beforePublish).toHaveBeenCalledTimes(1);

    settleConfirmation(true);
    await vi.advanceTimersByTimeAsync(0);
    const expired = await pending;
    expect(expired).toMatchObject({ ok: false });
    expect(expired.error).toMatch(/operation deadline/i);
    expect(
      fs.existsSync(path.join(home, '.claude', 'agents', 'researcher.md')),
    ).toBe(false);

    vi.useRealTimers();
    fetchMock.mockResolvedValueOnce(responseAt(agentUrl, '# Researcher\n'));
    const retry = await installCatalogItem(
      { kind: 'agent', slug: 'researcher' },
      { expectedCommitSha: COMMIT_SHA },
    );
    expect(retry).toMatchObject({ ok: true, installed: { name: 'researcher.md' } });
  });

  it('rejects dot segments before any filesystem or network access', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const dot = await installCatalogItem({ kind: 'skill', slug: '.' });
    const traversal = await installCatalogItem({
      kind: 'skill',
      slug: 'coding/../payload',
    });

    expect(dot).toEqual({ ok: false, error: 'invalid slug' });
    expect(traversal).toEqual({ ok: false, error: 'invalid slug' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('caps the number of skill entries and cleans staging', async () => {
    const rootPath = 'cli-tool/components/skills/coding';
    const contentsUrl = `${API_BASE}/contents/${rootPath}?ref=${COMMIT_SHA}`;
    const entries = Array.from({ length: 501 }, (_, index) => ({
      type: 'dir',
      name: `dir-${index}`,
      path: `${rootPath}/dir-${index}`,
      download_url: null,
    }));
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(commitResponse())
        .mockResolvedValueOnce(jsonAt(contentsUrl, entries)),
    );

    const result = await installCatalogItem({ kind: 'skill', slug: 'coding' });

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/entry cap/i);
    const skillsParent = path.join(home, '.claude', 'skills');
    expect(fs.existsSync(path.join(skillsParent, 'coding'))).toBe(false);
    expect(
      fs.existsSync(skillsParent)
        ? fs
            .readdirSync(skillsParent)
            .filter((name) => name.includes('.staging-'))
        : [],
    ).toEqual([]);
  });

  it('caps recursive contents requests even when directory entry count is valid', async () => {
    const rootPath = 'cli-tool/components/skills/coding';
    const rootUrl = `${API_BASE}/contents/${rootPath}?ref=${COMMIT_SHA}`;
    const directories = Array.from({ length: 257 }, (_, index) => ({
      type: 'dir',
      name: `dir-${index}`,
      path: `${rootPath}/dir-${index}`,
      download_url: null,
    }));
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === `${API_BASE}/commits/main`) return commitResponse();
      if (url === rootUrl) return jsonAt(rootUrl, directories);
      return jsonAt(url, []);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await installCatalogItem({ kind: 'skill', slug: 'coding' });

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/contents request cap/i);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/contents/'),
      ),
    ).toHaveLength(256);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'coding'))).toBe(
      false,
    );
  });

  it('caps aggregate skill bytes even when every file fits the per-file cap', async () => {
    const rootPath = 'cli-tool/components/skills/coding';
    const contentsUrl = `${API_BASE}/contents/${rootPath}?ref=${COMMIT_SHA}`;
    const entries = Array.from({ length: 9 }, (_, index) => {
      const repoPath = `${rootPath}/part-${index}.bin`;
      return {
        type: 'file',
        name: `part-${index}.bin`,
        path: repoPath,
        download_url: `${RAW_BASE}/${repoPath}`,
      };
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === `${API_BASE}/commits/main`) return commitResponse();
      if (url === contentsUrl) return jsonAt(contentsUrl, entries);
      return responseAt(url, new Uint8Array(4 * 1024 * 1024));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await installCatalogItem({ kind: 'skill', slug: 'coding' });

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/total byte limit/i);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'coding'))).toBe(
      false,
    );
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).startsWith('https://raw.githubusercontent.com/'),
      ),
    ).toHaveLength(8);
  });

  it('removes private staging and leaves no partial skill after a download fails', async () => {
    const rootPath = 'cli-tool/components/skills/coding';
    const contentsUrl = `${API_BASE}/contents/${rootPath}?ref=${COMMIT_SHA}`;
    const firstUrl = `${RAW_BASE}/${rootPath}/SKILL.md`;
    const secondUrl = `${RAW_BASE}/${rootPath}/notes.md`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(commitResponse())
        .mockResolvedValueOnce(
          jsonAt(contentsUrl, [
            {
              type: 'file',
              name: 'SKILL.md',
              path: `${rootPath}/SKILL.md`,
              download_url: firstUrl,
            },
            {
              type: 'file',
              name: 'notes.md',
              path: `${rootPath}/notes.md`,
              download_url: secondUrl,
            },
          ]),
        )
        .mockResolvedValueOnce(responseAt(firstUrl, '# Coding\n'))
        .mockResolvedValueOnce(
          responseAt(secondUrl, 'upstream failed', { status: 503 }),
        ),
    );

    const result = await installCatalogItem({ kind: 'skill', slug: 'coding' });

    expect(result).toMatchObject({ ok: false });
    const skillsParent = path.join(home, '.claude', 'skills');
    expect(fs.existsSync(path.join(skillsParent, 'coding'))).toBe(false);
    expect(
      fs.existsSync(skillsParent)
        ? fs
            .readdirSync(skillsParent)
            .filter((name) => name.includes('.staging-'))
        : [],
    ).toEqual([]);
  });
});
