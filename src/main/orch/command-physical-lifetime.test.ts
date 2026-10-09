import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect,it } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { CommandReceiptStore } from './command-receipts';
import { createOwnedProcessLifetimeRegistration } from './command-physical-lifetime';
import { testProjectScope } from './__tests__/scope-fixture';
it('physical lease pins exact runtime across logical end and releases only after proof or uncertainty',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-physical-lease-'));const scope=testProjectScope({rootRealPath:root});const manager=new ProjectRuntimeManager({baseDir:root,appVersion:'lease-test'});const binding='c'.repeat(64);
  let release!:()=>void;const exit=new Promise<void>(r=>{release=r;});
  try{const receipts=new CommandReceiptStore(manager,scope);receipts.acceptDispatchObservation({commandId:'pinned',toolName:'nexus_terminal_run',projectId:scope.projectId,bindingDigest:binding,generated:true});
    const begin=createOwnedProcessLifetimeRegistration(manager,scope,'pinned',binding,'nexus_terminal_run',()=>{});const registration=begin();registration.observeExit(exit);
    expect(()=>manager.close(scope)).toThrow(/lease|use|pinned/i);expect(()=>begin()).toThrow(/already/);expect(()=>registration.observeExit(exit)).toThrow(/already/);
    release();await exit;await Promise.resolve();expect(receipts.getByCommandId('pinned')?.physicalState).toBe('proven');expect(manager.close(scope)).toBe(true);
  }finally{release();manager.closeAll();fs.rmSync(root,{recursive:true,force:true});}
});
