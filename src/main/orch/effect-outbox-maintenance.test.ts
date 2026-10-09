import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { runPeriodicTask } from '../observability/periodic-task';
import { testProjectScope } from './__tests__/scope-fixture';
import { configureProjectDomainStoreRegistry,disposeProjectDomainStoreRegistry,requireProjectDomainStoreRegistry } from './project-domain-store-registry';
import { EffectOutboxStore,SETTLED_EFFECT_RETENTION_MS } from './effect-outbox';
import { CommandReceiptStore } from './command-receipts';
import { registerDispatchPhysicalSettlementHandler } from './effect-outbox-worker';
import { maintainEffectOutboxes } from './effect-outbox-maintenance';
let root:string;let manager:ProjectRuntimeManager;let scope:ReturnType<typeof testProjectScope>;let outbox:EffectOutboxStore;
const digest='e'.repeat(64);
const past=()=>Date.now()-SETTLED_EFFECT_RETENTION_MS-60000;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-effect-maint-'));scope=testProjectScope({rootRealPath:root});manager=new ProjectRuntimeManager({baseDir:root,appVersion:'effect-maint-test'});configureProjectDomainStoreRegistry(manager).forScope(scope);outbox=new EffectOutboxStore(manager,scope);});
afterEach(async()=>{vi.restoreAllMocks();await disposeProjectDomainStoreRegistry();manager.closeAll();fs.rmSync(root,{recursive:true,force:true});});
function seedOld(count:number,targetScope=scope){const db=manager.open(targetScope).db;const insert=db.prepare("INSERT INTO effect_outbox(effect_id,command_id,thread_id,effect_type,payload_json,status,attempt_count,available_at,created_at,updated_at,completed_at) VALUES(?,?,?,'runtime.continue','{}','succeeded',1,?,?,?,?)");db.transaction(()=>{for(let i=0;i<count;i++)insert.run(`old-${i}`,`old-command-${i}`,`old-thread-${i}`,past(),past(),past(),past());})();}
function countOld(){return (manager.open(scope).db.prepare("SELECT COUNT(*) AS n FROM effect_outbox WHERE effect_id LIKE 'old-%'").get() as {n:number}).n;}
it('F-1092: real production maintenance prunes at most500effects/scope and100known-generatedreceipts/pass, preserving protected state and explicit binding',async()=>{
  seedOld(601);
  const recent=outbox.enqueue({commandId:'recent',threadId:'recent',type:'runtime.continue'});const claim=outbox.claimNext({workerId:'recent-proof',leaseDurationMs:100000})!;expect(claim.id).toBe(recent.id);expect(outbox.succeed(claim.id,'recent-proof',claim.attemptCount)).toBe(true);
  const active=outbox.enqueue({commandId:'active',threadId:'active',type:'terminal.cleanup'});const activeClaim=outbox.claimNext({workerId:'live-lease',leaseDurationMs:100000})!;expect(activeClaim.id).toBe(active.id);
  const pending=outbox.enqueue({commandId:'pending',threadId:'pending',type:'runtime.continue',availableAt:Date.now()+100000});
  const receipts=new CommandReceiptStore(manager,scope,{now:past});
  for(let i=0;i<101;i++){receipts.acceptDispatchObservation({commandId:`generated-${i}`,toolName:'nexus_memory_retain',projectId:scope.projectId,bindingDigest:digest,generated:true});receipts.rememberDispatchOutcome(`generated-${i}`,{ok:true,tool:'nexus_memory_retain'});}
  receipts.acceptDispatchObservation({commandId:'explicit',toolName:'nexus_memory_retain',projectId:scope.projectId,bindingDigest:digest,generated:false});receipts.rememberDispatchOutcome('explicit',{ok:true,tool:'nexus_memory_retain'});const explicit=receipts.getByCommandId('explicit')!;
  receipts.acceptDispatchObservation({commandId:'unknown-logical',toolName:'nexus_memory_retain',projectId:scope.projectId,bindingDigest:digest,generated:true});receipts.rememberDispatchOutcome('unknown-logical',{ok:false,tool:'nexus_memory_retain',effectMayHaveCommitted:true});
  receipts.acceptDispatchObservation({commandId:'unknown-physical',toolName:'nexus_terminal_run',projectId:scope.projectId,bindingDigest:digest,generated:true});receipts.beginPhysicalDispatch(outbox,'unknown-physical',digest,'nexus_terminal_run');receipts.recordPhysicalDispatchProof('unknown-physical',digest,'unknown');
  await maintainEffectOutboxes();expect(countOld()).toBe(101);
  expect((manager.open(scope).db.prepare("SELECT COUNT(*) AS n FROM command_receipts WHERE command_id LIKE 'generated-%'").get() as {n:number}).n).toBe(1);
  await maintainEffectOutboxes();expect(countOld()).toBe(0);
  expect(receipts.getByCommandId('explicit')).toMatchObject({bindingDigest:digest,resultSequence:explicit.resultSequence});expect(explicit.resultSequence).toBeGreaterThan(0);
  expect(receipts.getByCommandId('unknown-logical')).toMatchObject({resultSequence:0,dispatchState:'unknown'});expect(receipts.getByCommandId('unknown-physical')).toMatchObject({physicalState:'unknown',resultSequence:0});
  expect(outbox.get(pending.id)?.status).toBe('pending');expect(outbox.get(active.id)).toMatchObject({status:'running',leaseOwner:'live-lease',attemptCount:activeClaim.attemptCount});expect(outbox.get(recent.id)?.status).toBe('succeeded');expect(outbox.listUnsettledBlocking(scope.projectId).rows).toHaveLength(1);
});
it('F-1092: actual periodic cancellation after awaited drain prevents later retention writes',async()=>{
  seedOld(1);const cancellation=new AbortController();const original=EffectOutboxStore.prototype.claimNext;
  vi.spyOn(EffectOutboxStore.prototype,'claimNext').mockImplementation(function(this:EffectOutboxStore,input){const result=original.call(this,input);if(!result)queueMicrotask(()=>cancellation.abort());return result;});
  await expect(runPeriodicTask(`effect-maint-test-${root}`,context=>maintainEffectOutboxes(context),{signal:cancellation.signal})).rejects.toThrow();
  expect(countOld()).toBe(1);
});
it('F-1092: finite batch option rejects malformed limits before any deletion',()=>{
  seedOld(1);
  for(const limit of [NaN,Infinity,-1,1.5,2])expect(()=>outbox.pruneSettled(SETTLED_EFFECT_RETENTION_MS,limit)).toThrow();
  expect(countOld()).toBe(1);
});

