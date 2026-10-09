import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureAuditLogRuntime, disposeAuditLogRuntime } from '../jarvis/audit-log';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { bindTokenToSession, mintToken, resetGateForTests } from './gate';
import { dispatchToolCall } from './mcp-dispatch';
import { configureProjectDomainStoreRegistry, disposeProjectDomainStoreRegistry, getProjectDomainStores } from './project-domain-store-registry';
import type { McpRegistry } from './mcp-protocol';
import { createScopedMissionStore } from './mission-store';
import { testProjectScope } from './__tests__/scope-fixture';

const model=vi.hoisted(()=>({wait:async()=>{}}));
vi.mock('./jev-dispatch-guard',async importOriginal=>{
  const actual=await importOriginal<typeof import('./jev-dispatch-guard')>();
  return {...actual,guardToolCall:async()=>{await model.wait();return {kind:'skipped',reason:'controlled external-decision boundary'};}};
});
let root:string;
let manager:ProjectRuntimeManager;
afterEach(async()=>{
  resetGateForTests();await disposeProjectDomainStoreRegistry();await disposeAuditLogRuntime();manager?.closeAll();if(root)fs.rmSync(root,{recursive:true,force:true});
});

describe('F-1083: actual mission spend and correlated audit ownership',()=>{
  it('overlapped same-operation admissions charge one real step and terminate every audit intent',async()=>{
    root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-command-budget-'));manager=new ProjectRuntimeManager({baseDir:root,appVersion:'command-budget-test'});
    const scope=testProjectScope({rootRealPath:root});configureAuditLogRuntime(manager);configureProjectDomainStoreRegistry(manager);resetGateForTests();
    const missions=getProjectDomainStores(scope).missions;
    // Seed a licensed test record through the real store; dispatch authority/budget remain production code.
    const seed=createScopedMissionStore(manager,scope,{assertCreateAccess:()=>{}});
    const mission=seed.create({title:'Budget proof',intentState:'dispatched',intentVersion:1,intentContract:{version:1,source:'typed',goal:'One logical operation',acceptanceCriteria:['one handler'],risk:'normal',executionMode:'autopilot',contextPolicy:'on-demand',intentVersion:1,approvedAt:Date.now(),budgets:{planningTokens:1000,executionTokens:1000,maxWorkers:2,maxSteps:1}}});
    missions.update(mission.id,{status:'running',intentState:'dispatched'});
    const ctx=mintToken({label:'budget-owner',role:'user',missionId:mission.id,scope,allowedTools:null,allowedSkills:null});bindTokenToSession(ctx.token,'budget-physical');
    let entered=0;let release!:()=>void;let bothReady!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;});const ready=new Promise<void>(resolve=>{bothReady=resolve;});
    model.wait=async()=>{entered+=1;if(entered===2)bothReady();await barrier;};
    let runs=0;const registry:McpRegistry={serverName:'budget-test',serverVersion:'0',tools:[{name:'nexus_memory_retain',description:'logical acknowledged effect',inputSchema:{type:'object'},handler:async()=>{runs+=1;return {observed:true};}}]};
    const call=()=>dispatchToolCall('http-mcp',registry,'nexus_memory_retain',{content:'nonsecret test observation'},ctx,{logicalOperationId:'overlapped-budget'});
    const first=call();const second=call();await ready;release();const results=await Promise.all([first,second]);
    expect(results.some(result=>result.ok)).toBe(true);expect(runs).toBe(1);
    expect(missions.get(mission.id)?.intentContract?.spentSteps).toBe(1);
    const rows=manager.open(scope).db.prepare("SELECT outcome,json_extract(payload_json,'$.invocation_id') AS invocation FROM audit_events WHERE action='nexus_memory_retain'").all() as Array<{outcome:string;invocation:string}>;
    const intents=rows.filter(row=>row.outcome==='intent');expect(intents).toHaveLength(2);
    for(const intent of intents)expect(rows.filter(row=>row.invocation===intent.invocation&&row.outcome!=='intent')).toHaveLength(1);
  });
});
