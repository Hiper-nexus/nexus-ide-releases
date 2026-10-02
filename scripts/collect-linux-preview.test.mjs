import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectLinuxPreview, PREVIEW_SCHEMA, PREVIEW_RECEIPT, PREVIEW_CHECKSUMS } from './collect-linux-preview.mjs';
import { assertLinuxReceipt } from './publish-linux-release.mjs';

const roots = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-linux-preview-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  for (const [relative, name] of [
    ['deb/x64', 'nexus-ide_1.2.3_amd64.deb'], ['rpm/x64', 'nexus-ide-1.2.3-1.x86_64.rpm'], ['zip/linux/x64', 'NexusIDE-linux-x64-1.2.3.zip'],
  ]) {
    const folder = path.join(root, 'out', 'make', relative);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, name), `${name}-bytes`);
  }
  const environment = { GITHUB_SHA: 'a'.repeat(40), GITHUB_EVENT_NAME: 'pull_request', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
  return { app: root, out: path.join(root, 'artifacts'), environment, git: () => environment.GITHUB_SHA, npmVersion: () => '12.0.0' };
}
describe('Linux preview artifact authority', () => {
  it('records exact source, three payload digests and explicit non-publicable eligibility', () => {
    const args = fixture();
    const receipt = collectLinuxPreview(args);
    expect(receipt.schema).toBe(PREVIEW_SCHEMA);
    expect(receipt.eligibility).toBe('preview-only');
    expect(receipt.commit).toBe(args.environment.GITHUB_SHA);
    expect(receipt.files).toHaveLength(3);
    expect(fs.readdirSync(args.out)).toHaveLength(5);
    expect(fs.existsSync(path.join(args.out, PREVIEW_RECEIPT))).toBe(true);
    expect(fs.readFileSync(path.join(args.out, PREVIEW_CHECKSUMS), 'utf8')).toContain('NexusIDE-linux-x64-1.2.3.zip');
    expect(() => assertLinuxReceipt(receipt, {})).toThrow();
  });
  it('rejects commit mismatch and release dispatch without creating output', () => {
    const args = fixture();
    expect(() => collectLinuxPreview({ ...args, git: () => 'b'.repeat(40) })).toThrow(/commit/);
    expect(() => collectLinuxPreview({ ...args, environment: { ...args.environment, GITHUB_EVENT_NAME: 'workflow_dispatch' } })).toThrow(/preview/);
    expect(fs.existsSync(args.out)).toBe(false);
  });
  it('rejects missing ZIP and incorrectly versioned generated payload', () => {
    const args = fixture();
    const folder = path.join(args.app, 'out', 'make', 'zip', 'linux', 'x64');
    const zip = path.join(folder, 'NexusIDE-linux-x64-1.2.3.zip');
    fs.unlinkSync(zip);
    expect(() => collectLinuxPreview(args)).toThrow(/inventory/);
    fs.writeFileSync(path.join(folder, 'NexusIDE-linux-x64-0.0.0.zip'), 'wrong');
    expect(() => collectLinuxPreview(args)).toThrow(/inventory/);
  });
});
