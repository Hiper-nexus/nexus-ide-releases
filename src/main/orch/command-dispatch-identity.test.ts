import { afterEach, expect, it } from 'vitest';
import { bindTokenToSession, mintToken, resetGateForTests } from './gate';
import { captureCommandDispatchIdentity } from './command-dispatch-identity';
import { testProjectScope } from './__tests__/scope-fixture';
afterEach(resetGateForTests);
it('keeps explicit key stable while full immutable args/tool/context binding changes',()=>{
  const ctx=mintToken({label:'identity',role:'user',scope:testProjectScope(),allowedTools:null,allowedSkills:null});bindTokenToSession(ctx.token,'physical-identity');
  const first=captureCommandDispatchIdentity('http-mcp',ctx,'file_write',{path:'a',nested:{value:'first'}},'explicit');
  const changed=captureCommandDispatchIdentity('http-mcp',ctx,'terminal_run',{command:'true'},'explicit');
  expect(first.commandId).toBe(changed.commandId);expect(first.bindingDigest).not.toBe(changed.bindingDigest);
  expect(Object.isFrozen(first.args)).toBe(true);expect(Object.isFrozen(first.args.nested)).toBe(true);
});
it('does not enable explicit dedupe for renderer/voice or unbound sessions',()=>{
  const ctx=mintToken({label:'identity',role:'user',scope:testProjectScope(),allowedTools:null,allowedSkills:null});
  expect(()=>captureCommandDispatchIdentity('http-mcp',ctx,'file_write',{},'explicit')).toThrow('command_operation_identity_unsupported');
  expect(()=>captureCommandDispatchIdentity('ipc-renderer',ctx,'file_write',{},'explicit')).toThrow('command_operation_identity_unsupported');
});
