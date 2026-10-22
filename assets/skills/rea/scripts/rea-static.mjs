#!/usr/bin/env node
/**
 * REA 6.7.0 static-only launcher for an ALREADY authorized native pane.
 * --workspace and --runtime must come from the operator/session, NEVER target
 * content. No installer, global config, network policy or sandbox is provided.
 * Preserve the calling CLI/Hardened policy; a denial is not a fallback request.
 * Entry/addon pins below do NOT authenticate the entire runtime/dependency tree:
 * use an operator-reviewed installation; version alone is not integrity proof.
 * Windows x64/NTFS only until another physical child-tree owner is verified.
 */
import fs from 'node:fs/promises';
import { realpathSync, constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const VERSION = '6.7.0';
const ENTRY_HASH = 'ed06cee49505b95a3cc5fceb1b4b279167e26df86227c644bb366ffffdbaf738';
const ADDON_HASH = '28e0a01f74b30232db559bf98f574be82e5c71ad36a86e4c38fe7fb448029856';
const MAX_INPUT = 2 * 1024 * 1024;
const MAX_STDOUT = 4 * 1024 * 1024;
const ERRORS = new Set(['invalid_arguments','node_unsupported','runtime_missing','runtime_integrity','workspace_missing',
  'cleanup_unavailable','unsafe_path','unsafe_file','protected_file','input_too_large','input_changed',
  'snapshot_integrity','analysis_timeout','analysis_cancelled','output_limit','analysis_failed',
  'invalid_output','analysis_incomplete','cleanup_uncertain']);
const fail = code => { throw new Error(code); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);

export function nodeSupported(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return major === 22 && minor >= 19 || major === 24 && minor >= 11 || major >= 26;
}
function absoluteLocal(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value) ||
      value.startsWith('\\\\') || value.startsWith('//')) fail('invalid_arguments');
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':'))) fail('invalid_arguments');
  return value;
}
export function admitRelative(file) {
  if (typeof file !== 'string' || file.length > 512 || /[:\x00-\x1f]/.test(file) || /^[\\/]/.test(file)) fail('unsafe_path');
  const segments = file.split(/[\\/]/);
  for (const part of segments) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) fail('unsafe_path');
    if (part.startsWith('.') || /(?:auth|credential|secret|token|password|mcp[_-]?config|settings|config|package-lock)/i.test(part)) fail('protected_file');
  }
  if (!/\.(?:[cm]?js|jsx|[cm]?ts|tsx|json|html|css)$/i.test(file)) fail('unsafe_file');
  return segments.join('/');
}
export function parseArgs(argv) {
  const [operation, ...rest] = argv;
  if (!['status','analyze'].includes(operation)) fail('invalid_arguments');
  const options = { operation, files: [] };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index], value = rest[index + 1];
    if (!['--workspace','--runtime','--file'].includes(key) || !value || value.startsWith('--')) fail('invalid_arguments');
    if (key === '--file') options.files.push(admitRelative(value));
    else {
      const field = key.slice(2);
      if (options[field] !== undefined) fail('invalid_arguments');
      options[field] = absoluteLocal(value);
    }
  }
  if (!options.workspace || !options.runtime || options.files.length > 32 ||
      operation === 'analyze' && !options.files.length ||
      new Set(options.files.map(file => file.toLowerCase())).size !== options.files.length) fail('invalid_arguments');
  return options;
}
async function checkComponents(filename) {
  absoluteLocal(filename);
  const resolved = path.resolve(filename), root = path.parse(resolved).root;
  let current = root;
  for (const part of resolved.slice(root.length).split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) fail('unsafe_path');
  }
  return resolved;
}
async function validatedWorkspace(workspace) {
  try {
    await checkComponents(workspace);
    if (!(await fs.lstat(workspace)).isDirectory()) fail('unsafe_path');
    return await fs.realpath(workspace);
  } catch(error) {
    if(error.code==='ENOENT') fail('workspace_missing');
    throw error;
  }
}
export async function inspectFile(filename, maximum) {
  await checkComponents(filename);
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.nlink !== 1) fail('unsafe_file');
  if (stat.size > maximum) fail('input_too_large');
  return stat;
}
async function regularBytes(filename, maximum) {
  const before = await inspectFile(filename, maximum);
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) fail('input_changed');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) fail('input_changed');
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1) fail('input_changed');
    return bytes;
  } finally { await handle.close(); }
}
export async function runtimeStatus(runtime) {
  if (!nodeSupported(process.versions.node)) fail('node_unsupported');
  absoluteLocal(runtime);
  try { await fs.lstat(runtime); } catch (error) { if (error.code === 'ENOENT') fail('runtime_missing'); throw error; }
  try {
    await checkComponents(runtime);
    const metadata = JSON.parse(await regularBytes(path.join(runtime,'package.json'),1024*1024));
    if (metadata.name !== 'rea-agents' || metadata.version !== VERSION) fail('runtime_integrity');
    if (digest(await regularBytes(path.join(runtime,'scripts/rea.mjs'),128*1024)) !== ENTRY_HASH) fail('runtime_integrity');
    if (digest(await regularBytes(path.join(runtime,'native/windows/build/rea-windows-x64.node'),8*1024*1024)) !== ADDON_HASH) fail('runtime_integrity');
  } catch { fail('runtime_integrity'); }
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('cleanup_unavailable');
  return { ready:true, version:VERSION, integrity:'entry-and-windows-addon-only',
    limitations:['Operator-reviewed runtime required; dependencies and other modules are not authenticated by these two pins.',
      'No sandbox or new execution authority is granted. Windows x64 on local NTFS only.'] };
}
export async function loadAuthority(runtime) {
  await runtimeStatus(runtime);
  // No JS from the external runtime is imported into this launcher.
  return require(path.join(runtime,'native/windows/build/rea-windows-x64.node'));
}
export function childEnvironment(root, ambient = process.env) {
  const home = path.join(root,'home'), temp = path.join(root,'temp');
  return {
    ...(ambient.SystemRoot ? {SystemRoot:ambient.SystemRoot,WINDIR:ambient.SystemRoot} : {}),
    PATH:path.dirname(process.execPath), HOME:home, USERPROFILE:home, APPDATA:home, LOCALAPPDATA:home,
    TEMP:temp,TMP:temp,XDG_CONFIG_HOME:home,XDG_CACHE_HOME:home,XDG_DATA_HOME:home,
    npm_config_userconfig:path.join(home,'user.npmrc'),npm_config_globalconfig:path.join(home,'global.npmrc'),
    npm_config_cache:path.join(home,'npm-cache'),npm_config_ignore_scripts:'true',
    CI:'1',NO_UPDATE_NOTIFIER:'1',REA_LOG_LEVEL:'silent',REA_ANALYSIS_PROVIDER:'artifact',
  };
}
function quoteWindows(value) {
  if (value.includes('\0')) fail('invalid_arguments');
  return `"${value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')}"`;
}
/** Native CreateProcessW, no shell. The retained Job handle is the only kill authority. */
export async function runOwnedNode(binding, args, cwd, env, {timeoutMs=60000,maxStdoutBytes=MAX_STDOUT,signal}={}) {
  if(signal?.aborted) return {code:'analysis_cancelled',physicalExit:true,started:false,stdout:'',stderrBytes:0};
  const line = [process.execPath,...args].map(quoteWindows).join(' ');
  const child = binding.call('process_spawn',[process.execPath,line,cwd,Object.entries(env).map(([k,v])=>`${k}=${v}`),false,1024*1024*1024]);
  let stdout = Buffer.alloc(0), stderrBytes = 0, reason, physicalExit = false, exitCode = null;
  let stoppingAt;
  const start = Date.now();
  const stop = code => {
    if (!reason) reason = code;
    if (stoppingAt === undefined) { stoppingAt=Date.now(); binding.call('process_terminate',[child.handle]); }
  };
  try {
    if (!child.jobAssigned || !child.killOnOwnerClose) { stop('cleanup_uncertain'); }
    for (;;) {
      const observation = binding.call('process_poll',[child.handle]);
      exitCode = observation.exitCode;
      stderrBytes += observation.stderr.length; // Never retain or echo stderr bytes.
      if (stdout.length + observation.stdout.length > maxStdoutBytes || stderrBytes > 256*1024) stop('output_limit');
      const remaining = maxStdoutBytes - stdout.length;
      if (remaining > 0) stdout = Buffer.concat([stdout,observation.stdout.subarray(0,remaining)]);
      if (signal?.aborted) stop('analysis_cancelled');
      if (Date.now()-start >= timeoutMs) stop('analysis_timeout');
      if (exitCode !== null && observation.activeProcesses > 0) stop('analysis_failed');
      if (exitCode !== null && observation.activeProcesses === 0 && observation.stdoutEnded && observation.stderrEnded) {
        physicalExit=true; break;
      }
      if (stoppingAt !== undefined && Date.now()-stoppingAt > 10000) { reason='cleanup_uncertain'; break; }
      await delay(15);
    }
  } catch {
    reason='cleanup_uncertain';
    try { binding.call('process_terminate',[child.handle]); } catch { /* retained Job closes on owner exit */ }
  } finally {
    // With an unproved exit, callers retain the private files. Closing this
    // exact job kills only its descendants, but is NOT evidence they exited.
    try {binding.call('process_close',[child.handle]);} catch {physicalExit=false;reason='cleanup_uncertain';}
  }
  return { code:reason ?? (exitCode===0?'ok':'analysis_failed'),physicalExit,started:true,stdout:stdout.toString('utf8'),stderrBytes };
}
const COUNT_KEYS=['relevant_files','parsed_javascript_files','skipped_javascript_files','parse_failures','visited_ast_nodes','text_bytes_read','findings','modules'];
const IPC_KEYS=['operations','literal_channels','dynamic_channel_operations','renderer_transmissions','renderer_listeners','main_handlers','paired_renderer_transmissions','ambiguous_renderer_transmissions','unpaired_literal_renderer_transmissions'];
const FACT_KINDS=new Set(['ipc-handler','ipc-channel','javascript-module','electron-main','browser-window','context-bridge']);
const MAX_FACTS=128;
function projectFacts(graph,sourceFiles) {
  if(!Array.isArray(sourceFiles) || sourceFiles.length>32 ||
      sourceFiles.some(source=>typeof source!=='string') || new Set(sourceFiles).size!==sourceFiles.length) fail('invalid_output');
  const indexes=new Map(sourceFiles.map((source,index)=>[source,index]));
  const nodes=graph?.nodes ?? [];
  if(!Array.isArray(nodes)) fail('invalid_output');
  const facts=[];let omittedCount=0;
  const validPoint=point=>Number.isSafeInteger(point?.line) && point.line>=1 && point.line<=MAX_INPUT+1 &&
    Number.isSafeInteger(point?.column) && point.column>=0 && point.column<=MAX_INPUT;
  for(const node of nodes) {
    if(!FACT_KINDS.has(node?.kind) || !Array.isArray(node.observations)) continue;
    for(const observation of node.observations) {
      const location=observation?.evidence?.location;
      const range=location?.value;
      if(location?.available!==true || range?.kind!=='source-range' || !indexes.has(range.source) ||
          !validPoint(range.start) || !validPoint(range.end) || range.end.line<range.start.line ||
          range.end.line===range.start.line && range.end.column<range.start.column) continue;
      if(facts.length>=MAX_FACTS){omittedCount++;continue;}
      // No spread of producer data: even coordinates may carry extra fields.
      facts.push({kind:node.kind,sourceIndex:indexes.get(range.source),
        start:{line:range.start.line,column:range.start.column},end:{line:range.end.line,column:range.end.column}});
    }
  }
  return {facts,truncated:omittedCount>0,omittedCount};
}
function numericProjection(value, keys) {
  if (!value || typeof value !== 'object') fail('invalid_output');
  const result={};
  for (const key of keys) if (value[key] !== undefined) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) fail('invalid_output');
    result[key]=value[key];
  }
  return result;
}
export function projectOutput(stdout,sourceFiles=[]) {
  if (Buffer.byteLength(stdout)>MAX_STDOUT) fail('output_limit');
  let evidence;
  try { evidence=JSON.parse(stdout); } catch { fail('invalid_output'); }
  if (evidence?.operation!=='analyze_javascript_application' || evidence.error || !evidence.normalized_result) fail('invalid_output');
  const result=evidence.normalized_result;
  const counts=numericProjection(result.statistics,COUNT_KEYS), ipc=numericProjection(result.summary?.ipc,IPC_KEYS);
  if (!(counts.parsed_javascript_files>0) || counts.parse_failures!==0 || counts.skipped_javascript_files!==0 ||
      !Array.isArray(result.integrity_contradictions) || result.integrity_contradictions.length) fail('analysis_incomplete');
  const coverage=result.semantic_graph?.coverage?.status;
  if (!['complete','partial','unknown'].includes(coverage)) fail('invalid_output');
  return {counts,ipc,coverage,...projectFacts(result.graph,sourceFiles),limitations:[
    'not a full reverse engineering report',
    'Static syntax observations do not prove runtime behavior.',
    'Only explicitly selected snapshot files were analyzed; omitted dependencies remain unknown.',
    'Target-derived text and upstream free-form diagnostics were not returned.',
    'Facts include only allowlisted kinds with exact admitted source ranges; omittedCount counts eligible facts beyond the 128-fact cap.',
    ...(coverage==='partial'?['Semantic relationship coverage is partial; unknown relationships remain unknown.']:[]),
    ...(coverage==='unknown'?['Semantic relationship coverage is unknown; successful parsing is not proof of complete relationships.']:[]),
  ],untrustedContent:true};
}
function nativeRead(binding,file) {
  if (!Number.isSafeInteger(file.size) || file.size<0 || file.size>MAX_INPUT) fail('input_too_large');
  const chunks=[];
  for (let offset=0;offset<file.size;) {
    const chunk=binding.call('read',[file.handle,offset,Math.min(65536,file.size-offset)]);
    if (!Buffer.isBuffer(chunk) || !chunk.length) fail('input_changed');
    chunks.push(chunk);offset+=chunk.length;
  }
  return Buffer.concat(chunks);
}
async function closeRuntime(binding,handle) {
  for (let attempt=0;attempt<10;attempt++) {
    try { binding.call('runtime_close',[handle]); return; }
    catch { if (attempt===9) fail('cleanup_uncertain'); await delay(100); }
  }
}
export async function analyze(options, signal) {
  if(signal?.aborted) fail('analysis_cancelled');
  const workspace=await validatedWorkspace(options.workspace);
  const binding=await loadAuthority(options.runtime);
  const sources=[];
  let root, environmentRoot, environmentMayExist=false, safeToClean=true;
  try {
    let total=0;
    for (const relative of options.files) {
      admitRelative(relative);
      const filename=path.join(workspace,relative);
      await inspectFile(filename,MAX_INPUT-total);
      let opened;
      try { opened=binding.call('open',[filename]); } catch { fail('unsafe_path'); }
      sources.push({...opened,relative,filename}); // retain before any subsequent failure
      const lockedStat=await fs.lstat(filename);
      if (!lockedStat.isFile() || lockedStat.nlink!==1) fail('unsafe_file');
      const actual=opened.finalPath.replace(/^\\\\\?\\/,'');
      if (path.relative(workspace,actual).startsWith('..') || path.isAbsolute(path.relative(workspace,actual))) fail('unsafe_path');
      // NTFS 8.3 can hide a protected basename/ancestor behind an innocent
      // spelling. Apply policy to the handle's final name BEFORE reading bytes,
      // and reject aliases rather than silently changing the selected source.
      const canonicalRelative=admitRelative(path.relative(workspace,actual).split(path.sep).join('/'));
      if(canonicalRelative.toLowerCase()!==relative.toLowerCase()) fail('unsafe_path');
      total+=opened.size;
      if (total>MAX_INPUT) fail('input_too_large');
    }
    root=binding.call('runtime_create',[workspace,'.rea-static-']);
    for (const dir of ['snapshot','environment']) binding.call('runtime_mkdir',[root.handle,dir]);
    // The native Runtime retains DELETE access to its root (and immutable file
    // handles). REA cannot reopen that root as an ancestor of its own native
    // temp. Move an EMPTY, native-created private-DACL directory to a unique
    // sibling before starting any child. This preserves the ACL and lets REA
    // create its own private runtime without weakening snapshot handle locks.
    environmentRoot=`${root.path}-env`;
    try { await fs.lstat(environmentRoot); fail('unsafe_path'); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    environmentMayExist=true;
    await fs.rename(path.join(root.path,'environment'),environmentRoot);
    for(const dir of ['home','temp']) await fs.mkdir(path.join(environmentRoot,dir),{mode:0o700});
    const directories=new Set();const sourceDigests=[];
    for (const [index,source] of sources.entries()) {
      const relative=`snapshot/${source.relative}`;
      const parts=relative.split('/');parts.pop();
      for (let depth=2;depth<=parts.length;depth++) {
        const directory=parts.slice(0,depth).join('/');
        if(!directories.has(directory)){binding.call('runtime_mkdir',[root.handle,directory]);directories.add(directory);}
      }
      const bytes=nativeRead(binding,source), hash=digest(bytes);
      binding.call('runtime_write',[root.handle,relative,bytes]);
      const snapshot=binding.call('runtime_open',[root.handle,relative]);
      try { if(digest(nativeRead(binding,snapshot))!==hash) fail('snapshot_integrity'); }
      finally {binding.call('close',[snapshot.handle]);}
      sourceDigests.push({index,sha256:hash,bytes:bytes.length});
    }
    // Keep all source handles and native immutable snapshot handles until exit.
    const snapshot=path.join(root.path,'snapshot');
    if(signal?.aborted) fail('analysis_cancelled');
    safeToClean=false;
    let result;
    try {
      result=await runOwnedNode(binding,[path.join(options.runtime,'scripts/rea.mjs'),'analyze-javascript-application',snapshot,
        '--artifact-format','directory','--max-heap-mb','256','--analysis-timeout-ms','15000','--json'],snapshot,childEnvironment(environmentRoot),{signal});
    } catch {fail('cleanup_uncertain');}
    safeToClean=result.physicalExit;
    if(!result.physicalExit) fail('cleanup_uncertain');
    if(result.code!=='ok') fail(result.code);
    const projection=projectOutput(result.stdout,options.files);
    return {ok:true,mode:'static-only',version:VERSION,...projection,
      limitations:[...projection.limitations,'Private environment retained: no handle-bound removal is available; automatic pathname deletion is disabled.'],
      sourceDigests,physicalExit:true,cleanupComplete:false,retainedEnvironment:true,cleanupReason:'environment_retained'};
  } catch(error) {
    if(environmentMayExist) {
      const failure=new Error(ERRORS.has(error?.message)?error.message:'analysis_failed');
      failure.cleanupComplete=false;
      failure.retainedEnvironment=true;
      failure.cleanupReason='environment_retained_or_unverified';
      throw failure;
    }
    throw error;
  } finally {
    let sourceCloseFailed=false;
    for(const source of sources) {
      try {binding.call('close',[source.handle]);} catch {sourceCloseFailed=true;}
    }
    // Snapshot removal is bound to the retained native owner. The relocated
    // environment has no such owner: even a matching lstat would race a rename.
    // Never inspect-and-remove that reusable pathname, on success OR failure.
    if(safeToClean && root) await closeRuntime(binding,root.handle);
    if(sourceCloseFailed) fail('cleanup_uncertain');
    // Uncertain physical exit: deliberately keep the private snapshot; never
    // delete files a surviving process could still use or claim cleanup success.
  }
}
async function main() {
  try {
    const options=parseArgs(process.argv.slice(2));
    const controller=new AbortController();
    const cancel=()=>controller.abort();
    process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
    let result;
    try {
      if(options.operation==='status') {
        await validatedWorkspace(options.workspace);
        result={ok:true,...await runtimeStatus(options.runtime)};
      } else result=await analyze(options,controller.signal);
    } finally {process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch(error) {
    const code=ERRORS.has(error?.message)?error.message:'analysis_failed';
    process.stdout.write(`${JSON.stringify({ok:false,code,version:VERSION,
      cleanupComplete:code!=='cleanup_uncertain' && error?.cleanupComplete!==false,
      retainedEnvironment:error?.retainedEnvironment===true?true:code==='cleanup_uncertain'?null:false,
      ...(error?.cleanupReason==='environment_retained_or_unverified'?{cleanupReason:error.cleanupReason}:{})})}\n`);
    process.exitCode=1;
  }
}
if(process.argv[1] && realpathSync.native(process.argv[1])===realpathSync.native(fileURLToPath(import.meta.url))) await main();
