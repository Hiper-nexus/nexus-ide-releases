import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureAuditLogRuntime, disposeAuditLogRuntime } from '../jarvis/audit-log';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { mintToken, bindTokenToSession, releaseSessionByToken, resetGateForTests } from './gate';
import { dispatchToolCall } from './mcp-dispatch';
import { handleMcpMessage, type McpRegistry } from './mcp-protocol';
import { configureProjectDomainStoreRegistry, disposeProjectDomainStoreRegistry } from './project-domain-store-registry';
import { testProjectScope } from './__tests__/scope-fixture';

let root:string;
let manager:ProjectRuntimeManager;
let scope:ReturnType<typeof testProjectScope>;
beforeEach(()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-command-identity-'));
  manager=new ProjectRuntimeManager({baseDir:root,appVersion:'command-identity-test'});
  scope=testProjectScope({projectId:'command-identity',checkoutId:'command-checkout',rootRealPath:root});
  configureAuditLogRuntime(manager);configureProjectDomainStoreRegistry(manager);resetGateForTests();
});
afterEach(async()=>{
  resetGateForTests();await disposeProjectDomainStoreRegistry();await disposeAuditLogRuntime();manager.closeAll();
  fs.rmSync(root,{recursive:true,force:true});
});
function caller(sessionId:string,executionScope=scope){
  const ctx=mintToken({label:sessionId,role:'user',scope,executionScope,providerId:'codex',allowedTools:null,allowedSkills:null});
  bindTokenToSession(ctx.token,sessionId);return ctx;
}
function registry(handler:McpRegistry['tools'][number]['handler']):McpRegistry {
  return {serverName:'identity-test',serverVersion:'0',tools:[{name:'nexus_file_write',description:'controlled effect sink',inputSchema:{type:'object'},handler}]};
}
const args=(content:string)=>({path:'identity.txt',content});

describe('F-1080: actual RPC correlation and explicit operation identity',()=>{
  it('independent physical callers with the same RPC counter execute distinct operations/worktrees',async()=>{
    const calls:string[]=[];const tools=registry(async(a,c)=>{calls.push(`${c.sessionId}:${a.content}`);return {observed:a.content};});
    const first=caller('physical-a');const second=caller('physical-b',testProjectScope({...scope,rootRealPath:path.join(root,'execution-b')}));
    for(const [ctx,content] of [[first,'one'],[second,'two']] as const){
      await handleMcpMessage(tools,ctx,{jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'nexus_file_write',arguments:args(content)}});
    }
    expect(calls).toEqual(['physical-a:one','physical-b:two']);
  });
  it('a normal counter reused with changed arguments or JSON id type is a fresh operation',async()=>{
    const calls:string[]=[];const tools=registry(async a=>{calls.push(String(a.content));return {observed:a.content};});const ctx=caller('physical-a');
    for(const [id,content] of [[7,'one'],['7','two'],[7,'three']] as const){
      await handleMcpMessage(tools,ctx,{jsonrpc:'2.0',id,method:'tools/call',params:{name:'nexus_file_write',arguments:args(content)}});
    }
    expect(calls).toEqual(['one','two','three']);
  });
  it('explicit same-owner logical ID refuses changed immutable arguments instead of returning another result',async()=>{
    const calls:string[]=[];const tools=registry(async a=>{calls.push(String(a.content));return {observed:a.content};});const ctx=caller('physical-a');
    await dispatchToolCall('http-mcp',tools,'nexus_file_write',args('one'),ctx,{logicalOperationId:'explicit-one'});
    const changed=await dispatchToolCall('http-mcp',tools,'nexus_file_write',args('two'),ctx,{logicalOperationId:'explicit-one'});
    expect(changed).toMatchObject({ok:false,denied:true,error:'command_effect_identity_conflict'});expect(calls).toEqual(['one']);
  });
  it('explicit IDs belong to their physical caller, not a checkout-wide namespace',async()=>{
    const calls:string[]=[];const tools=registry(async(a,c)=>{calls.push(`${c.sessionId}:${a.content}`);return {observed:a.content};});
    for(const [ctx,content] of [[caller('physical-a'),'one'],[caller('physical-b'),'two']] as const){
      await dispatchToolCall('http-mcp',tools,'nexus_file_write',args(content),ctx,{logicalOperationId:'shared-label'});
    }
    expect(calls).toEqual(['physical-a:one','physical-b:two']);
  });
  it('a joining invocation revalidates its own revoked signal after the original finishes',async()=>{
    let release!:()=>void;let entered!:()=>void;
    const hold=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
    const tools=registry(async()=>{entered();await hold;return {privateOutput:'same-owner-original'};});const ctx=caller('physical-a');
    const first=dispatchToolCall('http-mcp',tools,'nexus_file_write',args('one'),ctx,{logicalOperationId:'joined-operation'});
    await started;const revoked=new AbortController();
    const second=dispatchToolCall('http-mcp',tools,'nexus_file_write',args('one'),ctx,{logicalOperationId:'joined-operation',callerSignal:revoked.signal});
    await new Promise(resolve=>setTimeout(resolve,0));
    revoked.abort();release();
    expect(await first).toMatchObject({ok:true});expect(await second).toMatchObject({ok:false,error:'session_authority_revoked'});
  });
});

