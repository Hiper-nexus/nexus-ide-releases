import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
// O hook dispara a extração do modelo de negócio em segundo plano; fora do teste.
vi.mock('../context/business-model/business-model-ensure', () => ({ ensureBusinessModel: vi.fn(async () => null) }));
import { configureAuditLogRuntime, disposeAuditLogRuntime } from '../jarvis/audit-log';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import * as settingsStore from '../persistence/settings-store';
import {
  adoptUserContextAsMissionOrchestrator, bindTokenToSession, mintToken, releaseSessionByToken,
  resetGateForTests, restoreSessionAuthority, returnOperatorHandFromEndedMission, type AgentGateContext,
} from './gate';
import { handleHookDelegateRequest } from './hook-delegate-endpoint';
import { dispatchToolCall, type McpDispatchOptions } from './mcp-dispatch';
import type { McpRegistry, McpToolDef } from './mcp-protocol';
import { configureProjectDomainStoreRegistry, disposeProjectDomainStoreRegistry } from './project-domain-store-registry';
import { buildDomainTools } from './tools-domain';
import { testProjectScope } from './__tests__/scope-fixture';

/**
 * Varredura do F-1185: o Main muda o ctx do PRÓPRIO chamador e o vínculo do
 * F-1080 não pode ler isso como revogação — sem afrouxar a revogação real.
 * Tudo pelo dispatcher real, com SQLite e gate reais.
 */
let root:string;
let manager:ProjectRuntimeManager;
let scope:ReturnType<typeof testProjectScope>;
let stores:ReturnType<typeof configureProjectDomainStoreRegistry>;
beforeEach(()=>{
  root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nexus-self-transition-')));
  manager=new ProjectRuntimeManager({baseDir:root,appVersion:'self-transition-test'});
  const stat=fs.statSync(root);
  scope=testProjectScope({projectId:'self-transition',checkoutId:'self-checkout',rootRealPath:root,workspaceRootDevice:String(stat.dev),workspaceRootInode:String(stat.ino)});
  configureAuditLogRuntime(manager);stores=configureProjectDomainStoreRegistry(manager);resetGateForTests();
});
afterEach(async()=>{
  vi.restoreAllMocks();
  resetGateForTests();await disposeProjectDomainStoreRegistry();await disposeAuditLogRuntime();manager.closeAll();
  fs.rmSync(root,{recursive:true,force:true});
});

function operatorPane(sessionId:string){
  const ctx=mintToken({label:sessionId,role:'user',scope,executionScope:scope,providerId:'codex',allowedTools:null,allowedSkills:null});
  bindTokenToSession(ctx.token,sessionId);return ctx;
}
const runningMission=()=>{const missions=stores.forScope(scope).missions;const created=missions.create({title:'Missão da aba'});return missions.update(created.id,{status:'running'})??created;};
/** Efeito irmão do mesmo pane, parado no meio do handler até ser solto. */
function parkedSibling(){
  let release!:()=>void;let entered!:()=>void;
  const hold=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
  const tool:McpToolDef={name:'nexus_terminal_run',description:'sibling effect parked mid-flight',inputSchema:{type:'object'},
    handler:async(_a,c,invocation)=>{invocation?.assertCurrentAuthority?.();entered();await hold;invocation?.assertCurrentAuthority?.();return {role:c.role,missionId:c.missionId??null};}};
  return {tool,started,release};
}
const quickEffect:McpToolDef={name:'nexus_file_write',description:'effect with a checkpoint',inputSchema:{type:'object'},
  handler:async(_a,c,invocation)=>{invocation?.assertCurrentAuthority?.();return {role:c.role,missionId:c.missionId??null,contextRevision:c.contextRevision??null};}};
const spawnLike=(adopt:(c:AgentGateContext)=>void):McpToolDef=>({name:'nexus_pane_spawn',description:'first helper of the pane',inputSchema:{type:'object'},
  handler:async(_a,c,invocation)=>{adopt(c);invocation?.reanchorAfterOwnPromotion?.();invocation?.assertCurrentAuthority?.();return {missionId:c.missionId,role:c.role};}});
