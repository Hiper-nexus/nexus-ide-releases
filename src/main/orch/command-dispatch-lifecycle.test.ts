import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { CommandReceiptStore } from './command-receipts';
import { EffectOutboxStore } from './effect-outbox';
import { reconcileProviderRuntimeAtBoot } from './provider-runtime-recovery';
import { testProjectScope } from './__tests__/scope-fixture';
let root:string;let manager:ProjectRuntimeManager;let scope:ReturnType<typeof testProjectScope>;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-dispatch-life-'));manager=new ProjectRuntimeManager({baseDir:root,appVersion:'dispatch-life-test'});scope=testProjectScope({rootRealPath:root});});
afterEach(()=>{vi.restoreAllMocks();manager.closeAll();fs.rmSync(root,{recursive:true,force:true});});
const binding='a'.repeat(64);
function accept(store:CommandReceiptStore,id:string){return store.acceptDispatchObservation({commandId:id,toolName:'nexus_file_write',projectId:scope.projectId,bindingDigest:binding,generated:true});}

describe('F-1084: real durable receipt lifecycle',()=>{
  it('records logical observation in a genuine append-only event sequence without a fake checkpoint',()=>{
    const store=new CommandReceiptStore(manager,scope);accept(store,'logical-one');
    store.rememberDispatchOutcome('logical-one',{ok:true,tool:'nexus_file_write',result:{stdout:'not durable'}});
    const receipt=store.getByCommandId('logical-one')!;
    expect(receipt.resultSequence).toBeGreaterThan(0);
    const event=manager.open(scope).db.prepare('SELECT command_id,event_kind FROM command_dispatch_events WHERE sequence=?').get(receipt.resultSequence);
    expect(event).toEqual({command_id:'logical-one',event_kind:'settled'});
    expect(new EffectOutboxStore(manager,scope).listByCommandId('logical-one')).toEqual([]);
  });
  it('bounds unresolved metadata pages and boot count never selects historical outcome bodies',()=>{
    const store=new CommandReceiptStore(manager,scope);
    for(let i=0;i<5;i++)accept(store,`unsettled-${i}`);
    const first=store.listUnsettledMetadata({limit:2});expect(first.rows).toHaveLength(2);expect(first.nextCursor).toEqual(expect.any(String));
    const next=store.listUnsettledMetadata({limit:2,cursor:first.nextCursor});expect(next.rows).toHaveLength(2);expect(new Set([...first.rows,...next.rows].map(row=>row.commandId)).size).toBe(4);
    expect(first.rows.every(row=>!('outcomeJson' in row)&&!('error' in row))).toBe(true);
    const db=manager.open(scope).db;const prepare=vi.spyOn(db,'prepare');
    expect(reconcileProviderRuntimeAtBoot({runtimeManager:manager,scope}).unsettledReceipts).toBe(5);
    expect(prepare.mock.calls.some(([sql])=>/SELECT\s+\*\s+FROM\s+command_receipts/iu.test(String(sql)))).toBe(false);
  });
  it('rejects malformed page/retention bounds rather than issuing unbounded SQL',()=>{
    const store=new CommandReceiptStore(manager,scope);
    expect(()=>store.listUnsettledMetadata({limit:NaN})).toThrow();
    expect(()=>store.listUnsettledMetadata({limit:101})).toThrow();
    expect(()=>store.pruneGeneratedSettled({limit:Infinity})).toThrow();
    expect(()=>store.pruneGeneratedSettled({retentionMs:NaN})).toThrow();
  });
  it('does not prune generated unknown/unsettled records or explicit dedupe metadata',()=>{
    const store=new CommandReceiptStore(manager,scope);accept(store,'old-generated');accept(store,'unknown');
    store.acceptDispatchObservation({commandId:'explicit',toolName:'nexus_file_write',projectId:scope.projectId,bindingDigest:binding,generated:false});
    store.rememberDispatchOutcome('old-generated',{ok:true,tool:'nexus_file_write'});
    store.rememberDispatchOutcome('explicit',{ok:true,tool:'nexus_file_write'});
    expect(store.pruneGeneratedSettled({retentionMs:0,limit:2})).toBe(1);
    expect(store.getByCommandId('unknown')).not.toBeNull();expect(store.getByCommandId('explicit')).not.toBeNull();
  });
});
