import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCatalogIndex, installCatalogItem } from './catalog';

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