it('F-1081: actual dispatcher durable replay reports unavailable output without reconstructing sensitive result',async()=>{
  const secret='fixture-transient-output-af92';const ticket='fixture-ephemeral-ticket-db27';
  const tools=registry(async()=>({stdout:secret,stderr:secret,capabilityUrl:`ws://127.0.0.1/cdp/pane?ticket=${ticket}`}));const ctx=caller('physical-safe');
  const first=await dispatchToolCall('http-mcp',tools,'nexus_file_write',args('nonsecret'),ctx,{logicalOperationId:'safe-replay'});
  const replay=await dispatchToolCall('http-mcp',tools,'nexus_file_write',args('nonsecret'),ctx,{logicalOperationId:'safe-replay'});
  expect(first).toMatchObject({ok:true,result:{stdout:secret}});
  expect(replay).toMatchObject({ok:false,error:'command_result_unavailable',effectMayHaveCommitted:true});
  expect(JSON.stringify(replay)).not.toContain(secret);expect(JSON.stringify(replay)).not.toContain(ticket);
  const rows=manager.open(scope).db.prepare('SELECT outcome_json FROM command_receipts').all();
  expect(JSON.stringify(rows)).not.toContain(secret);expect(JSON.stringify(rows)).not.toContain(ticket);
});

it('F-1080: restored physical session under a fresh context cannot replay an old explicit binding',async()=>{
  let runs=0;const tools=registry(async()=>{runs+=1;return {marker:'once'};});const first=caller('physical-restored');
  await dispatchToolCall('http-mcp',tools,'nexus_file_write',args('one'),first,{logicalOperationId:'restored-explicit'});
  releaseSessionByToken(first.token);const restored=caller('physical-restored');
  const replay=await dispatchToolCall('http-mcp',tools,'nexus_file_write',args('one'),restored,{logicalOperationId:'restored-explicit'});
  expect(replay).toMatchObject({ok:false,error:'command_effect_identity_conflict'});expect(runs).toBe(1);
});

it('F-1080: a pruned effect cannot remove immutable tool binding from the durable receipt',async()=>{
  let secondRuns=0;const tools=registry(async()=>({marker:'first'}));tools.tools.push({name:'nexus_terminal_run',description:'second controlled sink',inputSchema:{type:'object'},handler:async()=>{secondRuns+=1;return {};}});
  const ctx=caller('physical-pruned');await dispatchToolCall('http-mcp',tools,'nexus_file_write',args('one'),ctx,{logicalOperationId:'pruned-explicit'});
  manager.open(scope).db.prepare('DELETE FROM effect_outbox').run();
  const changed=await dispatchToolCall('http-mcp',tools,'nexus_terminal_run',{command:'true'},ctx,{logicalOperationId:'pruned-explicit'});
  expect(changed).toMatchObject({ok:false,error:'command_effect_identity_conflict'});expect(secondRuns).toBe(0);
});

it('F-1080: changed execution authority under the same physical context refuses an explicit retry',async()=>{
  let runs=0;const tools=registry(async()=>{runs+=1;return {};});const ctx=caller('physical-execution');
  await dispatchToolCall('http-mcp',tools,'nexus_file_write',args('one'),ctx,{logicalOperationId:'scope-explicit'});
  ctx.executionScope=testProjectScope({...scope,rootRealPath:path.join(root,'new-execution')});
  const changed=await dispatchToolCall('http-mcp',tools,'nexus_file_write',args('one'),ctx,{logicalOperationId:'scope-explicit'});
  expect(changed).toMatchObject({ok:false,error:'command_effect_identity_conflict'});expect(runs).toBe(1);
});