function healthyScope(){const healthy=testProjectScope({...scope,projectId:'healthy-project',checkoutId:'healthy-checkout',rootRealPath:path.join(root,'healthy')});fs.mkdirSync(healthy.rootRealPath);requireProjectDomainStoreRegistry().forScope(healthy);return healthy;}
function physical(ownedScope:typeof scope,id:string){const receipts=new CommandReceiptStore(manager,ownedScope);const effects=new EffectOutboxStore(manager,ownedScope);receipts.acceptDispatchObservation({commandId:id,toolName:'nexus_terminal_run',projectId:ownedScope.projectId,bindingDigest:digest,generated:false});receipts.beginPhysicalDispatch(effects,id,digest,'nexus_terminal_run');receipts.rememberDispatchOutcome(id,{ok:true,tool:'nexus_terminal_run'});return {receipts,effects};}
it('F-1094: failed published scope cannot starve healthy physical verifier/retention; categorical warning never logs error body',async()=>{
  seedOld(1);const explicitStore=new CommandReceiptStore(manager,scope);explicitStore.acceptDispatchObservation({commandId:'failed-explicit',toolName:'nexus_memory_retain',projectId:scope.projectId,bindingDigest:digest,generated:false});explicitStore.rememberDispatchOutcome('failed-explicit',{ok:true,tool:'nexus_memory_retain'});const explicitSequence=explicitStore.getByCommandId('failed-explicit')!.resultSequence;
  const failed=physical(scope,'failed-unknown');failed.receipts.recordPhysicalDispatchProof('failed-unknown',digest,'unknown');
  const healthy=healthyScope();seedOld(601,healthy);const ready=physical(healthy,'healthy-proven');ready.receipts.recordPhysicalDispatchProof('healthy-proven',digest,'proven');
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});const original=EffectOutboxStore.prototype.claimNext;
  vi.spyOn(EffectOutboxStore.prototype,'claimNext').mockImplementation(function(this:EffectOutboxStore,input){if(this.scope.checkoutId===scope.checkoutId)throw new Error('fixture-private-error-body token=not-real');return original.call(this,input);});
  const unregister=registerDispatchPhysicalSettlementHandler(()=>manager);
  try{await maintainEffectOutboxes();expect(countOld()).toBe(1);expect(explicitStore.getByCommandId('failed-explicit')).toMatchObject({bindingDigest:digest,resultSequence:explicitSequence});expect(failed.receipts.getByCommandId('failed-unknown')).toMatchObject({physicalState:'unknown',resultSequence:0});
    const receipt=ready.receipts.getByCommandId('healthy-proven')!;expect(receipt.resultSequence).toBeGreaterThan(0);expect(manager.open(healthy).db.prepare('SELECT command_id,event_kind FROM command_dispatch_events WHERE sequence=?').get(receipt.resultSequence)).toEqual({command_id:'healthy-proven',event_kind:'settled'});
    expect((manager.open(healthy).db.prepare("SELECT COUNT(*) AS n FROM effect_outbox WHERE effect_id LIKE 'old-%'").get() as {n:number}).n).toBe(101);
    expect(warn).toHaveBeenCalled();expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-private-error-body');expect(JSON.stringify(warn.mock.calls)).not.toContain('not-real');
  }finally{unregister();}
});
it.each(['cancel','replace'] as const)('F-1094: global %s at scope failure propagates with no later-scope work',async(fault)=>{
  seedOld(1);const healthy=healthyScope();seedOld(1,healthy);let healthyClaims=0;const cancellation=new AbortController();const original=EffectOutboxStore.prototype.claimNext;
  vi.spyOn(EffectOutboxStore.prototype,'claimNext').mockImplementation(function(this:EffectOutboxStore,input){if(this.scope.checkoutId===scope.checkoutId){if(fault==='cancel')cancellation.abort();else configureProjectDomainStoreRegistry(manager);throw new Error('scope SQL failure after lifecycle changed');}healthyClaims++;return original.call(this,input);});
  await expect(runPeriodicTask(`effect-scope-${root}`,context=>maintainEffectOutboxes(context),{signal:cancellation.signal})).rejects.toThrow();
  expect(healthyClaims).toBe(0);expect(countOld()).toBe(1);expect((manager.open(healthy).db.prepare("SELECT COUNT(*) AS n FROM effect_outbox WHERE effect_id LIKE 'old-%'").get() as {n:number}).n).toBe(1);
});
