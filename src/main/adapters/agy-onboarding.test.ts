import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareCheckoutProviderHome } from './managed-credentials';
import { AGY_CONSENT_MAX_BYTES, AgyOnboardingPendingError, assertNoKnownAgyOnboardingBlock, requiresAgyOnboardingProof } from './agy-onboarding';

const roots: string[] = [];
const stateFile = 'antigravity-cli/cache/onboarding.json';
const settingsFile = 'antigravity-cli/settings.json';
const complete = { onboardingComplete: true, consumerOnboardingComplete: true, enterpriseOnboardingComplete: false };
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agy-onboarding-')));
  roots.push(root);
  const sourceHome = path.join(root, 'selected-account');
  fs.mkdirSync(sourceHome);
  const options = { sourceHome, userDataPath: path.join(root, 'userData'), checkoutId: 'fixture-checkout' };
  return { root, sourceHome, options };
}
function write(root: string, relative: string, value: unknown) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}
const json = (root: string, relative: string) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const automatic = { source: 'pending', context: { role: 'worker', missionId: 'fixture-mission', allowedTools: null, allowedSkills: null } } as const;
const operator = { source: 'direct-user', context: null } as const;

describe('F-1643: real AGY checkout preparation', () => {
  it('projects only a completed onboarding record from the selected source, without conversations or other cache', () => {
    const { sourceHome, options } = fixture();
    write(sourceHome, stateFile, complete);
    write(sourceHome, settingsFile, { enableTelemetry: false });
    write(sourceHome, 'antigravity-cli/cache/unrelated.json', { private: 'fixture' });
    write(sourceHome, 'antigravity-cli/conversations/fixture.json', { private: 'fixture' });
    const prepared = prepareCheckoutProviderHome('agy', options);
    const target = prepared.env.GEMINI_CLI_HOME;
    expect(fs.existsSync(path.join(target, stateFile))).toBe(true);
    expect(json(target, stateFile)).toEqual(complete);
    expect(json(target, settingsFile)).toEqual({ enableTelemetry: false });
    expect(fs.existsSync(path.join(target, 'antigravity-cli/cache/unrelated.json'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'antigravity-cli/conversations/fixture.json'))).toBe(false);
    expect(fs.statSync(path.join(target, stateFile)).ino).not.toBe(fs.statSync(path.join(sourceHome, stateFile)).ino);
  });

  it('preserves explicit local opt-out and CLI atomic replacements across reopening', () => {
    const { sourceHome, options } = fixture();
    write(sourceHome, settingsFile, { enableTelemetry: true, showTips: true });
    const first = prepareCheckoutProviderHome('agy', options);
    const target = first.env.GEMINI_CLI_HOME;
    const temp = write(target, 'antigravity-cli/settings-new.json', { enableTelemetry: false, showTips: false });
    fs.renameSync(temp, path.join(target, settingsFile));
    prepareCheckoutProviderHome('agy', options);
    expect(json(target, settingsFile)).toEqual({ enableTelemetry: false, showTips: false });
    expect(json(sourceHome, settingsFile)).toEqual({ enableTelemetry: true, showTips: true });
  });

  it('keeps source/account and checkout boundaries independent', () => {
    const { root, sourceHome, options } = fixture();
    write(sourceHome, stateFile, complete);
    const accountB = path.join(root, 'another-account'); fs.mkdirSync(accountB);
    const a = prepareCheckoutProviderHome('agy', options);
    const b = prepareCheckoutProviderHome('agy', { ...options, sourceHome: accountB });
    const otherCheckout = prepareCheckoutProviderHome('agy', { ...options, checkoutId: 'other-checkout' });
    expect(b.stateHome).not.toBe(a.stateHome);
    expect(otherCheckout.stateHome).not.toBe(a.stateHome);
    expect(fs.existsSync(path.join(b.env.GEMINI_CLI_HOME, stateFile))).toBe(false);
    expect(fs.existsSync(path.join(otherCheckout.env.GEMINI_CLI_HOME, stateFile))).toBe(true);
  });

  it('preserves a proven legacy Windows settings hardlink without modifying it', () => {
    const { sourceHome, options } = fixture();
    const source = write(sourceHome, settingsFile, { enableTelemetry: false });
    write(sourceHome, stateFile, complete);
    const first = prepareCheckoutProviderHome('agy', options);
    const target = path.join(first.env.GEMINI_CLI_HOME, settingsFile);
    fs.unlinkSync(target); fs.linkSync(source, target);
    const reopened = prepareCheckoutProviderHome('agy', options);
    expect(assertNoKnownAgyOnboardingBlock(reopened.env.GEMINI_CLI_HOME, automatic, 'unknown', reopened.sourceHome)).toBe('unknown');
    expect(fs.statSync(target).ino).toBe(fs.statSync(source).ino);
    expect(json(sourceHome, settingsFile)).toEqual({ enableTelemetry: false });
  });

  it('the real prepare-to-preflight pipeline permits completed consumer onboarding with opt-out intact', () => {
    const { sourceHome, options } = fixture();
    write(sourceHome, stateFile, complete);
    write(sourceHome, settingsFile, { enableTelemetry: false });
    const prepared = prepareCheckoutProviderHome('agy', options);
    expect(assertNoKnownAgyOnboardingBlock(prepared.env.GEMINI_CLI_HOME, automatic, 'consumer')).toBe('complete');
    expect(() => assertNoKnownAgyOnboardingBlock(prepared.env.GEMINI_CLI_HOME, automatic, 'enterprise')).toThrow(AgyOnboardingPendingError);
    expect(assertNoKnownAgyOnboardingBlock(prepared.env.GEMINI_CLI_HOME, automatic)).toBe('unknown');
    expect(json(prepared.env.GEMINI_CLI_HOME, settingsFile).enableTelemetry).toBe(false);
  });

  it.each([
    ['missing', null], ['false', { onboardingComplete: false, consumerOnboardingComplete: false }],
    ['wrong-type', { onboardingComplete: 'true' }], ['telemetry-only', { enableTelemetry: true }],
  ])('never fabricates completion for %s source state; operator still opens normally', (_name, sourceState) => {
    const { sourceHome, options } = fixture();
    if (sourceState !== null) write(sourceHome, stateFile, sourceState);
    const prepared = prepareCheckoutProviderHome('agy', options);
    expect(fs.existsSync(path.join(prepared.env.GEMINI_CLI_HOME, stateFile))).toBe(sourceState !== null);
    if (sourceState !== null) expect(json(prepared.env.GEMINI_CLI_HOME, stateFile)).toEqual(sourceState);
    expect(() => assertNoKnownAgyOnboardingBlock(prepared.env.GEMINI_CLI_HOME, automatic, 'consumer')).toThrowError(/onboarding_pending:/);
    expect(() => assertNoKnownAgyOnboardingBlock(prepared.env.GEMINI_CLI_HOME, operator, 'consumer')).not.toThrow();
  });

  it('preserves corrupt source cache as evidence instead of omitting it or repairing consent', () => {
    const { sourceHome, options } = fixture();
    const file = write(sourceHome, stateFile, complete);
    fs.writeFileSync(file, '{invalid');
    const prepared = prepareCheckoutProviderHome('agy', options);
    expect(fs.readFileSync(path.join(prepared.env.GEMINI_CLI_HOME, stateFile), 'utf8')).toBe('{invalid');
    expect(() => assertNoKnownAgyOnboardingBlock(prepared.env.GEMINI_CLI_HOME, automatic, 'consumer')).toThrow(AgyOnboardingPendingError);
  });

  it('refuses oversized source cache rather than omitting authoritative evidence', () => {
    const { sourceHome, options } = fixture();
    write(sourceHome, stateFile, { ...complete, padding: 'x'.repeat(AGY_CONSENT_MAX_BYTES) });
    expect(() => prepareCheckoutProviderHome('agy', options)).toThrow(AgyOnboardingPendingError);
  });

  it('does not overwrite corrupt local acknowledgement with source completion', () => {
    const { sourceHome, options } = fixture();
    write(sourceHome, stateFile, complete);
    const prepared = prepareCheckoutProviderHome('agy', options);
    const target = prepared.env.GEMINI_CLI_HOME;
    fs.writeFileSync(path.join(target, stateFile), '{local-corrupt');
    prepareCheckoutProviderHome('agy', options);
    expect(fs.readFileSync(path.join(target, stateFile), 'utf8')).toBe('{local-corrupt');
    expect(() => assertNoKnownAgyOnboardingBlock(target, operator, 'consumer')).not.toThrow();
  });

  it('keeps a completion written atomically by the local CLI when the source has no acknowledgement', () => {
    const { options } = fixture();
    const prepared = prepareCheckoutProviderHome('agy', options);
    const target = prepared.env.GEMINI_CLI_HOME;
    write(target, stateFile, { onboardingComplete: false });
    const tmp = write(target, 'antigravity-cli/cache/onboarding-new.json', complete);
    fs.renameSync(tmp, path.join(target, stateFile));
    prepareCheckoutProviderHome('agy', options);
    expect(() => assertNoKnownAgyOnboardingBlock(target, automatic, 'consumer')).not.toThrow();
  });

  it('does not infer enterprise consent from the legacy/general flag', () => {
    const { sourceHome, options } = fixture();
    write(sourceHome, stateFile, { onboardingComplete: true });
    const prepared = prepareCheckoutProviderHome('agy', options);
    expect(() => assertNoKnownAgyOnboardingBlock(prepared.env.GEMINI_CLI_HOME, automatic, 'enterprise')).toThrow(AgyOnboardingPendingError);
  });

  it.each([
    { onboardingComplete: true },
    { consumerOnboardingComplete: true, enterpriseOnboardingComplete: false },
    { consumerOnboardingComplete: false, enterpriseOnboardingComplete: true },
    { consumerOnboardingComplete: true, enterpriseOnboardingComplete: true },
  ])('leaves backend selection to the CLI without claiming readiness for an unknown flow: %j', record => {
    const { sourceHome, options } = fixture();
    write(sourceHome, stateFile, record);
    const prepared = prepareCheckoutProviderHome('agy', options);
    expect(assertNoKnownAgyOnboardingBlock(prepared.env.GEMINI_CLI_HOME, automatic)).toBe('unknown');
    expect(json(prepared.env.GEMINI_CLI_HOME, stateFile)).toEqual(record);
  });

  it('uses completed legacy CLI settings only when the cache record is absent', () => {
    const { sourceHome, options } = fixture();
    write(sourceHome, settingsFile, { onboardingComplete: true, enableTelemetry: false });
    const prepared = prepareCheckoutProviderHome('agy', options);
    const target = prepared.env.GEMINI_CLI_HOME;
    expect(assertNoKnownAgyOnboardingBlock(target, automatic)).toBe('unknown');
    expect(assertNoKnownAgyOnboardingBlock(target, automatic, 'consumer')).toBe('complete');
    write(target, stateFile, { onboardingComplete: false, consumerOnboardingComplete: false, enterpriseOnboardingComplete: false });
    expect(() => assertNoKnownAgyOnboardingBlock(target, automatic)).toThrow(AgyOnboardingPendingError);
  });

  it.each([
    ['all-false', '{"onboardingComplete":false,"consumerOnboardingComplete":false,"enterpriseOnboardingComplete":false}'],
    ['corrupt', '{"onboardingComplete":false,'],
  ])('preserves authoritative %s source cache over completed legacy settings in the real pipeline', (_kind, raw) => {
    const { sourceHome, options } = fixture();
    const settings = { onboardingComplete: true, enableTelemetry: false };
    write(sourceHome, settingsFile, settings);
    const source = write(sourceHome, stateFile, {});
    fs.writeFileSync(source, raw);
    const prepared = prepareCheckoutProviderHome('agy', options);
    const target = prepared.env.GEMINI_CLI_HOME;
    expect(() => assertNoKnownAgyOnboardingBlock(target, automatic, 'unknown', prepared.sourceHome)).toThrow(AgyOnboardingPendingError);
    expect(fs.readFileSync(path.join(target, stateFile), 'utf8')).toBe(raw);
    expect(fs.readFileSync(source, 'utf8')).toBe(raw);
    expect(json(target, settingsFile)).toEqual(settings);
    expect(json(sourceHome, settingsFile)).toEqual(settings);
    expect(() => assertNoKnownAgyOnboardingBlock(target, operator, 'unknown', prepared.sourceHome)).not.toThrow();
  });

  it.each(['oversized', 'symlink'])('refuses an unprojectable %s source cache instead of allowing completed legacy fallback', kind => {
    const { root, sourceHome, options } = fixture();
    write(sourceHome, settingsFile, { onboardingComplete: true, enableTelemetry: false });
    if (kind === 'oversized') write(sourceHome, stateFile, { padding: 'x'.repeat(AGY_CONSENT_MAX_BYTES) });
    else {
      const elsewhere = write(root, 'other-account/onboarding.json', complete);
      fs.mkdirSync(path.join(sourceHome, 'antigravity-cli/cache'), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(sourceHome, stateFile), 'file');
    }
    expect(() => prepareCheckoutProviderHome('agy', options)).toThrow(AgyOnboardingPendingError);
    expect(json(sourceHome, settingsFile)).toEqual({ onboardingComplete: true, enableTelemetry: false });
  });

  it('heals all-false checkout progress from the exact source record without replacing local opt-out', () => {
    const { sourceHome, options } = fixture();
    const prepared = prepareCheckoutProviderHome('agy', options);
    const target = prepared.env.GEMINI_CLI_HOME;
    write(target, stateFile, { onboardingComplete: false, consumerOnboardingComplete: false, enterpriseOnboardingComplete: false });
    write(target, settingsFile, { enableTelemetry: false, showTips: false });
    write(sourceHome, settingsFile, { enableTelemetry: true, showTips: true });
    const source = write(sourceHome, stateFile, complete);
    const before = fs.statSync(path.join(target, stateFile));
    prepareCheckoutProviderHome('agy', options);
    expect(json(target, settingsFile)).toEqual({ enableTelemetry: false, showTips: false });
    expect(fs.readFileSync(path.join(target, stateFile), 'utf8')).toBe(fs.readFileSync(source, 'utf8'));
    expect(fs.statSync(path.join(target, stateFile)).ino).toBe(before.ino);
    expect(assertNoKnownAgyOnboardingBlock(target, automatic)).toBe('unknown');
  });

  it('leaves a CLI pathname replacement intact when it occurs at the healing FD write', () => {
    const { sourceHome, options } = fixture();
    const prepared = prepareCheckoutProviderHome('agy', options);
    const targetHome = prepared.env.GEMINI_CLI_HOME;
    const target = write(targetHome, stateFile, { onboardingComplete: false, consumerOnboardingComplete: false, enterpriseOnboardingComplete: false });
    write(targetHome, settingsFile, { enableTelemetry: false });
    write(sourceHome, stateFile, complete);
    const newChoice = { onboardingComplete: false, consumerOnboardingComplete: false, enterpriseOnboardingComplete: true };
    const replacement = write(targetHome, 'antigravity-cli/cache/cli-new.json', newChoice);
    const replacementInode = fs.statSync(replacement).ino;
    const writeFd = fs.writeSync;
    let replacementError: string | undefined;
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(((...args: Parameters<typeof fs.writeSync>) => {
      try {
        // Windows MoveFileEx cannot replace an open destination (EPERM).
        // Move the open inode aside, then install the CLI's new pathname.
        fs.renameSync(target, path.join(targetHome, 'antigravity-cli/cache/old-open.json'));
        fs.renameSync(replacement, target);
      }
      catch (error) { replacementError = (error as NodeJS.ErrnoException).code; throw error; }
      return Reflect.apply(writeFd, fs, args);
    }) as typeof fs.writeSync);
    expect(() => prepareCheckoutProviderHome('agy', options)).toThrow(AgyOnboardingPendingError);
    expect(replacementError).toBeUndefined();
    expect(json(targetHome, stateFile)).toEqual(newChoice);
    expect(fs.statSync(target).ino).toBe(replacementInode);
    expect(json(targetHome, settingsFile)).toEqual({ enableTelemetry: false });
  });

  it.each([
    { onboardingComplete: true, consumerOnboardingComplete: false, enterpriseOnboardingComplete: false },
    { onboardingComplete: false, consumerOnboardingComplete: false, enterpriseOnboardingComplete: false, divergent: true },
    { onboardingComplete: 'false', consumerOnboardingComplete: false, enterpriseOnboardingComplete: false },
  ])('does not heal completed or divergent local cache: %j', local => {
    const { sourceHome, options } = fixture();
    const prepared = prepareCheckoutProviderHome('agy', options);
    write(prepared.env.GEMINI_CLI_HOME, stateFile, local);
    write(sourceHome, stateFile, complete);
    prepareCheckoutProviderHome('agy', options);
    expect(json(prepared.env.GEMINI_CLI_HOME, stateFile)).toEqual(local);
  });

  it('never heals a hardlinked cache, even when the link points to the selected source', () => {
    const { sourceHome, options } = fixture();
    const prepared = prepareCheckoutProviderHome('agy', options);
    const source = write(sourceHome, stateFile, { onboardingComplete: false, consumerOnboardingComplete: false, enterpriseOnboardingComplete: false });
    fs.linkSync(source, path.join(prepared.env.GEMINI_CLI_HOME, stateFile));
    expect(() => prepareCheckoutProviderHome('agy', options)).toThrow(AgyOnboardingPendingError);
    expect(json(sourceHome, stateFile).onboardingComplete).toBe(false);
  });

  it('copies exact longer source bytes through the same cache inode, without merging flags', () => {
    const { sourceHome, options } = fixture();
    const prepared = prepareCheckoutProviderHome('agy', options);
    const target = write(prepared.env.GEMINI_CLI_HOME, stateFile, { onboardingComplete: false, consumerOnboardingComplete: false, enterpriseOnboardingComplete: false });
    const inode = fs.statSync(target).ino;
    const source = write(sourceHome, stateFile, complete);
    const raw = '  ' + JSON.stringify({ ...complete, note: 'ação da CLI — fixture' }) + '\n';
    fs.writeFileSync(source, raw);
    prepareCheckoutProviderHome('agy', options);
    expect(fs.readFileSync(target)).toEqual(Buffer.from(raw));
    expect(fs.readFileSync(source)).toEqual(Buffer.from(raw));
    expect(fs.statSync(target).ino).toBe(inode);
  });

  it.each(['in-place-change', 'new-hardlink', 'source-change'])('refuses a %s observed when the repair FD is opened', divergence => {
    const { sourceHome, options } = fixture();
    const prepared = prepareCheckoutProviderHome('agy', options);
    const targetHome = prepared.env.GEMINI_CLI_HOME;
    const pending = { onboardingComplete: false, consumerOnboardingComplete: false, enterpriseOnboardingComplete: false };
    const target = write(targetHome, stateFile, pending);
    const source = write(sourceHome, stateFile, complete);
    const next = { ...pending, enterpriseOnboardingComplete: true };
    const open = fs.openSync;
    let injected = false;
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (!injected && args[0] === target && typeof args[1] === 'number' && (args[1] & fs.constants.O_RDWR) !== 0) {
        injected = true;
        if (divergence === 'in-place-change') fs.writeFileSync(target, JSON.stringify(next));
        else if (divergence === 'new-hardlink') fs.linkSync(target, path.join(targetHome, 'antigravity-cli/cache/other-link.json'));
        else fs.writeFileSync(source, JSON.stringify(pending));
      }
      return Reflect.apply(open, fs, args);
    });
    expect(() => prepareCheckoutProviderHome('agy', options)).toThrow(AgyOnboardingPendingError);
    expect(json(targetHome, stateFile)).toEqual(divergence === 'in-place-change' ? next : pending);
  });

  it('refuses a settings hardlink whose source was replaced, without rewriting either file', () => {
    const { sourceHome, options } = fixture();
    const source = write(sourceHome, settingsFile, { enableTelemetry: false });
    const prepared = prepareCheckoutProviderHome('agy', options);
    const target = path.join(prepared.env.GEMINI_CLI_HOME, settingsFile);
    fs.unlinkSync(target); fs.linkSync(source, target);
    const sibling = write(sourceHome, 'antigravity-cli/new-settings.json', { enableTelemetry: true });
    fs.renameSync(sibling, source);
    // Keep the stale inode linked elsewhere, so it is not an independent local file.
    fs.linkSync(target, path.join(prepared.env.GEMINI_CLI_HOME, 'antigravity-cli/stale-link.json'));
    expect(() => prepareCheckoutProviderHome('agy', options)).toThrow(AgyOnboardingPendingError);
    expect(json(prepared.env.GEMINI_CLI_HOME, settingsFile)).toEqual({ enableTelemetry: false });
    expect(json(sourceHome, settingsFile)).toEqual({ enableTelemetry: true });
  });

  it('accepts a genuinely completed enterprise record without changing its false consumer flags', () => {
    const { sourceHome, options } = fixture();
    const enterprise = { onboardingComplete: false, consumerOnboardingComplete: false, enterpriseOnboardingComplete: true };
    write(sourceHome, stateFile, enterprise);
    const prepared = prepareCheckoutProviderHome('agy', options);
    expect(json(prepared.env.GEMINI_CLI_HOME, stateFile)).toEqual(enterprise);
    expect(() => assertNoKnownAgyOnboardingBlock(prepared.env.GEMINI_CLI_HOME, automatic, 'enterprise')).not.toThrow();
    expect(() => assertNoKnownAgyOnboardingBlock(prepared.env.GEMINI_CLI_HOME, automatic, 'consumer')).toThrow(AgyOnboardingPendingError);
  });

  it('does not follow a source acknowledgement symlink into another account', () => {
    const { root, sourceHome, options } = fixture();
    const prepared = prepareCheckoutProviderHome('agy', options);
    const other = write(root, 'other-account/onboarding.json', complete);
    fs.mkdirSync(path.join(sourceHome, 'antigravity-cli/cache'), { recursive: true });
    fs.symlinkSync(other, path.join(sourceHome, stateFile), 'file');
    expect(() => prepareCheckoutProviderHome('agy', options)).toThrow(AgyOnboardingPendingError);
    expect(() => assertNoKnownAgyOnboardingBlock(prepared.env.GEMINI_CLI_HOME, automatic, 'consumer')).toThrow(AgyOnboardingPendingError);
    expect(fs.existsSync(path.join(prepared.env.GEMINI_CLI_HOME, stateFile))).toBe(false);
  });

  it('rejects a target cache junction before writing outside the checkout profile', () => {
    const { root, sourceHome, options } = fixture();
    const prepared = prepareCheckoutProviderHome('agy', options);
    const cache = path.join(prepared.env.GEMINI_CLI_HOME, 'antigravity-cli/cache');
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    fs.rmdirSync(cache); fs.symlinkSync(outside, cache, 'junction');
    write(sourceHome, stateFile, complete);
    expect(() => prepareCheckoutProviderHome('agy', options)).toThrow(AgyOnboardingPendingError);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(() => assertNoKnownAgyOnboardingBlock(prepared.env.GEMINI_CLI_HOME, automatic, 'consumer')).toThrow(AgyOnboardingPendingError);
  });

  it('preserves a proven legacy settings symlink and accepts the real prepare-preflight pipeline', () => {
    const { sourceHome, options } = fixture();
    const source = write(sourceHome, settingsFile, { enableTelemetry: false });
    write(sourceHome, stateFile, complete);
    const prepared = prepareCheckoutProviderHome('agy', options);
    const target = path.join(prepared.env.GEMINI_CLI_HOME, settingsFile);
    fs.unlinkSync(target); fs.symlinkSync(source, target, 'file');
    const reopened = prepareCheckoutProviderHome('agy', options);
    expect(assertNoKnownAgyOnboardingBlock(reopened.env.GEMINI_CLI_HOME, automatic, 'unknown', reopened.sourceHome)).toBe('unknown');
    expect(reopened.sharedReadPaths).toContain(source);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(json(prepared.env.GEMINI_CLI_HOME, settingsFile)).toEqual({ enableTelemetry: false });
    expect(fs.statSync(target).ino).toBe(fs.statSync(source).ino);
  });

  it('rejects an unrelated preference symlink without modifying its target', () => {
    const { root, options } = fixture();
    const prepared = prepareCheckoutProviderHome('agy', options);
    const outside = write(root, 'other-account/settings.json', { enableTelemetry: false });
    fs.symlinkSync(outside, path.join(prepared.env.GEMINI_CLI_HOME, settingsFile), 'file');
    expect(() => prepareCheckoutProviderHome('agy', options)).toThrow(AgyOnboardingPendingError);
    expect(json(root, 'other-account/settings.json')).toEqual({ enableTelemetry: false });
  });

  it('preserves an old settings hardlink without reaching publication or changing either file', () => {
    const { sourceHome, options } = fixture();
    const source = write(sourceHome, settingsFile, { enableTelemetry: true });
    const prepared = prepareCheckoutProviderHome('agy', options);
    const targetHome = prepared.env.GEMINI_CLI_HOME;
    const target = path.join(targetHome, settingsFile);
    fs.unlinkSync(target); fs.linkSync(source, target);
    const replacement = write(targetHome, 'antigravity-cli/local-replacement.json', { enableTelemetry: false });
    const fsync = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(fd => { fsync(fd); fs.renameSync(replacement, target); });
    expect(() => prepareCheckoutProviderHome('agy', options)).not.toThrow();
    expect(json(targetHome, settingsFile)).toEqual({ enableTelemetry: true });
    expect(JSON.parse(fs.readFileSync(replacement, 'utf8'))).toEqual({ enableTelemetry: false });
  });

  it('does not rename a legacy settings link or consume an independent CLI replacement', () => {
    const { sourceHome, options } = fixture();
    const source = write(sourceHome, settingsFile, { enableTelemetry: true });
    const prepared = prepareCheckoutProviderHome('agy', options);
    const targetHome = prepared.env.GEMINI_CLI_HOME;
    const target = path.join(targetHome, settingsFile);
    fs.unlinkSync(target); fs.linkSync(source, target);
    const replacement = write(targetHome, 'antigravity-cli/local-replacement.json', { enableTelemetry: false });
    const rename = fs.renameSync;
    // Real filesystem interleaving at the last syscall, not during fsync:
    // another process may rename after the helper's last lstat returned.
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((from, to) => {
      rename(replacement, target);
      rename(from, to);
    });
    prepareCheckoutProviderHome('agy', options);
    expect(fs.statSync(target).ino).toBe(fs.statSync(source).ino);
    expect(json(targetHome, settingsFile)).toEqual({ enableTelemetry: true });
    expect(JSON.parse(fs.readFileSync(replacement, 'utf8'))).toEqual({ enableTelemetry: false });
  });

  it('refuses an oversized source preference rather than dropping opt-out and carrying completion', () => {
    const { sourceHome, options } = fixture();
    write(sourceHome, stateFile, complete);
    write(sourceHome, settingsFile, { enableTelemetry: false, padding: 'x'.repeat(AGY_CONSENT_MAX_BYTES) });
    expect(() => prepareCheckoutProviderHome('agy', options)).toThrow(AgyOnboardingPendingError);
  });

  it('preserves corrupt local preferences and refuses automatic launch instead of assuming defaults', () => {
    const { sourceHome, options } = fixture();
    write(sourceHome, stateFile, complete);
    const prepared = prepareCheckoutProviderHome('agy', options);
    const target = prepared.env.GEMINI_CLI_HOME;
    const file = write(target, settingsFile, { enableTelemetry: false });
    fs.writeFileSync(file, '{local-choice-truncated');
    prepareCheckoutProviderHome('agy', options);
    expect(fs.readFileSync(file, 'utf8')).toBe('{local-choice-truncated');
    expect(() => assertNoKnownAgyOnboardingBlock(target, automatic, 'consumer')).toThrow(AgyOnboardingPendingError);
    expect(() => assertNoKnownAgyOnboardingBlock(target, operator, 'consumer')).not.toThrow();
  });

  it('still relinks changed synthetic auth while leaving independent local consent alone', () => {
    const { sourceHome, options } = fixture();
    write(sourceHome, 'oauth_creds.json', { access_token: 'fixture-old' });
    write(sourceHome, settingsFile, { enableTelemetry: true });
    const prepared = prepareCheckoutProviderHome('agy', options);
    write(prepared.env.GEMINI_CLI_HOME, settingsFile, { enableTelemetry: false });
    const replacement = write(sourceHome, 'replacement.json', { access_token: 'fixture-new' });
    fs.renameSync(replacement, path.join(sourceHome, 'oauth_creds.json'));
    prepareCheckoutProviderHome('agy', options);
    expect(json(prepared.env.GEMINI_CLI_HOME, 'oauth_creds.json')).toEqual({ access_token: 'fixture-new' });
    expect(json(prepared.env.GEMINI_CLI_HOME, settingsFile)).toEqual({ enableTelemetry: false });
  });
});

