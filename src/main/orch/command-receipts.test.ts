import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    const store=new CommandReceiptStore(legacy,scope);
    store.insertIfAbsent({commandId:'old',commandType:'checkpoint.capture',projectId:scope.projectId});
    legacy.open(scope).db.prepare('UPDATE command_receipts SET outcome_json=? WHERE command_id=?').run('{"privateBody":"legacy-secret"}','old');legacy.closeAll();
    expect(new CommandReceiptStore(manager,scope).getByCommandId('old')?.outcomeJson).toBeNull();
  });
});
