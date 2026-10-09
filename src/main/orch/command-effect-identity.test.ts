import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureAuditLogRuntime, disposeAuditLogRuntime } from '../jarvis/audit-log';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { mintToken, bindTokenToSession, resetGateForTests } from './gate';
import { dispatchToolCall } from './mcp-dispatch';
import { type McpRegistry } from './mcp-protocol';
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
