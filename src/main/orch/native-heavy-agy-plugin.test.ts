import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
// Seam to change the plugin directory between Main's check and its write.
const beforeWrite = vi.hoisted(() => ({ run: undefined as undefined | (() => void) }));
vi.mock('../util/atomic-write', async (original) => {
  const real = await original<typeof import('../util/atomic-write')>();
  return { ...real, writeFileAtomicAsync: async (...args: Parameters<typeof real.writeFileAtomicAsync>) => { const run = beforeWrite.run; beforeWrite.run = undefined; run?.(); return real.writeFileAtomicAsync(...args); } };
});
const script = path.join(process.cwd(), 'resources/heavy-command/agy-tool-hook.cjs');
function hook(input: unknown, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 3000 });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}
it('preserves AGY permission policy outside Nexus, including heavy input', () => {
  expect(hook({ toolCall: { name: 'run_command', args: { CommandLine: 'make', Cwd: '/private/fixture' } } })).toEqual({ decision: 'ask' });
});
it('validates the hook envelope: malformed input denies inside Nexus and asks outside', () => {
  for (const raw of ['null', '[]', '"run_command"', '{}', '{"toolCall":null}']) {
    for (const [env, decision] of [[{ NEXUS_GATE_TOKEN: 'finite' }, 'deny'], [{}, 'ask']] as const) {
      const result = spawnSync(process.execPath, [script], { input: raw, encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 3000 });
      expect({ raw, status: result.status, decision: JSON.parse(result.stdout || '{}').decision }).toEqual({ raw, status: 0, decision });
    }
  }
});
it('leaves light or other tools unchanged inside Nexus', () => {
  const env = { NEXUS_GATE_TOKEN: 'finite' };
  expect(hook({ toolCall: { name: 'run_command', args: { CommandLine: 'printf done' } } }, env)).toEqual({ decision: 'ask' });
  expect(hook({ toolCall: { name: 'read_file', args: { CommandLine: 'make' } } }, env)).toEqual({ decision: 'ask' });
});
it('denies heavy execution with incomplete Nexus admission context', () => {
  expect(hook({ toolCall: { name: 'run_command', args: { CommandLine: 'make' } } }, { NEXUS_GATE_TOKEN: 'finite' })).toMatchObject({ decision: 'deny' });
});
it('rewrites only CommandLine with the fixed physical launcher and no secret in output', () => {
  const directory = fs.realpathSync(path.join(process.cwd(), 'resources/heavy-command'));
  const channel = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agy-hook-channel-')));
  try {
    const result = hook({ toolCall: { name: 'run_command', args: { CommandLine: "make; printf 'quoted'", Cwd: '/private/fixture', WaitMsBeforeAsync: 100 } } }, {
      NEXUS_GATE_TOKEN: 'finite-private', NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1234/hook/heavy-command', NEXUS_HEAVY_NODE: process.execPath,
      NEXUS_HEAVY_DIR: directory, NEXUS_HEAVY_JOB_BASE: JSON.stringify({ file: '/usr/bin/perl', args: ['heavy-job'] }),
      NEXUS_HEAVY_CHANNEL_DIR: channel, NEXUS_HEAVY_CHANNEL_KEY: 'a'.repeat(64), NEXUS_HEAVY_CHANNEL_EPOCH: 'finite-epoch', NEXUS_HEAVY_CHANNEL_PUBLIC_KEY: 'finite-public',
    });
    expect(result.decision).toBe('ask'); expect(Object.keys(result.overwrite)).toEqual(['CommandLine']);
    expect(result.overwrite.CommandLine).toContain('job-launch.cjs'); expect(result.overwrite.CommandLine).toContain("'build'");
    expect(result.overwrite.CommandLine).toContain("'\\''");
    expect(JSON.stringify(result)).not.toMatch(/finite-private|finite-epoch|a{64}|1234/);
  } finally { fs.rmSync(channel, { recursive: true, force: true }); }
});

