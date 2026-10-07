import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('../license-enforcement', () => ({ assertLicenseAccess: vi.fn(), licensedAgentCount: vi.fn(() => 0), reserveLicensedAgent: vi.fn(() => () => {}) }));
import { spawnAcpHarnessSession } from './acp-harness-driver';
import { readSessionOutput } from '../orch/pane-session-output';

const PEER = `
import readline from 'node:readline';
const mode = process.argv[2]; const requests = [];
const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
let model = mode === 'already' ? 'model-exact' : 'model-old';
let effort = mode === 'already' ? 'high' : 'low';
const config = () => mode === 'none' ? [] : [
 {id:mode==='uncategorized'?'model':'opaque-model-control',...(mode==='uncategorized'?{}:{category:'model'}),type:'select',currentValue:model,options:[{name:'Models',options:[{value:'model-old',name:'Old'},{value:mode==='alias-only'?'sonnet':'model-exact',name:'Desired'}]}]},
 {id:mode==='uncategorized'?'effort':'opaque-effort-control',...(mode==='uncategorized'?{}:{category:'thought_level'}),type:'select',currentValue:effort,options:[{value:'low',name:'Low'},...(mode==='effort-missing'||(mode==='effort-refresh'&&model==='model-old')?[]:[{value:'high',name:'High'}])]},
];
readline.createInterface({input:process.stdin}).on('line', line => {
 const message=JSON.parse(line);requests.push(message);
 if(message.method==='initialize') write({jsonrpc:'2.0',id:message.id,result:{protocolVersion:1,agentCapabilities:{},agentInfo:{name:'selection-fixture',version:'0'}}});
 if(message.method==='session/new') write({jsonrpc:'2.0',id:message.id,result:{sessionId:'wire-selected',...(mode==='absent'?{}:{configOptions:config()})}});
 if(message.method==='session/set_config_option') {
  const {configId,value}=message.params;
  if(mode!=='lie') {if(configId.includes('model')) model=value; else {effort=value;if(mode==='drift')model='model-old';}}
  write({jsonrpc:'2.0',id:message.id,result:{configOptions:config()}});
 }
 if(message.method==='session/prompt') {
  write({jsonrpc:'2.0',method:'session/update',params:{sessionId:'wire-selected',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({requests,model,effort})}}}});
  write({jsonrpc:'2.0',id:message.id,result:{stopReason:'end_turn'}});
 }
});
`;
let cwd='';let peerPath='';
interface SelectionReceipt {
 requests: Array<{ method: string; params: Record<string, unknown> }>;
 model: string;
 effort: string;
}
beforeAll(async () => {cwd=await mkdtemp(path.join(os.tmpdir(),'nexus-acp-selection-'));peerPath=path.join(cwd,'peer.mjs');await writeFile(peerPath,PEER);});
afterAll(async () => {await rm(cwd,{recursive:true,force:true});});
function input(mode:string, selection: {model?:string;effort?:string;accountId?:string} = {}) {
 return {harness:{id:'fixture',label:'Fixture',command:process.execPath,args:[peerPath,mode],env:{},tier:'custom' as const,canAutoInstall:false as const},cwd,paneId:'pane-selected',missionId:'mission-selected',scope:{version:1 as const,installationId:'proof',projectId:'p',checkoutId:'c',rootRealPath:cwd,identitySource:'manifest' as const},publishFrame:()=>{},...selection};
}
describe('ACP actual wire selection before a prompt', () => {
 test.each(['supported','uncategorized','effort-refresh'])('sets advertised exact model and effort using peer option IDs (%s)', async mode => {
  const session=await spawnAcpHarnessSession(input(mode,{model:'model-exact',effort:'high'}));
  try {await session.prompt('verify');const receipt=JSON.parse(readSessionOutput(session.sessionId)) as SelectionReceipt;
   expect(receipt.model).toBe('model-exact');expect(receipt.effort).toBe('high');
   expect(receipt.requests.map(r=>r.method)).toEqual(['initialize','session/new','session/set_config_option','session/set_config_option','session/prompt']);
   expect(receipt.requests[2].params).toEqual({sessionId:'wire-selected',configId:mode==='uncategorized'?'model':'opaque-model-control',value:'model-exact'});
   expect(receipt.requests[3].params).toEqual({sessionId:'wire-selected',configId:mode==='uncategorized'?'effort':'opaque-effort-control',value:'high'});
  } finally {await session.shutdown();}
 });
 test('does not send setters when exact selections are already confirmed',async () => {
  const session=await spawnAcpHarnessSession(input('already',{model:'model-exact',effort:'high'}));
  try {await session.prompt('verify');const receipt=JSON.parse(readSessionOutput(session.sessionId)) as SelectionReceipt;expect(receipt.requests.map(r=>r.method)).toEqual(['initialize','session/new','session/prompt']);}
  finally {await session.shutdown();}
 });
 test.each(['none','absent','alias-only'])('rejects an unavailable exact model without silent fallback (%s)',async mode => {
  await expect(spawnAcpHarnessSession(input(mode,{model:'model-exact'}))).rejects.toMatchObject({code:'protocol'});
 });
 test('rejects unavailable effort after resolving the requested model',async () => {
  await expect(spawnAcpHarnessSession(input('effort-missing',{model:'model-exact',effort:'high'}))).rejects.toMatchObject({code:'protocol'});
 });
 test.each(['lie','drift'])('rejects a provider that does not preserve the confirmed selection (%s)',async mode => {
  await expect(spawnAcpHarnessSession(input(mode,{model:'model-exact',effort:'high'}))).rejects.toMatchObject({code:'protocol'});
 });
 test('does not claim an explicit account before a supported account projection exists',async () => {
  const request=input('supported',{accountId:'selected-account'});request.harness.command='/does/not/exist';
  await expect(spawnAcpHarnessSession(request)).rejects.toMatchObject({code:'protocol',message:expect.stringContaining('account selection is not supported')});
 });
 test('keeps harness defaults when no selection was requested',async () => {
  const session=await spawnAcpHarnessSession(input('absent'));
  try {await session.prompt('verify');const receipt=JSON.parse(readSessionOutput(session.sessionId)) as SelectionReceipt;expect(receipt.requests.map(r=>r.method)).toEqual(['initialize','session/new','session/prompt']);expect(session.agent.requestedModel).toBeUndefined();}
  finally {await session.shutdown();}
 });
});
