import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
const decision=vi.hoisted(()=>({wait:async()=>{}}));
vi.mock('./jev-dispatch-guard',async importOriginal=>({...await importOriginal<typeof import('./jev-dispatch-guard')>(),guardToolCall:async()=>{await decision.wait();return {kind:'skipped',reason:'controlled external decision wait'};}}));
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { configureAuditLogRuntime,disposeAuditLogRuntime } from '../jarvis/audit-log';
import { configureProjectDomainStoreRegistry,disposeProjectDomainStoreRegistry,getProjectDomainStores } from './project-domain-store-registry';
import { createScopedMissionStore } from './mission-store';
import { mintToken,bindTokenToSession,releaseSessionByToken,resetGateForTests } from './gate';
import { runInsidePtyStreamAgentTransport } from './http-mcp-boundary';
import { currentPtyMaestroContext } from './mcp-server';
import { dispatchPtyStreamMissionAction,ptyStreamLogicalOperationId } from './pty-stream-dispatch';
import { PtyStreamMissionControl } from './pty-stream-mission-control';
import { testProjectScope } from './__tests__/scope-fixture';
import type { McpRegistry } from './mcp-protocol';
let root:string;let manager:ProjectRuntimeManager;let scope:ReturnType<typeof testProjectScope>;
const controls:PtyStreamMissionControl[]=[];
beforeEach(()=>{root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nexus-pty-operation-')));const st=fs.statSync(root);scope=testProjectScope({rootRealPath:root,workspaceRootDevice:String(st.dev),workspaceRootInode:String(st.ino)});manager=new ProjectRuntimeManager({baseDir:path.join(root,'runtime'),appVersion:'pty-operation-test'});configureAuditLogRuntime(manager);configureProjectDomainStoreRegistry(manager);resetGateForTests();decision.wait=async()=>{};});
afterEach(async()=>{for(const c of controls.splice(0))c.clear();resetGateForTests();await disposeProjectDomainStoreRegistry();await disposeAuditLogRuntime();manager.closeAll();fs.rmSync(root,{recursive:true,force:true});});
function maestro(sessionId:string){
  const missions=getProjectDomainStores(scope).missions;
  const seed=createScopedMissionStore(manager,scope,{assertCreateAccess:()=>{}});
  const mission=seed.create({title:sessionId,orchestratorSessionId:sessionId,intentState:'dispatched',intentVersion:1,intentContract:{version:1,source:'typed',goal:'Main channel receipt identity',acceptanceCriteria:['one bound operation'],risk:'normal',executionMode:'autopilot',contextPolicy:'on-demand',intentVersion:1,approvedAt:Date.now(),orchestratorRuntime:{adapterId:'codex',readOnly:false,nativeReadOnly:false},budgets:{planningTokens:1000,executionTokens:1000,maxWorkers:2,maxSteps:10000}}});
  missions.update(mission.id,{status:'running',intentState:'dispatched'});
  const ctx=mintToken({label:sessionId,role:'orchestrator',providerId:'codex',missionId:mission.id,scope,readOnly:false,allowedTools:null,allowedSkills:null});bindTokenToSession(ctx.token,sessionId);
  expect(currentPtyMaestroContext(sessionId)).toBe(ctx);return ctx;
}
function registry(handler:McpRegistry['tools'][number]['handler']):McpRegistry{return {serverName:'pty-bound-test',serverVersion:'0',tools:[{name:'nexus_memory_retain',description:'controlled acknowledged effect',inputSchema:{type:'object'},handler},{name:'nexus_file_read',description:'controlled observation',inputSchema:{type:'object'},handler:async()=>({observed:true})}]};}
const request=(content='one')=>({id:'call-1',tool:'nexus_memory_retain',args:{content}});
it('F-1091: distinct actual Gate-bound Maestro sessions/channels isolate counters; same-bound retry is once/unavailable and a new channel is fresh',async()=>{
  const a=maestro('session-a');const b=maestro('session-b');const calls:string[]=[];const tools=registry(async(args,ctx)=>{calls.push(`${ctx.sessionId}:${args.content}`);return {transient:'original output'};});
  const call=async(ctx:typeof a,channelId:string,content='one')=>runInsidePtyStreamAgentTransport(ctx.sessionId!,ctx,()=>dispatchPtyStreamMissionAction({sessionId:ctx.sessionId!,channelId,request:request(content),registry:tools,ctx}));
  expect((await call(a,'main-channel')).ok).toBe(true);expect((await call(b,'main-channel')).ok).toBe(true);
  expect(await call(a,'main-channel')).toMatchObject({ok:false,error:'command_result_unavailable'});
  expect((await call(a,'fresh-channel')).ok).toBe(true);expect(calls).toEqual(['session-a:one','session-b:one','session-a:one']);
  expect(await call(a,'main-channel','changed')).toMatchObject({ok:false,error:'command_effect_identity_conflict'});
  a.isolatedWriter=true;expect(await call(a,'main-channel')).toMatchObject({ok:false,denied:true});expect(calls).toHaveLength(3);
  releaseSessionByToken(b.token);await expect(call(b,'fresh-channel')).rejects.toThrow(/current physical PTY mission session/);expect(calls).toHaveLength(3);
  expect(ptyStreamLogicalOperationId('session-a','main-channel','call-1')).not.toBe(ptyStreamLogicalOperationId('session-a','fresh-channel','call-1'));
});
it('F-1091: private wrapper refuses a session argument different from its actual bound context before handler',async()=>{
  const ctx=maestro('actual-session');let runs=0;
  const result=await dispatchPtyStreamMissionAction({sessionId:'different-session',channelId:'main-channel',request:request(),registry:registry(async()=>{runs++;return {};}),ctx});
  expect(result).toMatchObject({ok:false,denied:true});expect(runs).toBe(0);
});
it.each(['drop','clear'] as const)('F-1091: %s of actual controller during dispatch wait aborts before effect while physical Gate remains current',async(mode)=>{
  const ctx=maestro('cleared-session');let runs=0;let entered!:()=>void;let release!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;});const hold=new Promise<void>(r=>{release=r;});decision.wait=async()=>{entered();await hold;};
  const tools=registry(async()=>{runs++;return {};});const writes:string[]=[];
  const control=new PtyStreamMissionControl({isAuthorized:s=>currentPtyMaestroContext(s)!==null,isInjectableIdle:()=>true,write:(_s,text)=>{writes.push(text);return true;},invoke:(sessionId,action,channelId,signal)=>{const current=currentPtyMaestroContext(sessionId)!;return runInsidePtyStreamAgentTransport(sessionId,current,()=>dispatchPtyStreamMissionAction({sessionId,channelId,request:action,registry:tools,ctx:current,options:{callerSignal:signal}}));}});controls.push(control);
  control.ensureChannel(ctx.sessionId!);control.acceptObservedAction(ctx.sessionId!,request());await ready;if(mode==='drop')control.dropSession(ctx.sessionId!);else control.clear();expect(currentPtyMaestroContext(ctx.sessionId!)).toBe(ctx);release();
  await new Promise(r=>setTimeout(r,50));expect(runs).toBe(0);expect(writes).toEqual([]);
});
it('F-1091: real controller eviction cannot hide durable same-channel dedupe or reconstruct a raw result',async()=>{
  const ctx=maestro('evicted-session');let effects=0;let completions=0;const outcomes:Array<{ok:boolean;error?:string}>=[];
  const tools=registry(async()=>{effects++;return {transient:'never durable replay'};});
  const control=new PtyStreamMissionControl({isAuthorized:s=>currentPtyMaestroContext(s)!==null,isInjectableIdle:()=>false,write:()=>true,invoke:async(sessionId,action,channelId,signal)=>{const current=currentPtyMaestroContext(sessionId)!;const outcome=await runInsidePtyStreamAgentTransport(sessionId,current,()=>dispatchPtyStreamMissionAction({sessionId,channelId,request:action,registry:tools,ctx:current,options:{callerSignal:signal}}));outcomes.push(outcome);completions++;return outcome;}});controls.push(control);const channel=control.ensureChannel(ctx.sessionId!);
  control.acceptObservedAction(ctx.sessionId!,request());await vi.waitFor(()=>expect(completions).toBe(1));
  // Immediate repaint is intentionally suppressed by the existing bounded tracker.
  control.acceptObservedAction(ctx.sessionId!,request());await new Promise(r=>setTimeout(r,0));expect(completions).toBe(1);
  for(let i=0;i<1024;i++)control.acceptObservedAction(ctx.sessionId!,{id:`observation-${i}`,tool:'nexus_file_read',args:{path:'tiny.txt'}});
  await vi.waitFor(()=>expect(completions).toBe(1025),{timeout:10000});
  control.acceptObservedAction(ctx.sessionId!,request());await vi.waitFor(()=>expect(completions).toBe(1026));expect(effects).toBe(1);expect(outcomes.at(-1)).toMatchObject({ok:false,error:'command_result_unavailable'});expect(control.ensureChannel(ctx.sessionId!)).toBe(channel);
},15000);

it('F-1091: same-bound joining call rechecks revoked actual physical caller after waiting and never discloses original output',async()=>{
  const ctx=maestro('joined-session');let entered!:()=>void;let release!:()=>void;let runs=0;
  const ready=new Promise<void>(r=>{entered=r;});const hold=new Promise<void>(r=>{release=r;});
  const tools=registry(async()=>{runs++;entered();await hold;return {transient:'private-owner-original'};});
  const call=()=>runInsidePtyStreamAgentTransport(ctx.sessionId!,ctx,()=>dispatchPtyStreamMissionAction({sessionId:ctx.sessionId!,channelId:'same-main-channel',request:request(),registry:tools,ctx}));
  const first=call();await ready;const joined=call();await new Promise(r=>setTimeout(r,0));releaseSessionByToken(ctx.token);release();
  const results=await Promise.all([first,joined]);expect(runs).toBe(1);expect(results[1]).toMatchObject({ok:false,denied:true});expect(JSON.stringify(results)).not.toContain('private-owner-original');
});