describe('F-1643: Main authority preflight contract', () => {
  it('does not rely only on requiresSpawnGate for a worker with null allowlists', () => {
    expect(requiresAgyOnboardingProof(automatic)).toBe(true);
  });
  it('preserves direct and explicitly operator-opened human onboarding', () => {
    expect(requiresAgyOnboardingProof(operator)).toBe(false);
    expect(requiresAgyOnboardingProof({ source: 'persisted-pane', context: { role: 'worker', missionId: 'fixture', operatorOpened: true } })).toBe(false);
  });
  it('requires proof for automated orchestrators and loose operator children', () => {
    expect(requiresAgyOnboardingProof({ source: 'pending', context: { role: 'orchestrator' } })).toBe(true);
    expect(requiresAgyOnboardingProof({ source: 'pending', context: { role: 'user', operatorParentSessionId: 'fixture-parent' } })).toBe(true);
  });
  it('uses a typed non-auth refusal whose code survives message-only spawn acknowledgements', () => {
    const error = new AgyOnboardingPendingError();
    expect(error.code).toBe('onboarding_pending');
    expect(error.message).toMatch(/^onboarding_pending:/);
  });
  it('does not treat an unclassified non-direct authority as an interactive human', () => {
    expect(requiresAgyOnboardingProof({ source: 'pending', context: null })).toBe(true);
    expect(requiresAgyOnboardingProof({ source: 'persisted-pane', context: {} })).toBe(true);
  });
});
