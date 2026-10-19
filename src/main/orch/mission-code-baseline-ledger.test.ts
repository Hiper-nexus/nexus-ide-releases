import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedMissionStore } from './mission-store';
import { testProjectScope } from './__tests__/scope-fixture';
import { captureMissionCodeBaseline } from './mission-code-baseline-ledger';

let root: string;
let repo: string;
let manager: ProjectRuntimeManager;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const scope = () => testProjectScope({ rootRealPath: repo });
const store = () => createScopedMissionStore(manager, scope(), { assertCreateAccess: () => {} });
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-code-baseline-')));
  repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  git('init', '-q'); git('-c', 'user.name=Nexus Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'baseline');
  manager = new ProjectRuntimeManager({ baseDir: path.join(root, 'runtime'), appVersion: 'baseline-test' });
});
afterEach(() => { manager.closeAll(); fs.rmSync(root, { recursive: true, force: true }); });

it('captures HEAD before creation and persists the first Main baseline across reopening', async () => {
  const captured = await captureMissionCodeBaseline(repo, { now: () => 123 });
  expect(captured).toMatchObject({ status: 'known', headSha: git('rev-parse', 'HEAD'), observedAt: 123 });
  const missions = store(); const mission = missions.create({ title: 'code task' });
  const recorded = missions.codeBaseline.record(mission.id, captured);
  expect(missions.codeBaseline.read(mission.id, repo)).toEqual(recorded);
  git('-c', 'user.name=Nexus Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'later');
  expect(missions.codeBaseline.record(mission.id, await captureMissionCodeBaseline(repo))).toEqual(recorded);
  manager.closeAll();
  manager = new ProjectRuntimeManager({ baseDir: path.join(root, 'runtime'), appVersion: 'baseline-test' });
  expect(store().codeBaseline.read(mission.id, repo)).toEqual(recorded);
  const rows = manager.open(scope()).db.prepare("SELECT * FROM mission_events WHERE mission_id = ? AND event_type = 'custom'").all(mission.id);
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain(repo);
});

it('does not modify staged, unstaged or untracked work while capturing HEAD', async () => {
  fs.writeFileSync(path.join(repo, 'staged'), 'staged content'); git('add', 'staged');
  fs.writeFileSync(path.join(repo, 'staged'), 'unstaged content'); fs.writeFileSync(path.join(repo, 'loose'), 'untracked content');
  const index = fs.readFileSync(path.join(repo, '.git/index'));
  const before = git('status', '--porcelain=v1');
  const capture = await captureMissionCodeBaseline(repo);
  expect(capture.status).toBe('known'); expect(git('status', '--porcelain=v1')).toBe(before);
  expect(fs.readFileSync(path.join(repo, '.git/index'))).toEqual(index);
  expect(fs.readFileSync(path.join(repo, 'staged'), 'utf8')).toBe('unstaged content');
  expect(fs.readFileSync(path.join(repo, 'loose'), 'utf8')).toBe('untracked content');
});

it('records unknown explicitly and never upgrades it with a later capture', async () => {
  const captured = await captureMissionCodeBaseline(repo, { git: { run: async () => { throw new Error('unavailable'); } } });
  expect(captured).toMatchObject({ status: 'unknown', reason: 'head-unavailable' });
  expect(captured).not.toHaveProperty('headSha');
  const missions = store(); const mission = missions.create({ title: 'unknown baseline' });
  const recorded = missions.codeBaseline.record(mission.id, captured);
  expect(missions.codeBaseline.record(mission.id, await captureMissionCodeBaseline(repo))).toEqual(recorded);
});

it('missing root returns unknown without asking Git to inspect another directory', async () => {
  let called = false;
  const captured = await captureMissionCodeBaseline(path.join(root, 'missing'), { git: { run: async () => { called = true; throw new Error('no'); } } });
  expect(captured).toMatchObject({ status: 'unknown', reason: 'root-unavailable' }); expect(called).toBe(false);
});

it('cannot reuse another execution root or a forged origin', async () => {
  const captured = await captureMissionCodeBaseline(repo);
  const missions = store(); const mission = missions.create({ title: 'bound baseline' });
  missions.codeBaseline.record(mission.id, captured);
  expect(() => missions.codeBaseline.read(mission.id, path.join(root, 'other'))).toThrow(/baseline/);
  const db = manager.open(scope()).db;
  // Existing journal rows are append-only: seed a forged first row in another
  // mission, the same collision an untrusted producer would try to introduce.
  expect(() => db.prepare("UPDATE mission_events SET origin = 'mcp' WHERE mission_id = ?").run(mission.id)).toThrow(/append-only/);
  const forged = missions.create({ title: 'forged origin' });
  db.prepare(`INSERT INTO mission_events SELECT sequence, id || '-forged', ?, run_id, parent_run_id,
    event_type, payload_json, idempotency_key, occurred_at, 'mcp', delivery_status FROM mission_events WHERE mission_id = ?`).run(forged.id, mission.id);
  expect(() => missions.codeBaseline.read(forged.id, repo)).toThrow(/baseline/);
  expect(() => missions.codeBaseline.record(forged.id, captured)).toThrow(/baseline/);
});

it('rejects a copied/agent-authored capture and does not invent a base for legacy missions', async () => {
  const captured = await captureMissionCodeBaseline(repo);
  const missions = store(); const mission = missions.create({ title: 'legacy' });
  expect(missions.codeBaseline.read(mission.id, repo)).toBeNull();
  expect(() => missions.codeBaseline.record(mission.id, { ...captured })).toThrow(/Main|capture/);
  expect(() => missions.codeBaseline.record('missing-mission', captured)).toThrow(/mission/);
});

it('rejects a changed scope binding and malformed payload instead of guessing', async () => {
  const captured = await captureMissionCodeBaseline(repo);
  const missions = store(); const mission = missions.create({ title: 'corruption' });
  missions.codeBaseline.record(mission.id, captured);
  const db = manager.open(scope()).db;
  const row = db.prepare('SELECT payload_json FROM mission_events WHERE mission_id = ?').get(mission.id) as { payload_json: string };
  const payload = JSON.parse(row.payload_json); payload.scopeHash = 'f'.repeat(64);
  for (const [suffix, malformed] of [['scope', JSON.stringify(payload)], ['json', '{']]) {
    const bad = missions.create({ title: suffix });
    db.prepare(`INSERT INTO mission_events SELECT sequence, id || ?, ?, run_id, parent_run_id,
      event_type, ?, idempotency_key, occurred_at, origin, delivery_status FROM mission_events WHERE mission_id = ?`).run('-' + suffix, bad.id, malformed, mission.id);
    expect(() => missions.codeBaseline.read(bad.id, repo)).toThrow(/baseline/);
  }
});

it('invalid HEAD output stays unknown rather than becoming a commit identifier', async () => {
  const captured = await captureMissionCodeBaseline(repo, { git: { run: async (_cwd, args) => args[0] === 'config'
    ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: 'not-a-commit', stderr: '' } } });
  expect(captured).toMatchObject({ status: 'unknown', reason: 'head-unavailable' });
});

