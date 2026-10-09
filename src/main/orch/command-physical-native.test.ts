import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll,afterEach,beforeAll,beforeEach,expect,it,vi } from 'vitest';
import { configureAuditLogRuntime,disposeAuditLogRuntime } from '../jarvis/audit-log';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { configureProjectDomainStoreRegistry,disposeProjectDomainStoreRegistry } from './project-domain-store-registry';
import { mintToken,bindTokenToSession,resetGateForTests } from './gate';
import { dispatchToolCall } from './mcp-dispatch';
import { buildTerminalTools } from './tools-terminal';
import { buildBgTools } from './tools-bg';
import { CommandReceiptStore } from './command-receipts';
import { EffectOutboxStore } from './effect-outbox';
import { drainEffectOutbox,registerDispatchPhysicalSettlementHandler } from './effect-outbox-worker';
import { testProjectScope } from './__tests__/scope-fixture';
import { processSandboxRuntimeAvailable } from '../runtime/process-sandbox-capability';
import { setPtyHost } from '../pty/pty-manager';
import { supervisedJobCommand } from '../pty/darwin-pty-supervisor';
import { buildTestDarwinPtySupervisor } from '../../test/darwin-pty-supervisor-fixture';
let root:string;let manager:ProjectRuntimeManager;let scope:ReturnType<typeof testProjectScope>;let ctx:ReturnType<typeof mintToken>;
let supervisor:ReturnType<typeof buildTestDarwinPtySupervisor>|undefined;
beforeAll(()=>{if(process.platform==='darwin'){supervisor=buildTestDarwinPtySupervisor();setPtyHost({spawn:()=>{throw new Error('native command proof allocates no PTY');},prepareCommandSupervisor:async(file,args)=>supervisedJobCommand(supervisor!.runtime,file,args)});}},60000);
afterAll(()=>{supervisor?.dispose();});
beforeEach(()=>{root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nexus-dispatch-native-')));const st=fs.statSync(root);scope=testProjectScope({rootRealPath:root,workspaceRootDevice:String(st.dev),workspaceRootInode:String(st.ino)});manager=new ProjectRuntimeManager({baseDir:path.join(root,'runtime'),appVersion:'native-dispatch-test'});configureAuditLogRuntime(manager);configureProjectDomainStoreRegistry(manager);resetGateForTests();ctx=mintToken({label:'native-owned',role:'user',scope,allowedTools:null,allowedSkills:null});bindTokenToSession(ctx.token,'native-owned-session');});
afterEach(async()=>{resetGateForTests();await disposeProjectDomainStoreRegistry();await disposeAuditLogRuntime();manager.closeAll();fs.rmSync(root,{recursive:true,force:true});});
const native=it.runIf(processSandboxRuntimeAvailable());
native('F-1082: actual sandbox/native supervisor terminal tree exit settles the receipt through production verifier',async()=>{
  const result=await dispatchToolCall('http-mcp',{serverName:'native',serverVersion:'0',tools:buildTerminalTools()},'nexus_terminal_run',{command:'(sleep 0.1; printf native-child-proof) & wait',timeoutMs:5000},ctx,{confirm:async()=>true});
  expect(result,JSON.stringify(result)).toMatchObject({ok:true,result:{exitCode:0,stdout:expect.stringContaining('native-child-proof')}});
  const receipts=new CommandReceiptStore(manager,scope);const row=receipts.listUnsettledMetadata().rows[0];expect(row).toMatchObject({physicalState:'proven',resultSequence:0});
  const unregister=registerDispatchPhysicalSettlementHandler(()=>manager);
  try{expect((await drainEffectOutbox({store:new EffectOutboxStore(manager,scope),scope,workerId:'native-verifier'})).succeeded).toBe(1);expect(receipts.countUnsettled()).toBe(0);
    expect(JSON.stringify(manager.open(scope).db.prepare('SELECT outcome_json FROM command_receipts').all())).not.toContain('native-child-proof');
  }finally{unregister();}
},15000);
native('F-1082: actual background launch acknowledgment remains blocking until native owned tree exit',async()=>{
  const result=await dispatchToolCall('http-mcp',{serverName:'native-bg',serverVersion:'0',tools:buildBgTools()},'nexus_bg_run',{command:'sleep 0.3; printf native-bg-proof',sandboxProfile:'workspace-only'},ctx,{confirm:async()=>true});
  expect(result,JSON.stringify(result)).toMatchObject({ok:true,result:{taskId:expect.any(String)}});
  const receipts=new CommandReceiptStore(manager,scope);expect(receipts.listUnsettledMetadata().rows[0]).toMatchObject({physicalState:'pending',resultSequence:0});
  expect(new EffectOutboxStore(manager,scope).listUnsettledBlocking(scope.projectId).rows).toHaveLength(1);
  await vi.waitFor(()=>expect(receipts.listUnsettledMetadata().rows[0]?.physicalState).toBe('proven'),{timeout:5000});
  const unregister=registerDispatchPhysicalSettlementHandler(()=>manager);
  try{expect((await drainEffectOutbox({store:new EffectOutboxStore(manager,scope),scope,workerId:'native-bg-verifier'})).succeeded).toBe(1);expect(receipts.countUnsettled()).toBe(0);}finally{unregister();}
},15000);
native('F-1088: actual dispatcher accepts advertised workspace-only profile and rejects an unknown enum before effect',async()=>{
  const registry={serverName:'native-profile',serverVersion:'0',tools:buildTerminalTools()};
  expect(await dispatchToolCall('http-mcp',registry,'nexus_terminal_run',{command:'printf native-profile-contract',sandboxProfile:'unrestricted'},ctx)).toMatchObject({ok:false,error:expect.stringContaining('invalid arguments')});
  expect(manager.open(scope).db.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toEqual({n:0});
  const result=await dispatchToolCall('http-mcp',registry,'nexus_terminal_run',{command:'printf native-profile-contract',sandboxProfile:'workspace-only'},ctx,{confirm:async()=>true});
  expect(result,JSON.stringify(result)).toMatchObject({ok:true,result:{exitCode:0,stdout:'native-profile-contract'}});
  const unregister=registerDispatchPhysicalSettlementHandler(()=>manager);
  try{expect((await drainEffectOutbox({store:new EffectOutboxStore(manager,scope),scope,workerId:'profile-verifier'})).succeeded).toBe(1);}finally{unregister();}
},15000);
