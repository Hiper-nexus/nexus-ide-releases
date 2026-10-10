import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import type { Squad } from '../../shared/orch-types';
const h=vi.hoisted(()=>({auth:async()=>{},prepare:async(options:{prompt?:string;role?:string})=>options.prompt,physical:new Map<string,OwnedAgentSessionInfo>(),spawn:vi.fn(),terminate:vi.fn(async()=>true),deliver:vi.fn(async()=>true),warm:vi.fn(async()=>{}),squad:null as Squad|null}));
vi.mock('../pty/pre-spawn-probe',async importOriginal=>({...await importOriginal<typeof import('../pty/pre-spawn-probe')>(),assertPreSpawnProbe:()=>h.auth()}));
vi.mock('../adapters/adapter-registry',async importOriginal=>({...await importOriginal<typeof import('../adapters/adapter-registry')>(),getAdapter:(id:string)=>({id,label:id,kind:'cli-pty',bin:'codex',auth:{method:'api-key'},quirks:{nexusMcp:'codex'},env:{passthrough:[]},spawn:{}})}));
vi.mock('./squad-runtime-inventory',()=>({warmSquadRuntimeSubscriptionAuth:h.warm}));
vi.mock('../persistence/provider-config-store',async importOriginal=>({...await importOriginal<typeof import('../persistence/provider-config-store')>(),listProviderSettings:()=>[],providerAuthStrategy:()=> 'api-key',hasRuntimeKey:()=>true}));
vi.mock('../adapters/subscription-auth',async importOriginal=>({...await importOriginal<typeof import('../adapters/subscription-auth')>(),detectSubscriptionAuthReadiness:()=> 'present'}));
vi.mock('./squad-store',()=>({getSquad:()=>h.squad,listSquads:()=>h.squad?[h.squad]:[]}));
vi.mock('../pty/pty-manager',async importOriginal=>({...await importOriginal<typeof import('../pty/pty-manager')>(),getSessionState:(id:string)=>h.physical.has(id)?'idle':null,getAgentSessionInfo:(id:string)=>h.physical.get(id)??null,listAgentSessions:()=>[...h.physical.values()],registeredOrchestratorSessionsForMission:(id:string)=>[...h.physical.values()].filter(s=>s.missionId===id&&s.role==='orchestrator').map(s=>({sessionId:s.sessionId,state:'idle',adapterId:s.adapterId})),isPtySessionConnectedAndWritable:(id:string)=>h.physical.has(id),orchTerminateSession:h.terminate}));
vi.mock('./pane-registry',async importOriginal=>({...await importOriginal<typeof import('./pane-registry')>(),listPaneSnapshots:()=>[...h.physical.values()].map(s=>({...s,state:'idle'})),requestPaneSpawn:h.spawn,getPaneRuntimeAuthorityBySession:(id:string)=>{const info=h.physical.get(id);return info?{sessionId:id,paneId:info.paneId,kind:'cli-agent',missionId:info.missionId,role:info.role,scope:info.coordinationScope??info.scope,owner:null}:null;}}));
vi.mock('./tool-util',async importOriginal=>({...await importOriginal<typeof import('./tool-util')>(),withProjectContextBlocksAsync:(options:{prompt?:string;role?:string})=>h.prepare(options),deliverAgentPrompt:h.deliver,proveNativeArgvBriefAccepted:async()=>true}));
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { configureProjectDomainStoreRegistry,disposeProjectDomainStoreRegistry,getProjectDomainStores } from './project-domain-store-registry';
import { createScopedMissionStore } from './mission-store';
import { resolveMissionPaneAuthoritySeal } from './mission-pane-authority';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import { reserveOrchestratorAdoption,resetOrchestratorAdoptionsForTest,clearOrchestratorAdoption } from './orchestrator-adoption';
import { mintToken,bindTokenToSession,getContextBySession,resetGateForTests } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
import './mission-engine-production'; // Actual Main engine lifecycle CAS, not a fake blocker.
import { fastLaneBootstrap } from './mission-fast-lane';
let root:string;let manager:ProjectRuntimeManager;let scope:ReturnType<typeof testProjectScope>;
beforeEach(()=>{vi.useFakeTimers();root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nexus-bootstrap-owner-')));const st=fs.statSync(root);scope=testProjectScope({projectId:'project-'+path.basename(root),checkoutId:'checkout-'+path.basename(root),rootRealPath:root,workspaceRootDevice:String(st.dev),workspaceRootInode:String(st.ino)});manager=new ProjectRuntimeManager({baseDir:path.join(root,'runtime'),appVersion:'bootstrap-owner-test'});configureProjectDomainStoreRegistry(manager);resetGateForTests();resetOrchestratorAdoptionsForTest();h.physical.clear();h.terminate.mockClear();h.spawn.mockReset().mockResolvedValue({ok:false,requestId:'fixture',error:'controlled spawn not allocated'});h.deliver.mockClear();h.warm.mockClear();h.auth=async()=>{};h.prepare=async options=>options.prompt;h.squad={id:'bootstrap-team',name:'Bootstrap team',createdAt:'1',builtin:false,orchestratorInstructions:'',agents:[{id:'leader',agentName:'Coordinator',category:'orchestrator',cli:'codex',instructions:'Execute somente o escopo aprovado.'},{id:'worker',agentName:'Worker',category:'executor',cli:'codex',instructions:'Execute somente o escopo aprovado.'}]};});
afterEach(async()=>{resetOrchestratorAdoptionsForTest();resetGateForTests();h.physical.clear();vi.clearAllTimers();vi.useRealTimers();await disposeProjectDomainStoreRegistry();manager.closeAll();fs.rmSync(root,{recursive:true,force:true});});
function setup(){
  const seed=createScopedMissionStore(manager,scope,{assertCreateAccess:()=>{}});
  const mission=seed.create({title:'Pergunte aos panes quanto é 2 + 2.',squadId:h.squad!.id,intentState:'ready_to_start',intentVersion:1,intentContract:{version:1,source:'typed',goal:'Pergunte aos panes quanto é 2 + 2.',acceptanceCriteria:['Respostas'],risk:'normal',executionMode:'autopilot',contextPolicy:'on-demand',intentVersion:1,approvedAt:Date.now(),dispatchedAt:Date.now(),squadRevisionHash:snapshotSquadAuthority(h.squad!).hash,orchestratorRuntime:{adapterId:'codex',readOnly:false,nativeReadOnly:false},budgets:{planningTokens:1000,executionTokens:1000,maxWorkers:2}}});
  const ctx=mintToken({label:'operator',role:'user',scope,readOnly:false,allowedTools:null,allowedSkills:null});bindTokenToSession(ctx.token,'operator-owned');
  h.physical.set('operator-owned',{sessionId:'operator-owned',paneId:'operator-pane',adapterId:'codex',scope,cwd:root,source:'persisted-pane',role:'user',readOnly:false,nativeReadOnly:false,allowedTools:null,allowedSkills:null});
  reserveOrchestratorAdoption({missionId:mission.id,paneId:'operator-pane',sessionId:'operator-owned',adapterId:'codex',expiresAt:Date.now()+60000,grantAuthority:()=>{ctx.role='orchestrator';ctx.missionId=mission.id;Object.assign(h.physical.get(ctx.sessionId!)!,{role:'orchestrator',missionId:mission.id});getProjectDomainStores(scope).missions.setOrchestratorSession(mission.id,ctx.sessionId!);return true;}});
  return mission;
}
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}
it('F-1093: revoked auth preparation leaves pending with no wave/kill',async()=>{
  const mission=setup();let release!:()=>void;h.auth=()=>new Promise<void>(r=>{release=r;});let revoked=false;
  const start=fastLaneBootstrap(scope,mission.id,{invocation:{assertCurrentAuthority:()=>{if(revoked)throw new Error('session_authority_revoked');}}});await flush();revoked=true;release();
  await expect(start).rejects.toThrow(/session_authority_revoked/);expect(getProjectDomainStores(scope).missions.get(mission.id)).toMatchObject({status:'pending',intentState:'ready_to_start'});expect(h.spawn).not.toHaveBeenCalled();expect(h.terminate).not.toHaveBeenCalled();
});
it.each([true,false] as const)('F-1093: revoke after owned running/adoption context wait blocks own row and never starts helpers (await=%s)',async(waitForFirstPane)=>{
  const mission=setup();let release!:()=>void;let entered!:()=>void;let revoked=false;const ready=new Promise<void>(r=>{entered=r;});const hold=new Promise<void>(r=>{release=r;});
  h.prepare=async options=>{if(options.role==='orchestrator'){entered();await hold;}return options.prompt;};
  const start=fastLaneBootstrap(scope,mission.id,{waitForFirstPane,invocation:{assertCurrentAuthority:()=>{if(revoked)throw new Error('session_authority_revoked');}}});
  void start.catch(()=>{});await ready;await flush();
  expect(getProjectDomainStores(scope).missions.get(mission.id)?.status).toBe('running');const prematureWarmCalls=h.warm.mock.calls.length;
  revoked=true;release();if(waitForFirstPane)await expect(start).rejects.toThrow(/session_authority_revoked/);else await start;await flush();
  expect(getProjectDomainStores(scope).missions.get(mission.id)).toMatchObject({status:'blocked',intentState:'blocked_technical'});expect(prematureWarmCalls).toBe(0);expect(h.spawn).not.toHaveBeenCalled();expect(h.terminate).not.toHaveBeenCalled();expect(h.physical.has('operator-owned')).toBe(true);
});

it('F-1093: actual first-wave warming cannot begin while current leader context/brief remains uncommitted',async()=>{
  const mission=setup();let entered!:()=>void;let release!:()=>void;let revoked=false;
  const ready=new Promise<void>(r=>{entered=r;});const hold=new Promise<void>(r=>{release=r;});
  h.prepare=async options=>{if(options.role==='orchestrator'){entered();await hold;}return options.prompt;};
  const start=fastLaneBootstrap(scope,mission.id,{invocation:{assertCurrentAuthority:()=>{if(revoked)throw new Error('session_authority_revoked');}}});void start.catch(()=>{});
  await ready;await flush();const earlyCalls=h.warm.mock.calls.length;revoked=true;release();await start.catch(()=>{});
  expect(earlyCalls).toBe(0);expect(h.spawn).not.toHaveBeenCalled();
});

it.each(['new-leader','new-intent','operator-close'] as const)('F-1093: older revoked preparation preserves %s and operator-owned sessions',async(change)=>{
  const mission=setup();let entered!:()=>void;let release!:()=>void;let revoked=false;
  const ready=new Promise<void>(r=>{entered=r;});const hold=new Promise<void>(r=>{release=r;});
  h.prepare=async options=>{if(options.role==='orchestrator'){entered();await hold;}return options.prompt;};
  const start=fastLaneBootstrap(scope,mission.id,{invocation:{assertCurrentAuthority:()=>{if(revoked)throw new Error('session_authority_revoked');}}});void start.catch(()=>{});await ready;
  const store=getProjectDomainStores(scope).missions;const owned=store.get(mission.id)!;
  if(change==='new-leader'){
    getContextBySession('operator-owned')!.role='worker';h.physical.get('operator-owned')!.role='worker';
    const successor=mintToken({label:'successor',role:'orchestrator',missionId:mission.id,scope,readOnly:false,allowedTools:null,allowedSkills:null});bindTokenToSession(successor.token,'new-leader');
    h.physical.set('new-leader',{...h.physical.get('operator-owned')!,sessionId:'new-leader',paneId:'new-pane',role:'orchestrator'});
    store.setOrchestratorSession(mission.id,'new-leader');
    expect(store.get(mission.id)?.updatedAt).toBe(owned.updatedAt); // Setter may share timestamp: SID fence is mandatory.
  }else if(change==='new-intent'){
    store.update(mission.id,{intentVersion:2,intentContract:{...owned.intentContract!,intentVersion:2,goal:'New authorized goal'}});
  }else{
    store.transitionLifecycle(mission.id,{updatedAt:owned.updatedAt,intentVersion:owned.intentVersion!},{status:'blocked',intentState:'blocked_technical',description:'<!-- nexus:runtime-closed -->\n[NEXUS_RUNTIME_CLOSED] Execução encerrada pelo operador.'});
  }
  const successorState=store.get(mission.id)!;revoked=true;release();await start.catch(()=>{});await flush();
  expect(store.get(mission.id)).toEqual(successorState);expect(h.terminate).not.toHaveBeenCalled();expect(h.physical.has('operator-owned')).toBe(true);
  if(change==='new-leader')expect(h.physical.has('new-leader')).toBe(true);
});
it('F-1093: synchronous revocation right after winning running CAS enters owned terminalization',async()=>{
  const mission=setup();const store=getProjectDomainStores(scope).missions;const original=store.transitionLifecycle.bind(store);let revoked=false;
  vi.spyOn(store,'transitionLifecycle').mockImplementation((...args)=>{const result=original(...args);if(args[2].status==='running')revoked=true;return result;});
  await expect(fastLaneBootstrap(scope,mission.id,{invocation:{assertCurrentAuthority:()=>{if(revoked)throw new Error('session_authority_revoked');}}})).rejects.toThrow(/session_authority_revoked/);
  expect(store.get(mission.id)).toMatchObject({status:'blocked',intentState:'blocked_technical'});expect(h.spawn).not.toHaveBeenCalled();expect(h.terminate).not.toHaveBeenCalled();vi.restoreAllMocks();
});
it('F-1093: verified leader and kickoff commit survives original caller self-revocation',async()=>{
  const mission=setup();const store=getProjectDomainStores(scope).missions;const original=store.recordKickoffAcceptance.bind(store);let revoked=false;
  vi.spyOn(store,'recordKickoffAcceptance').mockImplementation(input=>{const result=original(input);revoked=true;return result;});
  await expect(fastLaneBootstrap(scope,mission.id,{invocation:{assertCurrentAuthority:()=>{if(revoked)throw new Error('session_authority_revoked');}}})).resolves.toBeUndefined();
  expect(store.get(mission.id)).toMatchObject({status:'running',orchestratorSessionId:'operator-owned'});expect(store.hasCurrentKickoffAcceptance(mission.id)).toBe(true);expect(h.terminate).not.toHaveBeenCalled();vi.restoreAllMocks();
});

it('F-1093: unproven self leadership is not a verified bootstrap commit',async()=>{
  const mission=setup();h.deliver.mockImplementationOnce(async()=>{h.physical.delete('operator-owned');return true;});
  await expect(fastLaneBootstrap(scope,mission.id)).rejects.toThrow(/setup_unproven/);
  expect(getProjectDomainStores(scope).missions.get(mission.id)).toMatchObject({status:'blocked',intentState:'blocked_technical'});expect(h.warm).not.toHaveBeenCalled();expect(h.terminate).not.toHaveBeenCalled();
});

it('F-1093: only exact freshly born partial session is cleaned; unknown exit keeps evidence and operator/new sessions survive',async()=>{
  const mission=setup();clearOrchestratorAdoption(mission.id);let revoked=false;h.terminate.mockResolvedValueOnce(false);
  h.spawn.mockImplementationOnce(async(options:{role:string;adapterId:string;scope:typeof scope;executionScope?:typeof scope;missionId:string})=>{
    const current=getProjectDomainStores(scope).missions.get(mission.id)!;
    const issued:OwnedAgentSessionInfo={sessionId:'owned-partial',paneId:'owned-pane',adapterId:'codex',scope:options.executionScope??options.scope,cwd:root,source:'pending',role:'orchestrator',missionId:options.missionId,readOnly:false,nativeReadOnly:false,allowedTools:null,allowedSkills:null,authoritySeal:resolveMissionPaneAuthoritySeal(scope,current,h.squad)!};
    h.physical.set(issued.sessionId,issued);revoked=true;return {ok:true,requestId:'own-partial',sessionId:issued.sessionId,paneId:issued.paneId};
  });
  await expect(fastLaneBootstrap(scope,mission.id,{invocation:{assertCurrentAuthority:()=>{if(revoked)throw new Error('session_authority_revoked');}}})).rejects.toThrow(/session_authority_revoked/);
  expect(h.terminate).toHaveBeenCalledOnce();expect(h.terminate).toHaveBeenCalledWith('owned-partial',expect.objectContaining({origin:'fast-lane:spawn-binding-failed'}));
  expect(getProjectDomainStores(scope).missions.get(mission.id)).toMatchObject({status:'blocked',intentState:'blocked_technical'});expect(h.physical.has('owned-partial')).toBe(true);expect(h.physical.has('operator-owned')).toBe(true);expect(h.warm).not.toHaveBeenCalled();
});

it.each(['spend', 'timestamp-only', 'goal', 'budget', 'capability', 'description', 'spend-regression'] as const)('F-1134: revoked own preparation uses fresh lifecycle CAS only for %s', async change => {
  const mission = setup(); const store = getProjectDomainStores(scope).missions;
  if (change === 'spend-regression') store.update(mission.id, { intentContract: { ...mission.intentContract!, spentSteps: 2, spentTokens: 400 } });
  let entered!: () => void, release!: () => void, revoked = false;
  const ready = new Promise<void>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
  h.prepare = async options => { if (options.role === 'orchestrator') { entered(); await hold; } return options.prompt; };
  const start = fastLaneBootstrap(scope, mission.id, { invocation: { assertCurrentAuthority: () => { if (revoked) throw new Error('session_authority_revoked'); } } });
  void start.catch(() => undefined); await ready;
  const bound = store.get(mission.id)!; vi.advanceTimersByTime(1);
  store.update(mission.id, change === 'timestamp-only' ? { description: bound.description } : change === 'description' ? { description: 'New owner description' } : {
    intentContract: { ...bound.intentContract!, spentSteps: 1, spentTokens: 200,
      ...(change === 'goal' ? { goal: 'New approved goal' } : {}),
      ...(change === 'budget' ? { budgets: { ...bound.intentContract!.budgets, executionTokens: 10 } } : {}),
      ...(change === 'capability' ? { executionMode: 'manual' as const } : {}),
    },
  });
  const changed = store.get(mission.id)!; expect(changed.updatedAt).toBeGreaterThan(bound.updatedAt);
  revoked = true; release(); await expect(start).rejects.toThrow(/session_authority_revoked/);
  if (change === 'spend') {
    expect(store.get(mission.id)).toMatchObject({ status: 'blocked', intentState: 'blocked_technical', intentContract: { spentSteps: 1, spentTokens: 200 } });
  } else expect(store.get(mission.id)).toEqual(changed);
  expect(h.terminate).not.toHaveBeenCalled(); expect(h.physical.has('operator-owned')).toBe(true);
});
