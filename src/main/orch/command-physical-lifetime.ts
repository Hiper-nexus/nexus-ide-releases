import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import type { McpToolInvocation } from './mcp-protocol';
import { CommandReceiptStore } from './command-receipts';
import { EffectOutboxStore } from './effect-outbox';
import { ScopedStoreBinding } from './scoped-store';

/** Main-only capability. Only terminal/bg consumers call it before owned
 * preparation; JSON/RPC arguments cannot supply proof or reconstruct a lease. */
export function createOwnedProcessLifetimeRegistration(
  manager: ProjectRuntimeManager, scope: ProjectExecutionScope,
  commandId: string, bindingDigest: string, toolName: string,
  assertCurrent: () => void,
): NonNullable<McpToolInvocation['beginOwnedProcess']> {
  const binding=new ScopedStoreBinding(manager,scope);
  let started=false;
  return ()=>{
    assertCurrent();
    if(started)throw new Error('owned process lifetime already registered');
    const lease=binding.acquireLease();
    const receipts=new CommandReceiptStore(manager,binding.scope);
    try{receipts.beginPhysicalDispatch(new EffectOutboxStore(manager,binding.scope),commandId,bindingDigest,toolName);}
    catch(error){lease.release();throw error;}
    started=true;
    let bound=false;
    const record=(proof:'proven'|'unknown')=>{
      try{receipts.recordPhysicalDispatchProof(commandId,bindingDigest,proof);}
      catch{console.warn('[command-physical-lifetime] physical proof recording unavailable');}
      finally{lease.release();}
    };
    return Object.freeze({
      observeExit(exit:Promise<void>){
        if(bound)throw new Error('owned exit already bound');bound=true;
        // Logical timeout/revocation does not cancel this exit fact observer.
        void exit.then(()=>record('proven'),()=>record('unknown'));
      },
      preparationFailed(){if(!bound){bound=true;record('unknown');}},
    });
  };
}
