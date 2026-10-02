import { describe, expect, test } from 'vitest';
import { parseAcpConfigOptions, requestedAcpConfigOption } from './acp-session-config';
const model = {id:'remote-selector',category:'model',type:'select',currentValue:'older',options:[{value:'exact',name:'Exact'}]};
describe('bounded ACP select configuration',()=>{
 test('ignores future option types and flattens advertised value groups',()=>{
  expect(parseAcpConfigOptions([{id:'future',type:'future'}, {...model,options:[{name:'Group',options:model.options}]}])).toMatchObject({ok:true,value:[{id:'remote-selector',values:['exact']}]});
 });
 test.each([undefined, {}, Array.from({length:65},()=>model), [model,model], [{...model,currentValue:42}], [{...model,options:[{value:'exact'},{value:'exact'}]}], [{...model,options:[{value:'x'.repeat(1025)}]}]])('rejects malformed or excessive config without assuming a default (%j)',raw=>{
  expect(parseAcpConfigOptions(raw).ok).toBe(false);
 });
 test('rejects ambiguous same-category selectors',()=>{
  const parsed=parseAcpConfigOptions([model,{...model,id:'other'}]);if(!parsed.ok)throw new Error(parsed.detail);
  expect(()=>requestedAcpConfigOption(parsed.value,'model','exact')).toThrow('unambiguous');
 });
 test('accepts the exact current value even when it is no longer selectable',()=>{
  const parsed=parseAcpConfigOptions([model]);if(!parsed.ok)throw new Error(parsed.detail);
  expect(requestedAcpConfigOption(parsed.value,'model','older').currentValue).toBe('older');
 });
});
