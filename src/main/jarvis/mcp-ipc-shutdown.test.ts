import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach,beforeEach,expect,it,vi,type MockInstance } from 'vitest';
const h=vi.hoisted(()=>({handlers:new Map<string,(event:unknown,raw:unknown)=>Promise<unknown>>(),handler:vi.fn(),dialog:vi.fn()}));
vi.mock('electron',()=>({ipcMain:{handle:(channel:string,callback:(event:unknown,raw:unknown)=>Promise<unknown>)=>h.handlers.set(channel,callback)},dialog:{showMessageBox:h.dialog}}));
vi.mock('../orch/tools',async importOriginal=>{
  const original=await importOriginal<typeof import('../orch/tools')>();
  return {...original,buildToolset:()=>{
    const tools=original.buildToolset();const tool=tools.find(t=>t.name==='nexus_git_sync')!;const handler=tool.handler;
    tool.handler=(...args)=>{h.handler(...args);return handler(...args);};return tools;
  }};
});
import { MCP_CHANNELS } from '../../shared/channels';
import { bindResolvedRendererWorkspaceScope,clearRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { ProcessGitRunner } from '../runtime/git-command';
import { configureAuditLogRuntime,disposeAuditLogRuntime } from './audit-log';
import { configureProjectDomainStoreRegistry,disposeProjectDomainStoreRegistry } from '../orch/project-domain-store-registry';
import { isRuntimeProcessAdmissionSealedForShutdown,runtimeProcessAdmissionAbortSignal,sealRuntimeProcessAdmissionForShutdown } from '../runtime-process-inventory';
import { terminateAllSessions,__resetPtyShutdownLifecycleForTests } from '../pty/pty-manager';
import { registerMcpInvokeIpc,invokeMcpTool,confirmMcpTool,clearMcpRendererSession } from './mcp-ipc';
import * as permissions from './permissions';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
let root:string;let manager:ProjectRuntimeManager;let scope:ReturnType<typeof testProjectScope>;
const sender=Object.assign(new EventEmitter(),{id:1090,isDestroyed:()=>false,isCrashed:()=>false});
let git:MockInstance<ProcessGitRunner['run']>;
function rows(){const db=manager.open(scope).db;return {receipts:(db.prepare('SELECT COUNT(*) AS n FROM command_receipts').get() as {n:number}).n,effects:(db.prepare('SELECT COUNT(*) AS n FROM effect_outbox').get() as {n:number}).n};}
beforeEach(()=>{
  root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nexus-ipc-quit-')));const st=fs.statSync(root);scope=testProjectScope({rootRealPath:root,workspaceRootDevice:String(st.dev),workspaceRootInode:String(st.ino)});
  manager=new ProjectRuntimeManager({baseDir:path.join(root,'runtime'),appVersion:'ipc-quit-test'});configureAuditLogRuntime(manager);configureProjectDomainStoreRegistry(manager);bindResolvedRendererWorkspaceScope(sender,scope);clearMcpRendererSession();permissions.clearAll();h.handler.mockClear();h.handlers.clear();h.dialog.mockReset();registerMcpInvokeIpc();
  // Actual Git MCP handler with controlled native sink: no external Git/network/repo mutation.
  git=vi.spyOn(ProcessGitRunner.prototype,'run').mockImplementation((_cwd,args)=>({status:0,stdout:args[0]==='rev-parse'?'HEAD':'',stderr:''}));
});
afterEach(async()=>{vi.restoreAllMocks();clearRendererWorkspaceScope(sender);await disposeProjectDomainStoreRegistry();await disposeAuditLogRuntime();manager.closeAll();await terminateAllSessions();__resetPtyShutdownLifecycleForTests();fs.rmSync(root,{recursive:true,force:true});});
const request=()=>({tool:'nexus_git_sync',args:{cwd:root}});
it('F-1090: open current renderer can reach actual Git sync; sealed after domain dispose executes no handler/Git/receipt/effect',async()=>{
  const invoke=h.handlers.get(MCP_CHANNELS.invoke)!;
  expect(await invoke({sender},request())).toMatchObject({ok:true});expect(h.handler).toHaveBeenCalledOnce();expect(git).toHaveBeenCalled();
  manager.open(scope).db.prepare('DELETE FROM command_receipts').run();h.handler.mockClear();git.mockClear();
  sealRuntimeProcessAdmissionForShutdown();await disposeProjectDomainStoreRegistry();
  expect(sender.isDestroyed()).toBe(false);expect(sender.isCrashed()).toBe(false);
  expect(await invoke({sender},request())).toMatchObject({ok:false,denied:true});
  expect(h.handler).not.toHaveBeenCalled();expect(git).not.toHaveBeenCalled();expect(rows()).toEqual({receipts:0,effects:0});
  expect(await invokeMcpTool(request(),scope)).toMatchObject({ok:false,denied:true});expect(git).not.toHaveBeenCalled();
});
it('F-1090: call queued before seal is refused before handler after its dispatch await',async()=>{
  const pending=h.handlers.get(MCP_CHANNELS.invoke)!({sender},request());sealRuntimeProcessAdmissionForShutdown();
  expect(await pending).toMatchObject({ok:false,denied:true});expect(h.handler).not.toHaveBeenCalled();expect(git).not.toHaveBeenCalled();expect(rows()).toEqual({receipts:0,effects:0});
});
it('F-1090: shutdown signal reaches actual Git internal await boundary and prevents following commands',async()=>{
  git.mockImplementation((_cwd,args)=>{
    if(args[0]==='rev-parse')queueMicrotask(sealRuntimeProcessAdmissionForShutdown);
    return {status:0,stdout:args[0]==='rev-parse'?'main':'',stderr:''};
  });
  expect(await h.handlers.get(MCP_CHANNELS.invoke)!({sender},request())).toMatchObject({ok:false});
  expect(h.handler).toHaveBeenCalledOnce();expect(git.mock.calls.filter(([,args])=>args[0]==='status'||args[0]==='fetch'||args[0]==='merge')).toEqual([]);
});
it('F-1090: native confirmation pending at seal cannot grant permission afterward',async()=>{
  let finish!:(value:{response:number})=>void;h.dialog.mockImplementation(()=>new Promise(r=>{finish=r;}));
  const grant=vi.spyOn(permissions,'grantPermission');
  const pending=confirmMcpTool({tool:'nexus_ui_action',args:{action:'click',ref:'u1e1'}},scope);
  expect(h.dialog).toHaveBeenCalledOnce();sealRuntimeProcessAdmissionForShutdown();finish({response:1});
  expect(await pending).toMatchObject({ok:false});expect(grant).not.toHaveBeenCalled();
  h.dialog.mockClear();
  expect(await confirmMcpTool({tool:'nexus_ui_action',args:{action:'click',ref:'u1e1'}},scope)).toMatchObject({ok:false,error:'app_shutdown'});
  expect(h.dialog).not.toHaveBeenCalled();expect(grant).not.toHaveBeenCalled();
});

it('F-1090: native seal is sticky and existing guarded reset cannot reopen unproven admission',async()=>{
  const old=runtimeProcessAdmissionAbortSignal();expect(isRuntimeProcessAdmissionSealedForShutdown()).toBe(false);expect(old.aborted).toBe(false);
  sealRuntimeProcessAdmissionForShutdown();sealRuntimeProcessAdmissionForShutdown();
  expect(isRuntimeProcessAdmissionSealedForShutdown()).toBe(true);expect(old.aborted).toBe(true);
  expect(()=>__resetPtyShutdownLifecycleForTests()).toThrow(/active physical authority/);
  await terminateAllSessions();__resetPtyShutdownLifecycleForTests();
  expect(old.aborted).toBe(true);expect(runtimeProcessAdmissionAbortSignal()).not.toBe(old);expect(runtimeProcessAdmissionAbortSignal().aborted).toBe(false);
});
