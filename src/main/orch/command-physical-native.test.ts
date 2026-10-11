import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll,afterEach,beforeAll,beforeEach,expect,it,vi } from 'vitest';
import { configureAuditLogRuntime,disposeAuditLogRuntime } from '../jarvis/audit-log';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { configureProjectDomainStoreRegistry,disposeProjectDomainStoreRegistry,getProjectDomainStores } from './project-domain-store-registry';
import { configureContextWorkflowRegistry,disposeContextWorkflowRegistry } from '../context/context-workflow-registry';
import { mintToken,bindTokenToSession,resetGateForTests } from './gate';
import { dispatchToolCall } from './mcp-dispatch';
import { buildTerminalTools } from './tools-terminal';
import { buildBgTools } from './tools-bg';
import { buildDomainTools } from './tools-domain';
import { reconcileProviderRuntimeAtBoot } from './provider-runtime-recovery';
import * as ownedCommand from './owned-command-launch';
import { CommandReceiptStore } from './command-receipts';
import { EffectOutboxStore } from './effect-outbox';
import { drainEffectOutbox,registerDispatchPhysicalSettlementHandler } from './effect-outbox-worker';
import { testProjectScope } from './__tests__/scope-fixture';
import { processSandboxRuntimeAvailable } from '../runtime/process-sandbox-capability';
import { setPtyHost } from '../pty/pty-manager';
import { supervisedJobCommand } from '../pty/darwin-pty-supervisor';
import { buildTestDarwinPtySupervisor } from '../../test/darwin-pty-supervisor-fixture';
import { skipUnderNexusPtySupervisor } from '../../test/nested-pty-supervisor';
let root:string;let manager:ProjectRuntimeManager;let scope:ReturnType<typeof testProjectScope>;let ctx:ReturnType<typeof mintToken>;
let supervisor:ReturnType<typeof buildTestDarwinPtySupervisor>|undefined;
vi.mock('../license-access',async()=> (await import('../__tests__/licensed-access')).licensedAccessMock);
vi.mock('electron',()=>({app:{getPath:()=>os.tmpdir(),isReady:()=>true},BrowserWindow:{getAllWindows:()=>[],getFocusedWindow:()=>null},ipcMain:{handle:vi.fn(),on:vi.fn()}}));
beforeAll(()=>{if(process.platform==='darwin'){supervisor=buildTestDarwinPtySupervisor();setPtyHost({spawn:()=>{throw new Error('native command proof allocates no PTY');},prepareCommandSupervisor:async(file,args)=>supervisedJobCommand(supervisor!.runtime,file,args)});}},60000);
afterAll(()=>{supervisor?.dispose();});
beforeEach(()=>{root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nexus-dispatch-native-')));const st=fs.statSync(root);scope=testProjectScope({projectId:path.basename(root),checkoutId:path.basename(root),rootRealPath:root,workspaceRootDevice:String(st.dev),workspaceRootInode:String(st.ino)});manager=new ProjectRuntimeManager({baseDir:path.join(root,'runtime'),appVersion:'native-dispatch-test'});configureAuditLogRuntime(manager);configureProjectDomainStoreRegistry(manager);configureContextWorkflowRegistry(manager,{appVersion:'native-dispatch-test'});resetGateForTests();ctx=mintToken({label:'native-owned',role:'user',scope,allowedTools:null,allowedSkills:null});bindTokenToSession(ctx.token,'native-owned-session');});
afterEach(async()=>{resetGateForTests();disposeContextWorkflowRegistry();await disposeProjectDomainStoreRegistry();await disposeAuditLogRuntime();manager.closeAll();fs.rmSync(root,{recursive:true,force:true});});
const native=it.runIf(processSandboxRuntimeAvailable());
native('F-1082: actual sandbox/native supervisor terminal tree exit settles the receipt through production verifier',async(testContext)=>{skipUnderNexusPtySupervisor(testContext);
  const result=await dispatchToolCall('http-mcp',{serverName:'native',serverVersion:'0',tools:buildTerminalTools()},'nexus_terminal_run',{command:'(sleep 0.1; printf native-child-proof) & wait',timeoutMs:5000},ctx,{confirm:async()=>true});
  expect(result,JSON.stringify(result)).toMatchObject({ok:true,result:{exitCode:0,stdout:expect.stringContaining('native-child-proof')}});
  const receipts=new CommandReceiptStore(manager,scope);const row=receipts.listUnsettledMetadata().rows[0];expect(row).toMatchObject({physicalState:'proven',resultSequence:0});
  const unregister=registerDispatchPhysicalSettlementHandler(()=>manager);
  try{expect((await drainEffectOutbox({store:new EffectOutboxStore(manager,scope),scope,workerId:'native-verifier'})).succeeded).toBe(1);expect(receipts.countUnsettled()).toBe(0);
    expect(JSON.stringify(manager.open(scope).db.prepare('SELECT outcome_json FROM command_receipts').all())).not.toContain('native-child-proof');
  }finally{unregister();}
},15000);
native('F-1082: actual background launch acknowledgment remains blocking until native owned tree exit',async(testContext)=>{skipUnderNexusPtySupervisor(testContext);
  const result=await dispatchToolCall('http-mcp',{serverName:'native-bg',serverVersion:'0',tools:buildBgTools()},'nexus_bg_run',{command:'sleep 0.3; printf native-bg-proof',sandboxProfile:'workspace-only'},ctx,{confirm:async()=>true});
  expect(result,JSON.stringify(result)).toMatchObject({ok:true,result:{taskId:expect.any(String)}});
  const receipts=new CommandReceiptStore(manager,scope);expect(receipts.listUnsettledMetadata().rows[0]).toMatchObject({physicalState:'pending',resultSequence:0});
  expect(new EffectOutboxStore(manager,scope).listUnsettledBlocking(scope.projectId).rows).toHaveLength(1);
  await vi.waitFor(()=>expect(receipts.listUnsettledMetadata().rows[0]?.physicalState).toBe('proven'),{timeout:5000});
  const unregister=registerDispatchPhysicalSettlementHandler(()=>manager);
  try{expect((await drainEffectOutbox({store:new EffectOutboxStore(manager,scope),scope,workerId:'native-bg-verifier'})).succeeded).toBe(1);expect(receipts.countUnsettled()).toBe(0);}finally{unregister();}
},15000);
native('F-1088: actual dispatcher accepts advertised workspace-only profile and rejects an unknown enum before effect',async(testContext)=>{skipUnderNexusPtySupervisor(testContext);
  const registry={serverName:'native-profile',serverVersion:'0',tools:buildTerminalTools()};
  expect(await dispatchToolCall('http-mcp',registry,'nexus_terminal_run',{command:'printf native-profile-contract',sandboxProfile:'unrestricted'},ctx)).toMatchObject({ok:false,error:expect.stringContaining('invalid arguments')});
  expect(manager.open(scope).db.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toEqual({n:0});
  const result=await dispatchToolCall('http-mcp',registry,'nexus_terminal_run',{command:'printf native-profile-contract',sandboxProfile:'workspace-only'},ctx,{confirm:async()=>true});
  expect(result,JSON.stringify(result)).toMatchObject({ok:true,result:{exitCode:0,stdout:'native-profile-contract'}});
  const unregister=registerDispatchPhysicalSettlementHandler(()=>manager);
  try{expect((await drainEffectOutbox({store:new EffectOutboxStore(manager,scope),scope,workerId:'profile-verifier'})).succeeded).toBe(1);}finally{unregister();}
},15000);

function completionFixture(lane:'consult'|'ops'='ops') {
  const stores=getProjectDomainStores(scope);
  const mission=stores.missions.create({title:'Controlled physical completion',intentState:'executing',intentVersion:1,
    intentContract:{version:1,source:'typed',goal:'Report the physical outcome of the controlled process.',lane,
      acceptanceCriteria:['Wait for the owned process to finish'],risk:'normal',executionMode:'autopilot',contextPolicy:'on-demand',
      approvedAt:Date.now(),dispatchedAt:Date.now(),intentVersion:1,budgets:{planningTokens:1000,executionTokens:1000,maxWorkers:1}}});
  stores.missions.update(mission.id,{status:'running',intentState:'executing'});
  stores.missions.setOrchestratorSession(mission.id,'completion-chief');
  const chief=mintToken({label:'completion-chief',role:'orchestrator',missionId:mission.id,scope,allowedTools:null,allowedSkills:null});
  bindTokenToSession(chief.token,'completion-chief');
  const registry={serverName:'normal-completion',serverVersion:'0',tools:buildDomainTools()};
  const done=()=>dispatchToolCall('http-mcp',registry,'nexus_mission_set_status',{
    missionId:mission.id,status:'done',note:'The controlled process delivered its report and its physical work has finished.',
  },chief);
  return {stores,mission,chief,done};
}

native('F-1115: normal MCP done waits for actual background owned-tree proof and durable settlement',async(testContext)=>{skipUnderNexusPtySupervisor(testContext);
  const state=completionFixture();
  const result=await dispatchToolCall('http-mcp',{serverName:'completion-bg',serverVersion:'0',tools:buildBgTools()},
    'nexus_bg_run',{command:'while [ ! -f release-bg ]; do sleep 0.05; done; printf completion-bg-proof',sandboxProfile:'workspace-only'},state.chief);
  expect(result,JSON.stringify(result)).toMatchObject({ok:true,result:{taskId:expect.any(String)}});
  const receipts=new CommandReceiptStore(manager,scope);
  const physical=receipts.listUnsettledMetadata().rows.find(row=>row.physicalState==='pending')!;
  expect(physical).toMatchObject({physicalState:'pending',resultSequence:0});
  const before=state.stores.missions.get(state.mission.id)!;
  try {
    const refused=await state.done();
    expect(refused,JSON.stringify(refused)).toMatchObject({ok:false,error:expect.stringContaining('completion_effects_pending')});
    expect(state.stores.missions.get(state.mission.id)?.status).toBe('running');
    expect(state.stores.missions.get(state.mission.id)?.result).toBeUndefined();
    expect(state.stores.missions.get(state.mission.id)?.learnings).toBe(before.learnings);
  } finally {
    fs.writeFileSync(path.join(root,'release-bg'),'release');
    await vi.waitFor(()=>expect(receipts.getByCommandId(physical.commandId)?.physicalState).toBe('proven'),{timeout:5000});
    const unregister=registerDispatchPhysicalSettlementHandler(()=>manager);
    try {expect((await drainEffectOutbox({store:new EffectOutboxStore(manager,scope),scope,workerId:'completion-native-verifier'})).succeeded).toBe(1);}
    finally {unregister();}
  }
  expect(await state.done()).toMatchObject({ok:true,result:{status:'done',result:{outcome:'success'}}});
  expect(receipts.getByCommandId(physical.commandId)).toMatchObject({physicalState:'proven',resultSequence:expect.any(Number)});
  expect(receipts.getByCommandId(physical.commandId)!.resultSequence).toBeGreaterThan(0);
  expect(new EffectOutboxStore(manager,scope).listUnsettledBlocking(state.mission.id).rows).toEqual([]);
},15000);

it('F-1115: normal MCP done refuses actual uncertain process preparation after database reopen',async()=>{
  const state=completionFixture('consult');
  const prepare=vi.spyOn(ownedCommand,'prepareOwnedCommandLaunch').mockRejectedValueOnce(new Error('controlled native preparation outcome unknown'));
  try {
    expect(await dispatchToolCall('http-mcp',{serverName:'uncertain-bg',serverVersion:'0',tools:buildBgTools()},
      'nexus_bg_run',{command:'printf uncertain',sandboxProfile:'workspace-only'},state.chief)).toMatchObject({ok:false});
  } finally {prepare.mockRestore();}
  const receipts=new CommandReceiptStore(manager,scope);
  expect(receipts.listUnsettledMetadata().rows).toMatchObject([{physicalState:'unknown',resultSequence:0}]);
  await disposeProjectDomainStoreRegistry();
  await disposeAuditLogRuntime();
  manager.closeAll();
  configureAuditLogRuntime(manager);configureProjectDomainStoreRegistry(manager);
  reconcileProviderRuntimeAtBoot({runtimeManager:manager,scope});
  expect(receipts.listUnsettledMetadata().rows[0]).toMatchObject({physicalState:'unknown',resultSequence:0});
  expect(await state.done()).toMatchObject({ok:false,error:expect.stringContaining('completion_effects_pending')});
  expect(getProjectDomainStores(scope).missions.get(state.mission.id)).toMatchObject({status:'running'});
  expect(getProjectDomainStores(scope).missions.get(state.mission.id)?.result).toBeUndefined();
  expect(receipts.listUnsettledMetadata().rows[0]).toMatchObject({physicalState:'unknown',resultSequence:0});
});

it('F-1115: normal MCP done refuses a queued handoff and preserves another mission queue',async()=>{
  const state=completionFixture('consult');
  const queued=state.stores.handoffs.submit({missionId:state.mission.id,sessionId:'worker-awaiting-delivery',fromAgent:'worker',status:'success',summary:'The worker result is still waiting for its actual delivery.'});
  const other=state.stores.missions.create({title:'Another mission'});
  const foreign=state.stores.handoffs.submit({missionId:other.id,sessionId:'another-worker',fromAgent:'worker',status:'success',summary:'Other mission delivery remains queued.'});
  expect(await state.done()).toMatchObject({ok:false,error:expect.stringContaining('completion_effects_pending')});
  expect(state.stores.missions.get(state.mission.id)?.status).toBe('running');
  expect(state.stores.missions.get(state.mission.id)?.result).toBeUndefined();
  expect(state.stores.handoffs.markSubmitted(queued.id)).toBe(true);
  expect(await state.done()).toMatchObject({ok:true,result:{status:'done'}});
  expect(state.stores.handoffs.listQueuedDeliveries(other.id).map(row=>row.id)).toEqual([foreign.id]);
});