const registryOf=(...tools:McpToolDef[]):McpRegistry=>({serverName:'self-transition-test',serverVersion:'0',tools});
const build={command:'npm test'};
/** Missão sem contrato congelado: fora o resolvedor de workflow, o resto é real. */
const missionOptions:McpDispatchOptions={resolveWorkflowAuthority:()=>({contextRevision:undefined,assertExecutionEffectAllowed:()=>undefined}),reserveMissionBudget:()=>undefined,confirm:async()=>true};
const strongDelegation={delegation:{parts:3,writers:2,confidence:0.84,model:'j'},writesCode:0.1};

describe('F-1204: a sibling effect of the same pane survives Main promoting that pane',()=>{
  it('the first helper (tab mission) promotes the pane while a build of the same pane is in flight',async()=>{
    const mission=runningMission();const ctx=operatorPane('operator-tab');const sibling=parkedSibling();
    const tools=registryOf(sibling.tool,spawnLike(c=>{expect(adoptUserContextAsMissionOrchestrator(c,mission.id)).toBe(true);}));
    const inFlight=dispatchToolCall('http-mcp',tools,'nexus_terminal_run',build,ctx);
    await sibling.started;
    expect(await dispatchToolCall('http-mcp',tools,'nexus_pane_spawn',{task:'helper'},ctx)).toMatchObject({ok:true,result:{missionId:mission.id,role:'orchestrator'}});
    sibling.release();
    expect(await inFlight).toMatchObject({ok:true,result:{missionId:mission.id,role:'orchestrator'}});
  });
  it('the real nexus_mission_create adopts the pane while a build of the same pane is in flight',async()=>{
    const ctx=operatorPane('operator-create');const sibling=parkedSibling();
    const create=buildDomainTools().find(tool=>tool.name==='nexus_mission_create')!;
    const tools=registryOf(sibling.tool,create);
    const inFlight=dispatchToolCall('http-mcp',tools,'nexus_terminal_run',build,ctx);
    await sibling.started;
    const created=await dispatchToolCall('http-mcp',tools,'nexus_mission_create',{title:'Missão do pane'},ctx);
    expect(created).toMatchObject({ok:true,result:{status:'running'}});
    const missionId=(created as {result:{id:string}}).result.id;
    expect(ctx).toMatchObject({role:'orchestrator',missionId,promotedFromUserSession:true});
    sibling.release();
    expect(await inFlight).toMatchObject({ok:true,result:{missionId,role:'orchestrator'}});
  });
  it('the /hook/delegate auto-orchestration adopts the pane while a build of the same pane is in flight',async()=>{
    const mission=runningMission();const ctx=operatorPane('operator-hook');const sibling=parkedSibling();
    const tools=registryOf(sibling.tool,quickEffect);
    const inFlight=dispatchToolCall('http-mcp',tools,'nexus_terminal_run',build,ctx);
    await sibling.started;
    const hook=await handleHookDelegateRequest(ctx,{prompt:'Implemente a tela de login, escreva os testes e revise a segurança do fluxo.'},{
      advise:async()=>strongDelegation,autopilot:()=>true,proveOperatorPrompt:()=>false,parallelBudget:()=>null,
      suggestSkill:async()=>null,routeHint:async()=>null,businessContext:async()=>null,design:()=>null,memoryBlock:()=>null,
      adoptMission:c=>adoptUserContextAsMissionOrchestrator(c as AgentGateContext,mission.id)?{missionId:mission.id,discardIfUnused:()=>{}}:null,
    });
    expect(JSON.stringify(hook.payload)).toContain('orquestrador');
    expect(ctx).toMatchObject({role:'orchestrator',missionId:mission.id,promotedFromUserSession:true});
    // O fluxo do hook não tem checkpoint: a próxima chamada do pane nasce orquestradora.
    expect(await dispatchToolCall('http-mcp',tools,'nexus_file_write',{path:'a.txt',content:'x'},ctx,missionOptions))
      .toMatchObject({ok:true,result:{role:'orchestrator',missionId:mission.id}});
    sibling.release();
    expect(await inFlight).toMatchObject({ok:true,result:{missionId:mission.id,role:'orchestrator'}});
  });

  // Nada além da adoção da mão do operador vira "transição do Main".
  it('a promotion that rides along with an attenuated allowlist is still a revocation',async()=>{
    const mission=runningMission();const ctx=operatorPane('operator-attenuated');const sibling=parkedSibling();
    const inFlight=dispatchToolCall('http-mcp',registryOf(sibling.tool),'nexus_terminal_run',build,ctx);
    await sibling.started;
    adoptUserContextAsMissionOrchestrator(ctx,mission.id);ctx.allowedTools=['nexus_file_read'];
    sibling.release();
    expect(await inFlight).toMatchObject({ok:false,error:'session_authority_revoked'});
  });
  it('a renderer rebind into a mission (not the operator-hand adoption) is still a revocation',async()=>{
    const mission=runningMission();const ctx=operatorPane('operator-rebind');const sibling=parkedSibling();
    const inFlight=dispatchToolCall('http-mcp',registryOf(sibling.tool),'nexus_terminal_run',build,ctx);
    await sibling.started;
    expect(restoreSessionAuthority('operator-rebind',{missionId:mission.id,role:'orchestrator'})).toBe(true);
    sibling.release();
    expect(await inFlight).toMatchObject({ok:false,error:'session_authority_revoked'});
  });
  it('handing the pane back to the operator (demotion) is still a revocation for the orchestrator call in flight',async()=>{
    const mission=runningMission();const ctx=operatorPane('operator-demoted');adoptUserContextAsMissionOrchestrator(ctx,mission.id);
    const sibling=parkedSibling();
    const inFlight=dispatchToolCall('http-mcp',registryOf(sibling.tool),'nexus_terminal_run',build,ctx,missionOptions);
    await sibling.started;
    expect(returnOperatorHandFromEndedMission(ctx)).toBe(true);
    sibling.release();
    expect(await inFlight).toMatchObject({ok:false,error:'session_authority_revoked'});
  });
  it('a released pane is still revoked even if it was promoted first',async()=>{
    const mission=runningMission();const ctx=operatorPane('operator-released');const sibling=parkedSibling();
    const inFlight=dispatchToolCall('http-mcp',registryOf(sibling.tool),'nexus_terminal_run',build,ctx);
    await sibling.started;
    adoptUserContextAsMissionOrchestrator(ctx,mission.id);releaseSessionByToken(ctx.token);
    sibling.release();
    expect(await inFlight).toMatchObject({ok:false,error:'session_authority_revoked'});
  });
});

