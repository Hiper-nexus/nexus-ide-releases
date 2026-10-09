import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { INITIAL_PROJECT_MIGRATIONS } from '../runtime/project-runtime-schema';
import { reconcileProviderRuntimeAtBoot } from './provider-runtime-recovery';
import { drainEffectOutbox } from './effect-outbox-worker';
import { CommandReceiptStore } from './command-receipts';
import { EffectOutboxStore } from './effect-outbox';
import { testProjectScope } from './__tests__/scope-fixture';
let root:string;let manager:ProjectRuntimeManager;let scope:ReturnType<typeof testProjectScope>;
const binding='b'.repeat(64);
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-physical-receipt-'));scope=testProjectScope({rootRealPath:root});manager=new ProjectRuntimeManager({baseDir:root,appVersion:'physical-test'});});
afterEach(()=>{manager.closeAll();fs.rmSync(root,{recursive:true,force:true});});
function setup(){const receipts=new CommandReceiptStore(manager,scope);const outbox=new EffectOutboxStore(manager,scope);receipts.acceptDispatchObservation({commandId:'owned-command',threadId:'mission-owned',toolName:'nexus_terminal_run',bindingDigest:binding,generated:true});return {receipts,outbox};}
describe('F-1082: durable physical completion requires full owned exit proof',()=>{
  it('handler response and an absent in-memory flight cannot settle a physical obligation',()=>{
    const {receipts,outbox}=setup();receipts.beginPhysicalDispatch(outbox,'owned-command',binding,'nexus_terminal_run');
    receipts.rememberDispatchOutcome('owned-command',{ok:true,tool:'nexus_terminal_run'});
    const entry=outbox.claimNext({workerId:'worker',leaseDurationMs:1000})!;
    expect(receipts.settlePhysicalDispatch(outbox,entry)).toBe(false);
    expect(outbox.listUnsettledBlocking('mission-owned').rows).toHaveLength(1);
    expect(receipts.getByCommandId('owned-command')).toMatchObject({physicalState:'pending',resultSequence:0});
  });
  it('settles actual proven exit and event sequence in the same owned claim transaction, never a foreign manager',()=>{
    const {receipts,outbox}=setup();receipts.beginPhysicalDispatch(outbox,'owned-command',binding,'nexus_bg_run');
    receipts.rememberDispatchOutcome('owned-command',{ok:true,tool:'nexus_bg_run'});
    const entry=outbox.claimNext({workerId:'worker',leaseDurationMs:1000})!;
    receipts.recordPhysicalDispatchProof('owned-command',binding,'proven');
    const foreign=new ProjectRuntimeManager({baseDir:path.join(root,'foreign'),appVersion:'physical-test'});
    try{expect(()=>receipts.settlePhysicalDispatch(new EffectOutboxStore(foreign,scope),entry)).toThrow(/same transaction/);}finally{foreign.closeAll();}
    expect(receipts.settlePhysicalDispatch(outbox,{...entry,attemptCount:entry.attemptCount+1})).toBe(false);
    expect(receipts.settlePhysicalDispatch(outbox,entry)).toBe(true);
    const receipt=receipts.getByCommandId('owned-command')!;
    expect(receipt.resultSequence).toBeGreaterThan(0);expect(outbox.get(entry.id)?.status).toBe('succeeded');
    expect(manager.open(scope).db.prepare('SELECT event_kind FROM command_dispatch_events WHERE sequence=?').get(receipt.resultSequence)).toEqual({event_kind:'settled'});
  });
  it('uncertain physical proof and restart stay blocking, including after database reopen',()=>{
    const {receipts,outbox}=setup();receipts.beginPhysicalDispatch(outbox,'owned-command',binding,'nexus_terminal_run');
    receipts.rememberDispatchOutcome('owned-command',{ok:false,tool:'nexus_terminal_run',effectMayHaveCommitted:true});
    manager.closeAll();const reopened=new CommandReceiptStore(manager,scope);const reopenedOutbox=new EffectOutboxStore(manager,scope);
    expect(reconcileProviderRuntimeAtBoot({runtimeManager:manager,scope}).unsettledReceipts).toBe(1);
    const entry=reopenedOutbox.claimNext({workerId:'after-restart',leaseDurationMs:1000})!;
    expect(reopened.settlePhysicalDispatch(reopenedOutbox,entry)).toBe(false);
    expect(reopened.getByCommandId('owned-command')).toMatchObject({physicalState:'unknown',resultSequence:0});
    expect(reopened.pruneGeneratedSettled({retentionMs:0})).toBe(0);
  });
});