async function registrationFixture() {
  const { ensureAgyNativeHeavyPlugin, AGY_NATIVE_HEAVY_PLUGIN } = await import('./native-heavy-agy-plugin');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agy-plugin-unit-')));
  const destination = path.join(home, '.gemini/config/plugins', AGY_NATIVE_HEAVY_PLUGIN);
  const calls: string[][] = [];
  // Mirrors the files AGY 1.2.16 writes: verbatim copy, import manifest and
  // the enable flag in config.json (measured in a disposable HOME).
  const exec = async (_bin: string, args: readonly string[]) => {
    calls.push([...args]);
    if (args[1] === 'install') {
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.cpSync(args[2], destination, { recursive: true });
      fs.writeFileSync(path.join(home,'.gemini/config/import_manifest.json'),JSON.stringify({ imports:[{ name:AGY_NATIVE_HEAVY_PLUGIN, source:'antigravity', importedAt:'2026-10-05T01:35:07Z', components:['hooks'] }] }));
    }
    if (args[1] === 'enable') {
      const file = path.join(home,'.gemini/config/config.json'), config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {};
      fs.writeFileSync(file,JSON.stringify({ ...config, plugins:{ ...config.plugins, [args[2]]:{ enabled:true } } }));
    }
  };
  return { home, destination, calls, exec, ensure:ensureAgyNativeHeavyPlugin, options:{home,agyBin:'/fixture/agy',node:fs.realpathSync(process.execPath),resourceDirectory:fs.realpathSync(path.join(process.cwd(),'resources/heavy-command')),exec} };
}
it('registers through the async CLI once, checks readiness, and never touches other plugins', async () => {
  const f=await registrationFixture();
  try {
    const other=path.join(f.home,'.gemini/config/plugins/operator/plugin.json'); fs.mkdirSync(path.dirname(other),{recursive:true}); fs.writeFileSync(other,'operator-owned');
    expect(await f.ensure(f.options)).toEqual({registered:true});
    expect(await f.ensure(f.options)).toEqual({registered:true});
    expect(f.calls.filter(c=>c[1]==='install')).toHaveLength(1); expect(fs.readFileSync(other,'utf8')).toBe('operator-owned');
    const definition=fs.readFileSync(path.join(f.destination,'hooks.json'),'utf8');
    expect(definition).toContain('agy-tool-hook.cjs'); expect(definition).not.toMatch(/NEXUS_(?:HEAVY_CHANNEL_KEY|HEAVY_COMMAND_URL)/);
    // The token is only tested for presence by the shell; its value never lands here.
    expect(definition.match(/NEXUS_GATE_TOKEN/g)).toEqual(['NEXUS_GATE_TOKEN']); expect(definition).toContain('[ -n \\"$NEXUS_GATE_TOKEN\\" ]');
    expect(fs.existsSync(path.join(f.home,'.agents'))).toBe(false);
  } finally {fs.rmSync(f.home,{recursive:true,force:true});}
});
it('refuses foreign plugin collision without executing the installer', async () => {
  const f=await registrationFixture();
  try {
    fs.mkdirSync(f.destination,{recursive:true}); fs.writeFileSync(path.join(f.destination,'plugin.json'),'{"name":"operator-owned"}');
    expect(await f.ensure(f.options)).toMatchObject({registered:false}); expect(f.calls).toEqual([]);
    expect(fs.readFileSync(path.join(f.destination,'plugin.json'),'utf8')).toBe('{"name":"operator-owned"}');
  } finally {fs.rmSync(f.home,{recursive:true,force:true});}
});
it('checks each waiter after shared installation even when the first session expires', async () => {
  const f=await registrationFixture(); let finish!:()=>void; const waiting=new Promise<void>(r=>finish=r); let firstCurrent=true;
  const original=f.exec; const exec=async (bin:string,args:readonly string[])=>{if(args[1]==='install') await waiting; await original(bin,args);};
  try {
    const first=f.ensure({...f.options,exec,assertCurrent:()=>{if(!firstCurrent)throw new Error('stale');}});
    const second=f.ensure({...f.options,exec,assertCurrent:()=>{}});
    firstCurrent=false; finish();
    expect(await first).toMatchObject({registered:false}); expect(await second).toEqual({registered:true});
    expect(f.calls.filter(c=>c[1]==='install')).toHaveLength(1);
  } finally {finish();fs.rmSync(f.home,{recursive:true,force:true});}
});
it('refuses symlinked plugin destinations and plugin files without executing the installer', async () => {
  const f=await registrationFixture(); const elsewhere=path.join(f.home,'elsewhere');
  try {
    // A complete owned-looking install outside the native plugin directory.
    expect(await f.ensure(f.options)).toEqual({registered:true});
    fs.renameSync(f.destination,elsewhere); fs.symlinkSync(elsewhere,f.destination); f.calls.length=0;
    expect(await f.ensure(f.options)).toEqual({registered:false,reason:'agy_heavy_plugin_directory_invalid'}); expect(f.calls).toEqual([]);
    fs.unlinkSync(f.destination); fs.mkdirSync(f.destination);
    fs.copyFileSync(path.join(elsewhere,'plugin.json'),path.join(f.destination,'plugin.json')); fs.symlinkSync(path.join(elsewhere,'hooks.json'),path.join(f.destination,'hooks.json'));
    expect(await f.ensure(f.options)).toMatchObject({registered:false}); expect(f.calls).toEqual([]);
    expect(fs.lstatSync(path.join(f.destination,'hooks.json')).isSymbolicLink()).toBe(true);
  } finally {fs.rmSync(f.home,{recursive:true,force:true});}
});
it('recognizes its own plugin after the CLI rewrites JSON key order', async () => {
  const f=await registrationFixture();
  try {
    expect(await f.ensure(f.options)).toEqual({registered:true});
    const reorder=(file:string)=>{const value=JSON.parse(fs.readFileSync(file,'utf8'));const keys=Object.keys(value).reverse();fs.writeFileSync(file,JSON.stringify(Object.fromEntries(keys.map(k=>[k,value[k]])),null,2));};
    reorder(path.join(f.destination,'plugin.json'));
    const hooksFile=path.join(f.destination,'hooks.json'),hooks=JSON.parse(fs.readFileSync(hooksFile,'utf8'));
    const entry=Object.values(hooks)[0] as {PreToolUse:Array<{matcher:string;hooks:Array<Record<string,unknown>>}>};
    const hook=entry.PreToolUse[0].hooks[0]; entry.PreToolUse[0]={hooks:[{timeout:hook.timeout,command:hook.command,type:hook.type}],matcher:entry.PreToolUse[0].matcher} as never;
    fs.writeFileSync(hooksFile,JSON.stringify(hooks)); const before=fs.readFileSync(hooksFile,'utf8'); f.calls.length=0;
    expect(await f.ensure(f.options)).toEqual({registered:true}); expect(f.calls).toEqual([]);
    expect(fs.readFileSync(hooksFile,'utf8')).toBe(before);
  } finally {fs.rmSync(f.home,{recursive:true,force:true});}
});
it('keeps the operator disable: never re-enables and reports disabled for the caller to degrade', async () => {
  const f=await registrationFixture(); const config=()=>path.join(f.home,'.gemini/config/config.json');
  try {
    expect(await f.ensure(f.options)).toEqual({registered:true});
    // `agy plugin disable` writes only this flag; the manifest entry stays.
    const disabled=JSON.stringify({plugins:{[path.basename(f.destination)]:{enabled:false},operator:{enabled:false}}});
    fs.writeFileSync(config(),disabled); f.calls.length=0;
    expect(await f.ensure(f.options)).toEqual({registered:false,reason:'agy_heavy_plugin_disabled'});
    expect(f.calls).toEqual([]); expect(fs.readFileSync(config(),'utf8')).toBe(disabled);
    fs.writeFileSync(config(),JSON.stringify({plugins:{[path.basename(f.destination)]:{enabled:true}}}));
    expect(await f.ensure(f.options)).toEqual({registered:true}); expect(f.calls).toEqual([]);
  } finally {fs.rmSync(f.home,{recursive:true,force:true});}
});
it('the generated hook denies inside Nexus and asks outside when Node or the script is gone', async () => {
  const f=await registrationFixture(); const resources=path.join(f.home,'resources'), node=path.join(f.home,'node');
  try {
    fs.cpSync(f.options.resourceDirectory,resources,{recursive:true}); fs.writeFileSync(node,`#!/bin/sh\nexec '${process.execPath}' "$@"\n`,{mode:0o755});
    expect(await f.ensure({...f.options,node,resourceDirectory:resources})).toEqual({registered:true});
    const command=(JSON.parse(fs.readFileSync(path.join(f.destination,'hooks.json'),'utf8'))[path.basename(f.destination)].PreToolUse[0].hooks[0].command) as string;
    const run=(token:boolean)=>JSON.parse(execFileSync('/bin/sh',['-c',command],{input:JSON.stringify({toolCall:{name:'run_command',args:{CommandLine:'make'}}}),encoding:'utf8',env:{PATH:'/usr/bin:/bin',...(token?{NEXUS_GATE_TOKEN:'finite'}:{})},timeout:5000})).decision;
    expect([run(false),run(true)]).toEqual(['ask','deny']);
    fs.unlinkSync(node); expect([run(false),run(true)]).toEqual(['ask','deny']);
    fs.writeFileSync(node,`#!/bin/sh\nexec '${process.execPath}' "$@"\n`,{mode:0o755}); fs.unlinkSync(path.join(resources,'agy-tool-hook.cjs'));
    expect([run(false),run(true)]).toEqual(['ask','deny']);
  } finally {fs.rmSync(f.home,{recursive:true,force:true});}
});
it.runIf(process.platform !== 'win32')('the CLI deadline SIGKILLs a group that ignores SIGTERM and settles only after physical exit', async () => {
  const { runAgyPluginCli } = await import('./native-heavy-agy-plugin');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nexus-agy-cli-deadline-'))), cli=path.join(root,'agy');
  // Deliberately slower than the 300ms deadline: the deadline clock is advanced
  // only once the real process group is ready to exercise ignored SIGTERM.
  fs.writeFileSync(cli,`#!/bin/sh\n/bin/sleep 1\ntrap '' TERM\n/bin/sleep 30 &\necho "$$ $!" > '${root}/pids'\nwhile :; do /bin/sleep 1; done\n`,{mode:0o755});
  const gone=(pid:number)=>{try{return execFileSync('/bin/ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'}).trim().startsWith('Z');}catch{return true;}};
  let running: Promise<void> | undefined;
  let readinessPoll: ReturnType<typeof setInterval> | undefined;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    running = runAgyPluginCli(cli,['plugin','install','x'],{home:root,cwd:root},300,300);
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    const pids = await new Promise<number[]>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      // setInterval and Date are real; polling must not advance the CLI clock.
      readinessPoll = setInterval(() => {
        try {
          const text = fs.readFileSync(path.join(root, 'pids'), 'utf8');
          if (/^[1-9]\d* [1-9]\d*\n$/.test(text)) {
            const values = text.trim().split(' ').map(Number);
            if (values.every(pid => Number.isSafeInteger(pid) && pid > 0) && new Set(values).size === 2) {
              clearInterval(readinessPoll); resolve(values); return;
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { clearInterval(readinessPoll); reject(error); return; }
        }
        if (Date.now() >= deadline) { clearInterval(readinessPoll); reject(new Error('AGY CLI fixture did not publish two complete PIDs')); }
      }, 20);
    });
    expect(pids.map(gone)).toEqual([false, false]);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(300); // real SIGTERM; both ignore it
    expect(settled).toBe(false);
    expect(pids.map(gone)).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // real SIGKILL, then kernel exit
    await expect(running).rejects.toThrow('agy_heavy_plugin_cli_timeout');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    await vi.waitFor(()=>expect(pids.map(gone)).toEqual([true,true]),{timeout:2000});
    await expect(runAgyPluginCli('/usr/bin/true',[],{home:root,cwd:root})).resolves.toBeUndefined();
    await expect(runAgyPluginCli('/usr/bin/false',[],{home:root,cwd:root})).rejects.toThrow('agy_heavy_plugin_cli_failed');
  } finally {
    clearInterval(readinessPoll);
    try {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(600);
    } finally { vi.useRealTimers(); }
    await running?.catch(() => undefined);
    fs.rmSync(root,{recursive:true,force:true});
  }
});
it('a cancelled pane stops waiting at once; the shared flight still serves the next caller', async () => {
  const f=await registrationFixture(); let finish!:()=>void, installing=false; const waiting=new Promise<void>(r=>finish=r);
  const exec=async (bin:string,args:readonly string[])=>{if(args[1]==='install'){installing=true;await waiting;} await f.exec(bin,args);};
  const pane=new AbortController();
  try {
    const first=f.ensure({...f.options,exec,signal:pane.signal}); const second=f.ensure({...f.options,exec});
    await vi.waitFor(()=>expect(installing).toBe(true));
    pane.abort();
    expect(await first).toEqual({registered:false,reason:'agy_heavy_plugin_context_changed'});
    finish(); expect(await second).toEqual({registered:true}); expect(f.calls.filter(c=>c[1]==='install')).toHaveLength(1);
  } finally {finish();fs.rmSync(f.home,{recursive:true,force:true});}
});
it('refuses when the plugin or source directory is replaced around a write or the CLI', async () => {
  const f=await registrationFixture(); const elsewhere=path.join(f.home,'elsewhere');
  try {
    expect(await f.ensure(f.options)).toEqual({registered:true});
    // Owned update path: the directory is swapped between check and write.
    const node=path.join(f.home,'node'); fs.writeFileSync(node,`#!/bin/sh\nexec '${process.execPath}' "$@"\n`,{mode:0o755});
    beforeWrite.run=()=>{fs.renameSync(f.destination,elsewhere);fs.mkdirSync(f.destination);for(const name of fs.readdirSync(elsewhere))fs.copyFileSync(path.join(elsewhere,name),path.join(f.destination,name));};
    expect(await f.ensure({...f.options,node})).toEqual({registered:false,reason:'agy_heavy_plugin_directory_changed'});
    // Fresh path: the private source is swapped while the CLI validates it.
    const g=await registrationFixture(); const source=path.join(g.home,'.nexus/agy-native-heavy-plugin');
    const exec=async (bin:string,args:readonly string[])=>{ await g.exec(bin,args); if(args[1]==='validate'){fs.renameSync(source,source+'.old');fs.cpSync(source+'.old',source,{recursive:true});} };
    try { expect(await g.ensure({...g.options,exec})).toEqual({registered:false,reason:'agy_heavy_plugin_directory_changed'}); expect(g.calls.map(c=>c[1])).toEqual(['validate']); }
    finally {fs.rmSync(g.home,{recursive:true,force:true});}
  } finally {beforeWrite.run=undefined;fs.rmSync(f.home,{recursive:true,force:true});}
});