describe('F-1185 sweep: Main transitions of the caller inside its own dispatch are not revocations',()=>{
  it('bindContextRevision: the dispatcher binding the frozen revision of a legacy contract does not revoke the handler',async()=>{
    const mission=runningMission();
    const ctx=mintToken({label:'maestro',role:'orchestrator',missionId:mission.id,scope,providerId:'codex',allowedTools:null,allowedSkills:null});
    bindTokenToSession(ctx.token,'maestro-frozen');
    const options:McpDispatchOptions={...missionOptions,resolveWorkflowAuthority:()=>({contextRevision:'rev-frozen-1',assertExecutionEffectAllowed:()=>undefined})};
    expect(await dispatchToolCall('http-mcp',registryOf(quickEffect),'nexus_file_write',{path:'a.txt',content:'x'},ctx,options))
      .toMatchObject({ok:true,result:{role:'orchestrator',missionId:mission.id,contextRevision:'rev-frozen-1'}});
  });
  it('returnOperatorHandFromEndedMission: the dispatcher handing back the pane of an ended mission does not revoke the handler',async()=>{
    const mission=runningMission();const ctx=operatorPane('operator-ended');adoptUserContextAsMissionOrchestrator(ctx,mission.id);
    stores.forScope(scope).missions.setStatus(mission.id,'failed');
    expect(await dispatchToolCall('http-mcp',registryOf(quickEffect),'nexus_file_write',{path:'a.txt',content:'x'},ctx))
      .toMatchObject({ok:true,result:{role:'user',missionId:null}});
  });
  it.each(['operator-choice','governed'] as const)('nexus_mission_create (%s): the adoption inside the real handler does not revoke it',async(policy)=>{
    const settings=settingsStore.getOrchSettings();
    vi.spyOn(settingsStore,'getOrchSettings').mockReturnValue({...settings,squadCliPolicy:policy});
    const ctx=operatorPane(`creator-${policy}`);
    const create=buildDomainTools().find(tool=>tool.name==='nexus_mission_create')!;
    const created=await dispatchToolCall('http-mcp',registryOf(create),'nexus_mission_create',{title:'Missão do pane'},ctx);
    expect(created).toMatchObject({ok:true,result:{status:policy==='governed'?'pending':'running'}});
    expect(ctx).toMatchObject({role:'orchestrator',missionId:(created as {result:{id:string}}).result.id,promotedFromUserSession:true});
  });
});