it('root replacement during asynchronous capture produces unknown', async () => {
  const sha = git('rev-parse', 'HEAD');
  const captured = await captureMissionCodeBaseline(repo, { git: { run: async (_cwd, args) => {
    if (args[0] === 'config') return { status: 1, stdout: '', stderr: '' };
    fs.renameSync(repo, path.join(root, 'previous-root')); fs.mkdirSync(repo);
    return { status: 0, stdout: sha, stderr: '' };
  } } });
  expect(captured).toMatchObject({ status: 'unknown', reason: 'root-changed' });
});

describe('Main-owned baseline advance', () => {
  const commit = (message: string) => git('-c', 'user.name=Nexus Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', message);
  const captureAs = (headSha: string) => captureMissionCodeBaseline(repo, {
    git: { run: async (_cwd, args) => args[0] === 'config'
      ? { status: 1, stdout: '', stderr: '' }
      : { status: 0, stdout: headSha, stderr: '' } },
  });

  it('advances a Main baseline forward-only along the worktree history and reads the latest', async () => {
    const captured = await captureMissionCodeBaseline(repo);
    const missions = store(); const mission = missions.create({ title: 'advance' });
    missions.codeBaseline.record(mission.id, captured);
    commit('forward');
    const advanced = await missions.codeBaseline.advance(mission.id, repo, await captureMissionCodeBaseline(repo));
    expect(advanced).toMatchObject({ status: 'known', headSha: git('rev-parse', 'HEAD') });
    expect(missions.codeBaseline.read(mission.id, repo)).toEqual(advanced);
    // Re-advancing to the same HEAD is idempotent (returns the existing row).
    expect(await missions.codeBaseline.advance(mission.id, repo, await captureMissionCodeBaseline(repo))).toEqual(advanced);
  });

  it('refuses to advance a baseline backward to an ancestor', async () => {
    const initial = await captureMissionCodeBaseline(repo);
    commit('forward');
    const ahead = await captureMissionCodeBaseline(repo);
    const missions = store(); const mission = missions.create({ title: 'reject-backward' });
    missions.codeBaseline.record(mission.id, ahead);
    await expect(missions.codeBaseline.advance(mission.id, repo, initial)).rejects.toThrow(/descendant/);
  });

  it('refuses to advance to a descendant that is not part of the worktree history', async () => {
    const captured = await captureMissionCodeBaseline(repo);
    const missions = store(); const mission = missions.create({ title: 'reject-unsynced' });
    missions.codeBaseline.record(mission.id, captured);
    commit('forward'); // HEAD = C, descendant of the baseline
    git('checkout', '-qb', 'side', captured.headSha);
    commit('side sibling'); // D: descendant of B, not merged into HEAD
    const sideSha = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-');
    await expect(missions.codeBaseline.advance(mission.id, repo, await captureAs(sideSha))).rejects.toThrow(/worktree to include/);
  });

  it('rejects a copied/agent-authored capture on advance (Main provenance)', async () => {
    const captured = await captureMissionCodeBaseline(repo);
    const missions = store(); const mission = missions.create({ title: 'forged-advance' });
    missions.codeBaseline.record(mission.id, captured);
    await expect(missions.codeBaseline.advance(mission.id, repo, { ...captured })).rejects.toThrow(/Main|capture/);
  });

  it('advance requires an existing known baseline', async () => {
    const captured = await captureMissionCodeBaseline(repo);
    const missions = store(); const mission = missions.create({ title: 'advance-no-baseline' });
    await expect(missions.codeBaseline.advance(mission.id, repo, captured)).rejects.toThrow(/existing baseline/);
  });
});
