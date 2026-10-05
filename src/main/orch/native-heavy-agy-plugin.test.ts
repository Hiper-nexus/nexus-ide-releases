import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
const script = path.join(process.cwd(), 'resources/heavy-command/agy-tool-hook.cjs');
function hook(input: unknown, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 3000 });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}
it('preserves AGY permission policy outside Nexus, including heavy input', () => {
  expect(hook({ toolCall: { name: 'run_command', args: { CommandLine: 'make', Cwd: '/private/fixture' } } })).toEqual({ decision: 'ask' });
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
    expect(definition).toContain('agy-tool-hook.cjs'); expect(definition).not.toMatch(/NEXUS_(?:GATE_TOKEN|HEAVY_CHANNEL_KEY|HEAVY_COMMAND_URL)/);
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
it('re-enables its own disabled plugin through the CLI and never reports a disabled hook as ready', async () => {
  const f=await registrationFixture(); const config=()=>path.join(f.home,'.gemini/config/config.json');
  try {
    expect(await f.ensure(f.options)).toEqual({registered:true});
    // `agy plugin disable` writes only this flag; the manifest entry stays.
    fs.writeFileSync(config(),JSON.stringify({plugins:{[path.basename(f.destination)]:{enabled:false},operator:{enabled:false}}})); f.calls.length=0;
    expect(await f.ensure(f.options)).toEqual({registered:true}); expect(f.calls).toEqual([['plugin','enable',path.basename(f.destination)]]);
    expect(JSON.parse(fs.readFileSync(config(),'utf8')).plugins.operator).toEqual({enabled:false});
    fs.writeFileSync(config(),JSON.stringify({plugins:{[path.basename(f.destination)]:{enabled:false}}})); f.calls.length=0;
    expect(await f.ensure({...f.options,exec:async (_bin:string,args:readonly string[])=>{f.calls.push([...args]);}})).toEqual({registered:false,reason:'agy_heavy_plugin_disabled'});
    expect(f.calls).toEqual([['plugin','enable',path.basename(f.destination)]]);
  } finally {fs.rmSync(f.home,{recursive:true,force:true});}
});
