import { describe, expect, it, vi } from 'vitest';
import { createCdpRelayConnection, type CdpRelayTarget } from './cdp-relay';

function fakeTarget(overrides: Partial<CdpRelayTarget> = {}): CdpRelayTarget {
  return {
    send: vi.fn(async () => ({})),
    targetId: async () => 'target-1',
    url: () => 'https://app.local/',
    title: () => 'Preview',
    userAgent: () => 'NexusIDE-Test',
    setDownloadDirectory: vi.fn(),
    ...overrides,
  };
}

function collectWrites() {
  const written: Record<string, unknown>[] = [];
  const relay = createCdpRelayConnection(fakeTarget(), (raw) => {
    written.push(JSON.parse(raw) as Record<string, unknown>);
  });
  return { relay, written };
}

describe('CdpRelay (T3 port)', () => {
  it('answers Browser.getVersion with the Nexus product string', async () => {
    const { relay, written } = collectWrites();
    relay.receive(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(written[0]).toMatchObject({
      id: 1,
      result: expect.objectContaining({ product: 'NexusIDE' }),
    });
  });

  it('Target.setAutoAttach announces the page session after the reply', async () => {
    const { relay, written } = collectWrites();
    relay.receive(JSON.stringify({ id: 2, method: 'Target.setAutoAttach' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const ids = written.map((m) => m.id);
    expect(ids).toContain(2);
    const announce = written.find((m) => m.method === 'Target.attachedToTarget');
    expect(announce).toMatchObject({
      params: expect.objectContaining({ sessionId: 'nexus-preview-page' }),
    });
  });

  it('refuses to attach to a foreign target', async () => {
    const target = fakeTarget();
    const written: Record<string, unknown>[] = [];
    const relay = createCdpRelayConnection(target, (raw) => {
      written.push(JSON.parse(raw) as Record<string, unknown>);
    });
    relay.receive(
      JSON.stringify({
        id: 3,
        method: 'Target.attachToTarget',
        params: { targetId: 'other' },
      }),
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(written[0]).toMatchObject({
      id: 3,
      error: expect.objectContaining({ message: expect.stringContaining('Only this preview') }),
    });
  });

  it('routes page commands to the target and swallows runIfWaitingForDebugger', async () => {
    const target = fakeTarget();
    const relay = createCdpRelayConnection(target, () => undefined);
    relay.receive(
      JSON.stringify({
        id: 4,
        method: 'Page.navigate',
        params: { url: 'https://app.local/x' },
        sessionId: 'nexus-preview-page',
      }),
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(target.send).toHaveBeenCalledWith(
      'Page.navigate',
      { url: 'https://app.local/x' },
      undefined,
    );
    relay.receive(
      JSON.stringify({
        id: 5,
        method: 'Runtime.runIfWaitingForDebugger',
        sessionId: 'nexus-preview-page',
      }),
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(target.send).toHaveBeenCalledTimes(1);
  });

  it('forwards download events on the root session and page events per session', async () => {
    const written: Record<string, unknown>[] = [];
    const relay = createCdpRelayConnection(fakeTarget(), (raw) => {
      written.push(JSON.parse(raw) as Record<string, unknown>);
    });
    relay.receive(JSON.stringify({ id: 6, method: 'Target.setAutoAttach' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    written.length = 0;
    relay.event('Browser.downloadWillBegin', { guid: 'g' }, undefined);
    relay.event('Page.loadEventFired', {}, undefined);
    expect(written[0]).toMatchObject({ method: 'Browser.downloadWillBegin' });
    expect(written[1]).toMatchObject({
      method: 'Page.loadEventFired',
      sessionId: 'nexus-preview-page',
    });
  });

  it('returns the same browser context that Target.getTargets advertises', async () => {
    const { relay, written } = collectWrites();
    relay.receive(JSON.stringify({ id: 10, method: 'Target.getBrowserContexts' }));
    relay.receive(JSON.stringify({ id: 11, method: 'Target.getTargets' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const contexts = written.find((message) => message.id === 10);
    const targets = written.find((message) => message.id === 11);
    const contextIds = (
      contexts?.result as { browserContextIds?: string[] } | undefined
    )?.browserContextIds;
    const targetInfos = (
      targets?.result as { targetInfos?: Array<{ browserContextId?: string }> } | undefined
    )?.targetInfos;
    expect(contextIds).toEqual(['nexus-preview']);
    expect(targetInfos?.[0]?.browserContextId).toBe('nexus-preview');
  });

  it('rejects unsupported browser commands', async () => {
    const written: Record<string, unknown>[] = [];
    const relay = createCdpRelayConnection(fakeTarget(), (raw) => {
      written.push(JSON.parse(raw) as Record<string, unknown>);
    });
    relay.receive(JSON.stringify({ id: 7, method: 'Browser.close' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(written[0]).toMatchObject({
      id: 7,
      error: expect.objectContaining({ message: expect.stringContaining('Not supported') }),
    });
  });
});

describe('F-1077: per-page CDP envelope and channel confinement', () => {
  function setup() {
    const target=fakeTarget();const written:Record<string,unknown>[]=[];
    return {target,written,relay:createCdpRelayConnection(target,raw=>written.push(JSON.parse(raw)))};
  }
  it.each([undefined,'nexus-preview-page','invented-child','nexus-preview-browser-1'])('never forwards Browser/Target restrictions through session %s',async(sessionId)=>{
    const {relay,target,written}=setup();
    relay.receive(JSON.stringify({id:1,method:'Target.attachToTarget',sessionId,params:{targetId:'foreign-target'}}));
    relay.receive(JSON.stringify({id:2,method:'Browser.close',sessionId}));
    relay.receive(JSON.stringify({id:3,method:'Browser.setDownloadBehavior',sessionId,params:{behavior:'allow',downloadPath:'/outside-workspace'}}));
    await vi.waitFor(()=>expect(written).toHaveLength(3));
    expect(written.every(message=>'error' in message)).toBe(true);
    expect(target.send).not.toHaveBeenCalled();expect(target.setDownloadDirectory).not.toHaveBeenCalled();
  });
  it('rejects malformed envelopes without synchronous exceptions or native sends',async()=>{
    const {relay,target}=setup();
    for(const command of [{id:1.2,method:'Page.enable'},{id:1e30,method:'Page.enable'},{id:1,method:7},{id:1,method:'Page.enable',params:[]},{id:1,method:'Page.enable',params:null},{id:1,method:'Page.enable',sessionId:5},{id:1,method:'x'.repeat(1025)},{id:1,method:'Page.enable',sessionId:'x'.repeat(1025)}]) {
      expect(()=>relay.receive(JSON.stringify(command))).not.toThrow();
    }
    await new Promise(resolve => setTimeout(resolve, 0));expect(target.send).not.toHaveBeenCalled();
  });
  it('rejects invented sessions and global namespaces outside Browser/Target',async()=>{
    const {relay,target,written}=setup();
    relay.receive(JSON.stringify({id:1,method:'Runtime.evaluate',sessionId:'guessed-child',params:{expression:'document.title'}}));
    relay.receive(JSON.stringify({id:2,method:'SystemInfo.getProcessInfo',sessionId:'nexus-preview-page'}));
    relay.receive(JSON.stringify({id:3,method:'Page.navigateToHistoryEntry',sessionId:'nexus-preview-page',params:{entryId:123}}));
    await vi.waitFor(()=>expect(written).toHaveLength(3));expect(written.every(m=>'error' in m)).toBe(true);expect(target.send).not.toHaveBeenCalled();
  });
  it('admits only actual same-preview child attachment events and removes detached descendants',async()=>{
    const {relay,target}=setup();
    relay.receive(JSON.stringify({id:0,method:'Target.setAutoAttach'}));await new Promise(resolve=>setTimeout(resolve,0));
    relay.event('Target.attachedToTarget',{sessionId:'child',targetInfo:{targetId:'frame-child',type:'iframe',url:'https://app.local/frame'}},undefined);
    relay.event('Target.attachedToTarget',{sessionId:'nested',targetInfo:{targetId:'worker-child',type:'worker',url:'https://app.local/worker.js'}},'child');
    relay.event('Target.attachedToTarget',{sessionId:'foreign',targetInfo:{targetId:'outside',type:'iframe',url:'https://foreign.test/'}},undefined);
    for(const sessionId of ['child','nested','foreign'])relay.receive(JSON.stringify({id:1,sessionId,method:'Runtime.runIfWaitingForDebugger'}));
    await vi.waitFor(()=>expect(target.send).toHaveBeenCalledWith('Runtime.runIfWaitingForDebugger',{},'nested'));
    expect(target.send).toHaveBeenCalledTimes(2);
    relay.event('Target.detachedFromTarget',{sessionId:'child'},undefined);
    for(const sessionId of ['child','nested'])relay.receive(JSON.stringify({id:2,sessionId,method:'Runtime.evaluate',params:{expression:'1'}}));
    await new Promise(resolve=>setTimeout(resolve,0));expect(target.send).toHaveBeenCalledTimes(2);
  });
  it('refuses off-origin/frame navigation and pathful download policy before native send',async()=>{
    const {relay,target,written}=setup();
    relay.receive(JSON.stringify({id:1,method:'Page.navigate',sessionId:'nexus-preview-page',params:{url:'https://foreign.test/'}}));
    relay.receive(JSON.stringify({id:2,method:'Page.navigate',sessionId:'nexus-preview-page',params:{url:'https://app.local/',frameId:'foreign-frame'}}));
    relay.receive(JSON.stringify({id:3,method:'Browser.setDownloadBehavior',params:{behavior:'deny',downloadPath:'/outside'}}));
    await vi.waitFor(()=>expect(written).toHaveLength(3));expect(written.every(m=>'error' in m)).toBe(true);expect(target.send).not.toHaveBeenCalled();
  });
  it('absorbs synchronous target failures in the response boundary',async()=>{
    const written:Record<string,unknown>[]=[];
    const relay=createCdpRelayConnection(fakeTarget({send:()=>{throw new Error('native synchronous failure')}}),raw=>written.push(JSON.parse(raw)));
    expect(()=>relay.receive(JSON.stringify({id:1,method:'Page.enable',sessionId:'nexus-preview-page'}))).not.toThrow();
    await vi.waitFor(()=>expect(written[0]).toMatchObject({id:1,error:{message:'native synchronous failure'}}));
  });
});

describe('F-1077: child proof expires with the selected-origin document',()=>{
  async function setup(target=fakeTarget()) {
    const written:Record<string,unknown>[]=[];
    const relay=createCdpRelayConnection(target,raw=>written.push(JSON.parse(raw)));
    relay.receive(JSON.stringify({id:0,method:'Target.setAutoAttach'}));
    await vi.waitFor(()=>expect(written).toHaveLength(2));
    relay.event('Target.attachedToTarget',{sessionId:'child',targetInfo:{targetId:'frame-child',type:'iframe',url:'https://app.local/frame'}},undefined);
    relay.event('Target.attachedToTarget',{sessionId:'nested',targetInfo:{targetId:'nested-worker',type:'worker',url:'https://app.local/worker.js'}},'child');
    written.length=0;return {relay,target,written};
  }
  it.each([
    ['Page.frameNavigated',{frame:{url:'https://foreign.test/secret'}}],
    ['Runtime.executionContextCreated',{context:{origin:'https://foreign.test',name:'secret-context'}}],
    ['Target.targetInfoChanged',{targetInfo:{targetId:'frame-child',url:'https://foreign.test/secret'}}],
  ] as const)('revokes child/descendants before forwarding off-origin %s data',async(method,params)=>{
    const {relay,target,written}=await setup();
    relay.event(method,params,method==='Target.targetInfoChanged'?undefined:'child');
    relay.receive(JSON.stringify({id:1,method:'Runtime.evaluate',sessionId:'child',params:{expression:'document.title'}}));
    relay.receive(JSON.stringify({id:2,method:'Runtime.evaluate',sessionId:'nested',params:{expression:'document.title'}}));
    await vi.waitFor(()=>expect(written).toHaveLength(2));
    expect(written.every(message=>'error' in message)).toBe(true);expect(target.send).not.toHaveBeenCalled();
    expect(JSON.stringify(written)).not.toContain('foreign.test');
  });
  it('suppresses a late native child response after detach',async()=>{
    let complete!:(value:unknown)=>void;
    const target=fakeTarget({send:vi.fn(()=>new Promise(resolve=>{complete=resolve;}))});
    const {relay,written}=await setup(target);
    relay.receive(JSON.stringify({id:1,method:'Runtime.evaluate',sessionId:'child',params:{expression:'document.title'}}));
    await vi.waitFor(()=>expect(complete).toBeDefined());
    relay.event('Target.detachedFromTarget',{sessionId:'child'},undefined);written.length=0;
    complete({secret:'later-document-data'});await new Promise(resolve=>setTimeout(resolve,0));
    expect(written).toEqual([]);
  });
  it('does not leak global target discovery from another Main debugger consumer',async()=>{
    const {relay,written}=await setup();
    relay.event('Target.targetCreated',{targetInfo:{targetId:'foreign-tab',type:'page',url:'https://operator-private.test/'}},undefined);
    expect(written).toEqual([]);
  });
});
