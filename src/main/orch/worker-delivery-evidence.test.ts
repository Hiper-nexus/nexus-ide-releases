import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectFilesModifiedSince,
  listDirtyPathsUnderCwd,
  listMtimePathsSince,
  snapshotWorkerDeliveryBaseline,
} from './worker-delivery-evidence';

let repo = '';

function git(args: string): void {
  execSync(`git ${args}`, { cwd: repo, stdio: 'pipe' });
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-files-modified-'));
  git('init -b main');
  git('config user.email test@nexus.dev');
  git('config user.name Test');
  fs.writeFileSync(path.join(repo, 'README.md'), '# seed\n');
  git('add README.md');
  git('commit -m seed');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('collectFilesModifiedSince', () => {
  it('cwd limpo depois do snapshot → 0 files-modified', () => {
    const baseline = snapshotWorkerDeliveryBaseline(repo);
    expect(listDirtyPathsUnderCwd(repo)).toEqual([]);
    expect(collectFilesModifiedSince(repo, baseline)).toEqual([]);
  });

  it('arquivo novo no disco depois do snapshot conta como entrega', () => {
    const baseline = snapshotWorkerDeliveryBaseline(repo);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'waitlist.ts'), 'export const n = 1;\n');
    expect(collectFilesModifiedSince(repo, baseline)).toEqual(['src/waitlist.ts']);
  });

  it('commit desde o HEAD do spawn também conta', () => {
    const baseline = snapshotWorkerDeliveryBaseline(repo);
    fs.writeFileSync(path.join(repo, 'auth.ts'), 'export {}\n');
    git('add auth.ts');
    git('commit -m auth');
    expect(collectFilesModifiedSince(repo, baseline)).toEqual(['auth.ts']);
  });

  it('WIP já sujo no spawn não é entrega deste worker', () => {
    fs.writeFileSync(path.join(repo, 'alien.ts'), 'export {}\n');
    const baseline = snapshotWorkerDeliveryBaseline(repo);
    expect(baseline.dirtyPaths).toEqual(['alien.ts']);
    expect(collectFilesModifiedSince(repo, baseline)).toEqual([]);
  });

  it('ficheiro gitignored com mtime depois do snapshot conta como entrega', () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), '*.local\n');
    git('add .gitignore');
    git('commit -m ignore');
    const baseline = snapshotWorkerDeliveryBaseline(repo);
    const ignored = path.join(repo, 'secret.local');
    fs.writeFileSync(ignored, 'payload\n');
    const later = new Date(baseline.observedAt + 5_000);
    fs.utimesSync(ignored, later, later);
    expect(listDirtyPathsUnderCwd(repo)).toEqual([]);
    expect(listMtimePathsSince(repo, baseline.observedAt)).toEqual(['secret.local']);
    expect(collectFilesModifiedSince(repo, baseline)).toEqual(['secret.local']);
  });
});
