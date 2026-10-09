import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({prepare:vi.fn()}));
vi.mock('./owned-command-launch',()=>({prepareOwnedCommandLaunch:h.prepare}));
vi.mock('../persistence/settings-store',()=>({getOrchSettings:()=>({squadCliPolicy:'operator-choice'})}));
// Real bounded /bin/sh tasks; owned exit is independently controlled below.
// This is Main consumer/lifetime integration evidence, not platform sandbox proof.
vi.mock('../runtime/process-sandbox',()=>({createScopedSandboxHome:(scope:{rootRealPath:string})=>({dir:fs.mkdtempSync(path.join(scope.rootRealPath,'sandbox-'))}),buildScopedShellPlan:(input:{command:string;cwd:string;env:Record<string,string>})=>({file:'/bin/sh',args:['-c',input.command],cwd:input.cwd,env:{...process.env,...input.env},detached:false,profile:'test'})}));
import { configureAuditLogRuntime, disposeAuditLogRuntime } from '../jarvis/audit-log';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { configureProjectDomainStoreRegistry, disposeProjectDomainStoreRegistry } from './project-domain-store-registry';
import { mintToken, bindTokenToSession, releaseSessionByToken, resetGateForTests } from './gate';
import { dispatchToolCall } from './mcp-dispatch';
import { buildTerminalTools } from './tools-terminal';
import { buildBgTools } from './tools-bg';
import { CommandReceiptStore } from './command-receipts';
import { EffectOutboxStore } from './effect-outbox';
import { drainEffectOutbox, registerDispatchPhysicalSettlementHandler } from './effect-outbox-worker';
import { groupFixtureLaunch } from './__tests__/owned-command-fixture';
import { testProjectScope } from './__tests__/scope-fixture';
let root:string;let manager:ProjectRuntimeManager;let scope:ReturnType<typeof testProjectScope>;let ctx:ReturnType<typeof mintToken>;
let releaseProof:(()=>void)|undefined;
beforeEach(()=>{root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nexus-owned-dispatch-')));const st=fs.statSync(root);scope=testProjectScope({rootRealPath:root,workspaceRootDevice:String(st.dev),workspaceRootInode:String(st.ino)});manager=new ProjectRuntimeManager({baseDir:root,appVersion:'owned-test'});configureAuditLogRuntime(manager);configureProjectDomainStoreRegistry(manager);resetGateForTests();ctx=mintToken({label:'owned',role:'user',scope,allowedTools:null,allowedSkills:null});bindTokenToSession(ctx.token,'owned-session');h.prepare.mockReset();});
afterEach(async()=>{releaseProof?.();releaseProof=undefined;await new Promise(r=>setTimeout(r,40));resetGateForTests();await disposeProjectDomainStoreRegistry();await disposeAuditLogRuntime();manager.closeAll();fs.rmSync(root,{recursive:true,force:true});});
const registry=()=>({serverName:'actual-owned-tools',serverVersion:'0',tools:[...buildTerminalTools(),...buildBgTools()]});
const receipt=()=>new CommandReceiptStore(manager,scope).listUnsettledMetadata().rows[0];
it.each(['nexus_terminal_run','nexus_bg_run'])('F-1082: %s persists obligation before preparation that can create OCI work; failed preparation remains unknown',async(tool)=>{
  let sawMarker=false;h.prepare.mockImplementation(async()=>{sawMarker=receipt()?.physicalState==='pending';throw new Error('uncertain-OCI-preparation-fixture');});
  const result=await dispatchToolCall('http-mcp',registry(),tool,{command:'true'},ctx);
  expect(h.prepare).toHaveBeenCalledTimes(1);expect(sawMarker).toBe(true);expect(result).toMatchObject({ok:false,effectMayHaveCommitted:true});
  expect(receipt()).toMatchObject({physicalState:'unknown',resultSequence:0});expect(new EffectOutboxStore(manager,scope).listUnsettledBlocking(scope.projectId).rows).toHaveLength(1);
});
it('F-1082: actual bg launch ACK remains blocked until separately bound owned tree exit, including DB reopen and late caller revocation',async()=>{
  const proof=new Promise<void>(r=>{releaseProof=r;});h.prepare.mockImplementation(async plan=>{const launch=await groupFixtureLaunch(plan);return {...launch,waitForExit:async(proc:Parameters<typeof launch.waitForExit>[0])=>{await launch.waitForExit(proc);await proof;}};});
  const result=await dispatchToolCall('http-mcp',registry(),'nexus_bg_run',{command:'sleep 0.05'},ctx);
  expect(result).toMatchObject({ok:true,result:{taskId:expect.any(String)}});expect(receipt()).toMatchObject({physicalState:'pending',resultSequence:0});
  const unregister=registerDispatchPhysicalSettlementHandler(()=>manager);
  try{const outbox=new EffectOutboxStore(manager,scope);expect((await drainEffectOutbox({store:outbox,scope,workerId:'consumer',retryDelayMs:0})).succeeded).toBe(0);
    manager.closeAll();releaseSessionByToken(ctx.token);releaseProof!();await vi.waitFor(()=>expect(receipt()?.physicalState).toBe('proven'));
    expect((await drainEffectOutbox({store:new EffectOutboxStore(manager,scope),scope,workerId:'consumer',retryDelayMs:0})).succeeded).toBe(1);
    expect(new CommandReceiptStore(manager,scope).countUnsettled()).toBe(0);
  }finally{unregister();}
});
it('F-1082: foreground logical timeout cannot release a still-unproven owned lifetime; late proof survives released flight',async()=>{
  const proof=new Promise<void>(r=>{releaseProof=r;});h.prepare.mockImplementation(async plan=>{const launch=await groupFixtureLaunch(plan);return {...launch,waitForExit:async(proc:Parameters<typeof launch.waitForExit>[0])=>{await launch.waitForExit(proc);await proof;}};});
  const result=await dispatchToolCall('http-mcp',registry(),'nexus_terminal_run',{command:'sleep 0.05',timeoutMs:10},ctx,{logicalOperationId:'timed-owned'});
  expect(result).toMatchObject({ok:false,effectMayHaveCommitted:true,error:expect.stringContaining('physical process exit not proven')});
  expect(receipt()).toMatchObject({physicalState:'pending',resultSequence:0});
  const unregister=registerDispatchPhysicalSettlementHandler(()=>manager);
  try{const outbox=new EffectOutboxStore(manager,scope);expect((await drainEffectOutbox({store:outbox,scope,workerId:'consumer',retryDelayMs:0})).succeeded).toBe(0);
    const replay=await dispatchToolCall('http-mcp',registry(),'nexus_terminal_run',{command:'sleep 0.05',timeoutMs:10},ctx,{logicalOperationId:'timed-owned'});
    expect(replay).toMatchObject({ok:false,error:'command_result_unavailable',effectMayHaveCommitted:true});expect(h.prepare).toHaveBeenCalledTimes(1);
    releaseProof!();await vi.waitFor(()=>expect(receipt()?.physicalState).toBe('proven'));
    expect((await drainEffectOutbox({store:outbox,scope,workerId:'consumer',retryDelayMs:0})).succeeded).toBe(1);
  }finally{unregister();}
},10000);