it('F-1082: generic success/no-op handler cannot settle physical outbox without a proven receipt',async()=>{
  const {receipts,outbox}=setup();receipts.beginPhysicalDispatch(outbox,'owned-command',binding,'nexus_terminal_run');
  receipts.rememberDispatchOutcome('owned-command',{ok:true,tool:'nexus_terminal_run'});
  const result=await drainEffectOutbox({store:outbox,scope,workerId:'wrong-handler',handler:()=>undefined});
  expect(result).toMatchObject({succeeded:0,retried:1});expect(outbox.listUnsettledBlocking('mission-owned').rows).toHaveLength(1);
});
it('F-1082: real additive migration preserves old fake-success rows as unknown blocking obligations',()=>{
  manager.closeAll();manager=new ProjectRuntimeManager({baseDir:root,appVersion:'legacy-test',migrations:INITIAL_PROJECT_MIGRATIONS.filter(m=>m.schemaVersion<=51)});
  const receipts=new CommandReceiptStore(manager,scope);const outbox=new EffectOutboxStore(manager,scope);
  receipts.acceptCommandEffect(outbox,{commandId:'legacy-no-proof',commandType:'checkpoint.capture',threadId:'mission-old'},{commandId:'legacy-no-proof',threadId:'mission-old',type:'checkpoint.capture'});
  const claim=outbox.claimNext({workerId:'old-noop',leaseDurationMs:1000})!;expect(outbox.succeed(claim.id,'old-noop',claim.attemptCount)).toBe(true);
  manager.closeAll();manager=new ProjectRuntimeManager({baseDir:root,appVersion:'physical-test'});
  expect(new CommandReceiptStore(manager,scope).getByCommandId('legacy-no-proof')).toMatchObject({physicalState:'unknown',resultSequence:0});
  expect(new EffectOutboxStore(manager,scope).listUnsettledBlocking('mission-old').rows).toMatchObject([{type:'dispatch.physical-settlement',status:'pending'}]);
});

it('F-1082: legacy receipt with a pruned effect is reconstructed as unknown blocking proof, never replayed',()=>{
  manager.closeAll();manager=new ProjectRuntimeManager({baseDir:root,appVersion:'legacy-test',migrations:INITIAL_PROJECT_MIGRATIONS.filter(m=>m.schemaVersion<=51)});
  const receipts=new CommandReceiptStore(manager,scope);const outbox=new EffectOutboxStore(manager,scope);
  receipts.acceptCommandEffect(outbox,{commandId:'legacy-pruned',commandType:'checkpoint.capture',threadId:'mission-pruned'},{commandId:'legacy-pruned',threadId:'mission-pruned',type:'checkpoint.capture'});
  manager.open(scope).db.prepare('DELETE FROM effect_outbox').run();
  manager.closeAll();manager=new ProjectRuntimeManager({baseDir:root,appVersion:'physical-test'});
  expect(new CommandReceiptStore(manager,scope).getByCommandId('legacy-pruned')).toMatchObject({physicalState:'unknown',resultSequence:0});
  expect(new EffectOutboxStore(manager,scope).listUnsettledBlocking('mission-pruned').rows).toMatchObject([{type:'dispatch.physical-settlement',status:'pending'}]);
});
