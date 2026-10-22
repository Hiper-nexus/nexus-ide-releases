import { describe, expect, it } from 'vitest';
import { codexExplicitProviderArgs, resolveCodexStartupPolicy } from './codex-startup-policy';
import { buildControlArgs } from '../adapters/control-args';
import { cliPtyAdapterSchema } from '../../shared/adapter-types';
import codexRaw from '../../adapters/builtin/codex.json';
import type { CodexStartupPolicy } from './cli-mcp-session-types';

const policy: CodexStartupPolicy = {
  projectTrust: { cwdRealPath: '/opened/project', workspaceRootRealPath: '/opened/project', basis: 'opened-workspace' },
  daybreak: 'suppress-unrequested',
};
const launch = { isFrictionless: true, cliVersion: '0.163.0', model: 'gpt-6-sol', resume: false, explicitArgs: [] as string[] };

describe('F-1643/F-1644 Main-generated control prefix provenance', () => {
  const generated = buildControlArgs(cliPtyAdapterSchema.parse(codexRaw), {});

  it('keeps startup policy for real default controls with an exact Main prefix', () => {
    expect(generated).toEqual(['--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort=medium']);
    const actual = [...generated];
    const explicitArgs = codexExplicitProviderArgs(actual, generated);
    expect(explicitArgs).toEqual([]);
    expect(resolveCodexStartupPolicy(policy, { ...launch, explicitArgs })).toEqual(policy);
    expect(actual).toEqual(generated); // Classification never edits executed argv.
  });

  it.each([
    ['-c', 'features.cli_daybreak=true'], ['--profile', 'security'],
    ['-c', 'model_reasoning_effort=medium'], ['--config', 'projects."/opened/project".trust_level="untrusted"'],
  ])('retains explicit config/downstream arguments %j after the certified prefix', (...tail) => {
    const explicitArgs = codexExplicitProviderArgs([...generated, ...tail], generated);
    expect(explicitArgs).toEqual(tail);
    expect(resolveCodexStartupPolicy(policy, { ...launch, explicitArgs })).toBeUndefined();
  });

  it.each([
    { label: 'absent', proof: undefined }, { label: 'empty', proof: [] },
    { label: 'different effort', proof: [...generated.slice(0, -1), 'model_reasoning_effort=high'] },
    { label: 'longer', proof: [...generated, '--profile'] },
    { label: 'suffix only', proof: generated.slice(1) },
  ])('keeps every argument explicit when provenance is $label', ({ proof }) => {
    const explicitArgs = codexExplicitProviderArgs(generated, proof);
    expect(explicitArgs).toEqual(generated);
    expect(resolveCodexStartupPolicy(policy, { ...launch, explicitArgs })).toBeUndefined();
  });

  it('does not search for a matching prefix later in argv or discard duplicate user controls', () => {
    const prepended = ['--profile', 'user', ...generated];
    expect(codexExplicitProviderArgs(prepended, generated)).toEqual(prepended);
    expect(codexExplicitProviderArgs([...generated, ...generated], generated)).toEqual(generated);
    const truncated = generated.slice(0, -1);
    expect(codexExplicitProviderArgs(truncated, generated)).toEqual(truncated);
  });
});

describe('F-1644 launch capability and explicit preference gates', () => {
  it('allows only the measured 0.163.0 ordinary launch to suppress the unsolicited feature', () => {
    expect(resolveCodexStartupPolicy(policy, launch)?.daybreak).toBe('suppress-unrequested');
  });
  it.each([null, '0.162.0', '0.164.0', 'unknown'])('preserves unqualified CLI %s', cliVersion => {
    expect(resolveCodexStartupPolicy(policy, { ...launch, cliVersion })?.daybreak).toBe('preserve');
  });
  it('preserves resumes whose per-thread Daybreak preference is unknown', () => {
    expect(resolveCodexStartupPolicy(policy, { ...launch, resume: true })?.daybreak).toBe('preserve');
  });
  it('preserves explicitly selected Daybreak and Cyber models', () => {
    for (const model of ['gpt-daybreak-blue-latest', 'gpt-daybreak-red-latest', 'gpt-5.6-cyber']) {
      expect(resolveCodexStartupPolicy(policy, { ...launch, model })?.daybreak).toBe('preserve');
    }
  });
  it.each([
    ['--enable', 'cli_daybreak'], ['--disable=cli_daybreak'],
    ['-c', 'daybreak=true'], ['--config=features.cli_daybreak=true'], ['-cdaybreak=true'],
    ['-p', 'security'], ['-psecurity'], ['--profile=security'],
    ['--model=gpt-daybreak-blue-latest'], ['--cyber-access-program', 'daybreak_blue'],
    ['-C', '/other'], ['--cd=/other'], ['--worktree'], ['resume', 'thread-id'], ['fork'],
  ])('leaves explicit argv %j in charge of config precedence', (...explicitArgs) => {
    expect(resolveCodexStartupPolicy(policy, { ...launch, explicitArgs })).toBeUndefined();
  });
  it('never projects policy into Hardened or creates missing Main authority', () => {
    expect(resolveCodexStartupPolicy(policy, { ...launch, isFrictionless: false })).toBeUndefined();
    expect(resolveCodexStartupPolicy(undefined, launch)).toBeUndefined();
  });
  it('never converts preserve intent to suppression', () => {
    expect(resolveCodexStartupPolicy({ ...policy, daybreak: 'preserve' }, launch)?.daybreak).toBe('preserve');
  });
});
