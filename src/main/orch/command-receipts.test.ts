import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { INITIAL_PROJECT_MIGRATIONS } from '../runtime/project-runtime-schema';
import { CommandReceiptStore } from './command-receipts';
import { testProjectScope } from './__tests__/scope-fixture';

let root:string;
let manager:ProjectRuntimeManager;
let scope:ReturnType<typeof testProjectScope>;
beforeEach(()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-safe-command-receipt-'));
  manager=new ProjectRuntimeManager({baseDir:root,appVersion:'safe-command-receipt-test'});
  scope=testProjectScope({rootRealPath:root});
});
afterEach(()=>{manager.closeAll();fs.rmSync(root,{recursive:true,force:true});});
function receipt(id='safe-command'){
  const store=new CommandReceiptStore(manager,scope);
  store.insertIfAbsent({commandId:id,commandType:'checkpoint.capture',projectId:scope.projectId});return store;
}

describe('F-1081: nonsensitive persisted dispatch observation',()=>{
  it('never writes stdout/stderr/ticket/body to SQLite or WAL',()=>{
    const store=receipt();const secret='fixture-secret-output-7ff2';const ticket='fixture-cdp-ticket-5531';
    store.rememberDispatchOutcome('safe-command',{ok:true,tool:'nexus_terminal_run',result:{stdout:secret,stderr:secret,capabilityUrl:`ws://127.0.0.1/cdp/pane?ticket=${ticket}`,body:{private:secret}}});
    const outcome=store.getByCommandId('safe-command')?.outcomeJson??'';
    expect(outcome).not.toContain(secret);expect(outcome).not.toContain(ticket);
    expect(JSON.parse(outcome)).toMatchObject({schema:'nexus.command-response/v1',response:'observed-success',originalResultAvailable:false});
    const db=manager.open(scope).db;
    for(const file of [db.name,db.name+'-wal'])if(fs.existsSync(file)){
      const bytes=fs.readFileSync(file);expect(bytes.includes(Buffer.from(secret))).toBe(false);expect(bytes.includes(Buffer.from(ticket))).toBe(false);
    }
  });
  it('records only fixed response metadata from an unknown error, never raw error/hint',()=>{
    const store=receipt();const secret='fixture-raw-error-body-8a39';
    store.rememberDispatchOutcome('safe-command',{ok:false,tool:'nexus_terminal_run',error:secret,hint:secret,effectMayHaveCommitted:true,result:{errorBody:secret}});
    const outcome=store.getByCommandId('safe-command')?.outcomeJson??'';
    expect(outcome).not.toContain(secret);
    expect(JSON.parse(outcome)).toMatchObject({schema:'nexus.command-response/v1',response:'unknown',originalResultAvailable:false});
  });
  it('clears historical unsafe outcomes by migration without interpreting their bodies',()=>{
    manager.closeAll();
    const legacy=new ProjectRuntimeManager({baseDir:root,appVersion:'legacy-receipt-test',migrations:INITIAL_PROJECT_MIGRATIONS.filter(m=>m.schemaVersion<=49)});
    legacy.open(scope).db.prepare(`INSERT INTO command_receipts(command_id,aggregate_kind,aggregate_id,command_type,accepted_at,result_sequence,status,error,effect_class) VALUES('old','project',?,'checkpoint.capture',1,0,'accepted',NULL,'replay_safe')`).run(scope.projectId);
    legacy.open(scope).db.prepare('UPDATE command_receipts SET outcome_json=? WHERE command_id=?').run('{"privateBody":"legacy-secret"}','old');legacy.closeAll();
    expect(new CommandReceiptStore(manager,scope).getByCommandId('old')?.outcomeJson).toBeNull();
  });
});

it('F-1080: a new upsert preserves its actual binding and refuses replacement',()=>{
  const store=new CommandReceiptStore(manager,scope);const binding='a'.repeat(64);
  const stored=store.upsert({commandId:'bound-upsert',commandType:'checkpoint.capture',projectId:scope.projectId,status:'accepted',resultSequence:4,bindingDigest:binding});
  expect(stored.bindingDigest).toBe(binding);
  expect(()=>store.upsert({commandId:'bound-upsert',commandType:'checkpoint.capture',projectId:scope.projectId,status:'accepted',resultSequence:5,bindingDigest:'b'.repeat(64)})).toThrow('command_effect_identity_conflict');
});

describe('perf #7: rememberDispatchOutcome funde os UPDATEs do settlement',()=>{
  it('settle de uma dispatch.observation grava no máximo 2 UPDATEs em command_receipts',()=>{
    const store=new CommandReceiptStore(manager,scope);
    store.acceptDispatchObservation({commandId:'perf-settle',toolName:'nexus_terminal_run',bindingDigest:'a'.repeat(64),generated:false,projectId:scope.projectId});
    const db=manager.open(scope).db;
    const prepareSpy=vi.spyOn(db,'prepare');
    store.rememberDispatchOutcome('perf-settle',{ok:true,tool:'nexus_terminal_run'});
    const updates=prepareSpy.mock.calls.filter(([sql])=>typeof sql==='string'&&sql.startsWith('UPDATE command_receipts'));
    prepareSpy.mockRestore();
    expect(updates).toHaveLength(2);
    const saved=store.getByCommandId('perf-settle')!;
    expect(saved.dispatchState).toBe('settled');
    expect(saved.status).toBe('accepted');
    expect(saved.outcomeJson).not.toBeNull();
  });
});
