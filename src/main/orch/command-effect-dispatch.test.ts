import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { configureAuditLogRuntime, disposeAuditLogRuntime } from '../jarvis/audit-log';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { CommandReceiptStore } from './command-receipts';
import { EffectOutboxStore } from './effect-outbox';
import { mintToken,bindTokenToSession,resetGateForTests } from './gate';
import { dispatchToolCall } from './mcp-dispatch';
import type { McpRegistry } from './mcp-protocol';
import { configureProjectDomainStoreRegistry,disposeProjectDomainStoreRegistry } from './project-domain-store-registry';
import { testProjectScope } from './__tests__/scope-fixture';
let root:string;let manager:ProjectRuntimeManager;let scope:ReturnType<typeof testProjectScope>;let ctx:ReturnType<typeof mintToken>;
beforeEach(()=>{root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nexus-logical-dispatch-')));const st=fs.statSync(root);scope=testProjectScope({rootRealPath:root,workspaceRootDevice:String(st.dev),workspaceRootInode:String(st.ino)});manager=new ProjectRuntimeManager({baseDir:root,appVersion:'logical-test'});configureAuditLogRuntime(manager);configureProjectDomainStoreRegistry(manager);resetGateForTests();ctx=mintToken({label:'logical',role:'user',scope,allowedTools:null,allowedSkills:null});bindTokenToSession(ctx.token,'logical-session');});
afterEach(async()=>{resetGateForTests();await disposeProjectDomainStoreRegistry();await disposeAuditLogRuntime();manager.closeAll();fs.rmSync(root,{recursive:true,force:true});});
function tools(handler:McpRegistry['tools'][number]['handler']):McpRegistry{return {serverName:'bounded-logical',serverVersion:'0',tools:[{name:'nexus_file_write',description:'controlled logical response',inputSchema:{type:'object'},handler}]};}
const args={path:'output.txt',content:'fixed'};
it('bounded handler acknowledgment certifies response observation without emitting a fake checkpoint',async()=>{
  const result=await dispatchToolCall('http-mcp',tools(async()=>({ack:true})),'nexus_file_write',args,ctx);
  expect(result.ok).toBe(true);expect(new EffectOutboxStore(manager,scope).listUnsettledBlocking(scope.projectId).rows).toEqual([]);
  expect(new CommandReceiptStore(manager,scope).countUnsettled()).toBe(0);
  const row=manager.open(scope).db.prepare('SELECT command_type,result_sequence FROM command_receipts').get();expect(row).toMatchObject({command_type:'dispatch.observation',result_sequence:expect.any(Number)});
});
it('explicit immutable Main operation runs once; retry never reconstructs transient handler output',async()=>{
  let runs=0;const registry=tools(async()=>{runs++;return {stdout:'transient'};});const options={logicalOperationId:'safe-once'};
  expect((await dispatchToolCall('http-mcp',registry,'nexus_file_write',args,ctx,options)).ok).toBe(true);
  expect(await dispatchToolCall('http-mcp',registry,'nexus_file_write',args,ctx,options)).toMatchObject({ok:false,error:'command_result_unavailable',effectMayHaveCommitted:true});
  expect(runs).toBe(1);
});
it('generic handler throw remains unknown after its JS flight ends and does not authorize mutation replay',async()=>{
  let runs=0;const registry=tools(async()=>{runs++;throw new Error('external ACK lost after possible commit');});const options={logicalOperationId:'unknown-once'};
  expect(await dispatchToolCall('http-mcp',registry,'nexus_file_write',args,ctx,options)).toMatchObject({ok:false,effectMayHaveCommitted:true});
  expect(await dispatchToolCall('http-mcp',registry,'nexus_file_write',args,ctx,options)).toMatchObject({ok:false,error:'command_result_unavailable',effectMayHaveCommitted:true});
  expect(runs).toBe(1);expect(new CommandReceiptStore(manager,scope).listUnsettledMetadata().rows).toMatchObject([{dispatchState:'unknown',physicalState:'none',resultSequence:0}]);
});
