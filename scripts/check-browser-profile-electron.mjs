#!/usr/bin/env node
// Synthetic, isolated Electron check. Never reads Chrome cookies or the real vault.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = require('electron');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-profile-native-'));
const outfile = path.join(dir, 'smoke.cjs');
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
const source = `
const {app, BrowserWindow, session} = require('electron');
const assert = require('node:assert/strict');
const {BrowserCookieProfile} = require(${JSON.stringify(path.join(repoRoot, 'src/main/browser/browser-profile-cookies.ts'))});
const {connectPersonalProfile} = require(${JSON.stringify(path.join(repoRoot, 'src/main/browser/browser-personal-profile.ts'))});
app.setPath('userData', ${JSON.stringify(path.join(dir,'data'))});
app.disableHardwareAcceleration();
const deadline=setTimeout(()=>{console.error('profile smoke timed out');app.exit(1);},20000);
app.whenReady().then(async()=>{
 // The Keychain binding is N-API: it must load in Electron's own runtime with no rebuild. Only the class is inspected; no entry is read.
 assert.equal(typeof require('@napi-rs/keyring').AsyncEntry,'function','@napi-rs/keyring must load in Electron');
 const windows=['a','b'].map(id=>new BrowserWindow({show:false,webPreferences:{partition:'profile-smoke-'+id,contextIsolation:true,nodeIntegration:false,sandbox:true}}));
 for(const w of windows) await w.loadURL('about:blank');
 let saved=[];
 const profile=new BrowserCookieProfile([], cookies=>{saved=cookies;});
 const errors=[];
 const disconnect=[];
 for(const w of windows) disconnect.push(await connectPersonalProfile(w.webContents,()=>{if(w.isDestroyed())throw Error('closed');},e=>{errors.push(e);console.error('SYNC ERROR',e);},profile));
 
 const read=w=>w.webContents.debugger.sendCommand('Network.getAllCookies').then(r=>r.cookies);
 const wait=async(predicate)=>{const end=Date.now()+5000;while(!(await predicate())){if(Date.now()>end)throw Error('cookie sync deadline');await new Promise(r=>setTimeout(r,25));}};
 const base={name:'__Host-session',value:'synthetic-unpartitioned',domain:'example.test',path:'/',secure:true,httpOnly:true};
 await profile.importCookies([base]);
 assert.equal((await windows[1].webContents.session.cookies.get({})).length,1,'cookie must belong to the pane session');
 assert.equal((await read(windows[1]))[0].domain,'example.test');
 await windows[0].webContents.debugger.sendCommand('Network.setCookies',{cookies:[{name:base.name,value:'synthetic-partitioned',url:'https://example.test/',path:'/',secure:true,httpOnly:true,partitionKey:{topLevelSite:'https://top.test',hasCrossSiteAncestor:true}}]});
 
 await wait(async()=> (await read(windows[1])).some(c=>c.partitionKey?.topLevelSite==='https://top.test'));
 assert.equal((await read(windows[1])).length,2);
 await windows[0].webContents.debugger.sendCommand('Network.setCookies',{cookies:[{name:base.name,value:'',url:'https://example.test/',path:'/',secure:true,httpOnly:true,expires:1}]});
 assert.equal((await read(windows[0])).length,1);
 await wait(async()=> (await read(windows[1])).length===1);
 assert.equal((await read(windows[1]))[0].partitionKey?.topLevelSite,'https://top.test','deleting ordinary cookie must preserve partitioned peer');
 await windows[0].webContents.debugger.sendCommand('Network.deleteCookies',{name:base.name,domain:base.domain,path:'/',partitionKey:{topLevelSite:'https://top.test',hasCrossSiteAncestor:true}});
 await wait(async()=> (await read(windows[1])).length===0);
 assert.deepEqual(saved,[]); assert.deepEqual(errors,[]);
 assert.equal((await session.defaultSession.cookies.get({})).length,0,'default session must remain untouched');
 for(const stop of disconnect) await stop();
 for(const w of windows) w.destroy();
 console.log('PASS native Electron: keyring binding loads; host-only, partitioned cookies, propagation and logout');
 clearTimeout(deadline);app.quit();
}).catch(e=>{console.error(e.message);clearTimeout(deadline);app.exit(1);});`;
await build({stdin:{contents:source,resolveDir:repoRoot},outfile,bundle:true,platform:'node',format:'cjs',external:['electron','better-sqlite3','@napi-rs/keyring'],logLevel:'warning'});
const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,[outfile],{env,stdio:'inherit'});
const timeout = setTimeout(() => { console.error('Electron profile check timed out'); child.kill('SIGTERM'); }, 30_000);
child.on('exit', code => { clearTimeout(timeout); fs.rmSync(dir, { recursive:true, force:true }); process.exitCode=code??1; });
