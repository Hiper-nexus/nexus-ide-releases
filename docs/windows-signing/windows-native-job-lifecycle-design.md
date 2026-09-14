# Windows PTY Job Object lifecycle — design for independent review

Status: DESIGN ONLY. No application/native source, third-party trust manifest, fuse, signing credential or process was modified. Read current AGENTS/security owners and PTY lifecycle code. Parent owns current Windows CI and unrelated fixes. Implementation must wait for independent design review.

## Decision

A Job Object can provide exact ownership and termination of the CLI's inherited Windows process cohort. Integrate at the existing ConPTY native creation boundary, retain the job handle in the utilityProcess, and return a bounded native zero-member receipt. Do not substitute CIM/PPID enumeration, console membership, `taskkill /T`, `process.kill(pid)`, or an enabled RunAsNode fuse.

Prefer **creation-time job assignment** with `PROC_THREAD_ATTRIBUTE_JOB_LIST` plus `CREATE_SUSPENDED`, followed by membership verification and `ResumeThread`. The requested two-call `CREATE_SUSPENDED → AssignProcessToJobObject → ResumeThread` prevents CLI execution before ownership but leaves an unassigned suspended process if the utilityProcess crashes between CreateProcess and assignment. Windows 10 supports the job-list process attribute; Nexus already targets a modern ConPTY/Electron Windows baseline. If job-list + pseudoconsole cannot be proven compatible on supported Windows builds, stop for review rather than silently fall back to an uncovered process.

## Exact provenance verified

- Installed wrapper: `@lydell/node-pty@1.2.0-beta.12` and matching platform package in package-lock.
- npm identifies lydell packaging commit `9ef881c5f15e1a56531e4e687c4984ca74e7f70b`. Its `build.js` copies native prebuilds/JS from exact dependency `node-pty@1.2.0-beta.12`; strips native source/binding.gyp from platform distribution.
- Original Microsoft npm tarball: `https://registry.npmjs.org/node-pty/-/node-pty-1.2.0-beta.12.tgz`, verified SRI `sha512-uExTCG/4VmSJa4+TjxFwPXv8BfacmfFEBL6JpxCMDghcwqzvD0yTcGmZ1fKOK6HY33tp0CelLblqTECJizc+Yw==`. This tarball contains exact C++/JS, binding.gyp and third-party ConPTY binaries. npm metadata did not expose a Microsoft gitHead; do not invent one.
- Lydell Windows x64 tarball independently fetched/verified against package-lock/registry SRI `sha512-IDFa00g7qUDGUYgByrUBJtC+mOjYVt/8KYyWivCg5JjGOHbBUACUQZLl0jTWmnr+tld/UyTpX90a2PY6oTVtRw==`.
- Byte comparison confirms both distributions have identical Windows agent/terminal JS, conpty.node and conpty.dll. Relevant SHA256 values:
  - `src/win/conpty.cc`: `d502cce570552c7a1bea373c7672975eeb330c3025dd151cf9c180ca2a1becc2` (Microsoft tarball).
  - `lib/windowsPtyAgent.js`: `1583dc8d41632d0a571d6b3ac27a7d58d445e359ad7799af042de6b5d50d68d0`.
  - `lib/windowsTerminal.js`: `d6bc0912ecfaf2857651965f887a37bfeb04c745c075e8d10b31cbf661d3aef3`.
  - x64 `conpty.node`: `2d1fb89aa74b692ad026807e78f90d970ef4e4b5b4b0254f94854f0f3f442306`.
  - x64 `conpty/conpty.dll`: `3319b484b80bb53d1f4d0a9eb0ea60fd0f61da69db7280ca43b84215f19245ff`.
- Read-only extracted sources: `/var/folders/zg/gtptvdln3l5b56b5qhx6p1rr0000gn/T/nexus-node-pty-source-5QbBaq/package`; split package comparison under sibling `lydell/package`. Source tarballs retained there for review, outside tracked tree.

## Current seams and why a one-line flag change is insufficient

1. `conpty.cc:412` invokes CreateProcessW with EXTENDED_STARTUPINFO_PRESENT and CREATE_UNICODE_ENVIRONMENT, no suspension or Job. `bInheritHandles=false` is explicitly intentional; preserve it. STARTUPINFOEX currently allocates one attribute for PSEUDOCONSOLE. Native source defines `_WIN32_WINNT 0x600`; patch must explicitly target validated Windows 10 SDK/job-list support.
2. `pty_baton` contains hShell, HPCON and pipe handles. `SetupExitCallback` waits on root hShell, closes it and erases baton from a global vector on a background thread as soon as root exits. New job state cannot inherit that lifetime or unsynchronized erase: root exit is not job empty, and concurrent lookup can invalidate the raw pointer.
3. JS `WindowsPtyAgent._completePtyConnection` is asynchronous. An IPty initially has pid=0 and no created root. Its 5-second fallback attempts connect even without the output worker ready. Native ConnectNamedPipe can then block the event loop. Cancellation must own a pending context and prevent later connect; timeout should fail/close pending state, not launch blindly.
4. Default JS kill forks `conpty_console_list_agent` and kills numeric returned PIDs. This requires the forbidden Electron-as-Node path and does not own detached descendants. `useConptyDll=true` skips that fork, but native kill closes the pseudoconsole and terminates only hShell. Force DLL mode for the reviewed job-backed Windows path and remove dependence on the PID sweep.
5. `WindowsTerminal` emits exit from socket close, not solely native root completion; data socket close may precede native proof. Nexus `pty-host-entry.ts` currently removes the map entry on onExit. Both layers need retain/finalize semantics so exact context remains available until cleanup proof or explicit failure.

## Native lifecycle contract

One unnamed, non-inheritable Job per PTY. Set only JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; never BREAKAWAY_OK or SILENT_BREAKAWAY_OK. Keep no name or assign/terminate handle exposed through IPC, env or argv. The utilityProcess owns the only job handle. Do not duplicate it into main: an extra live handle prevents last-close cleanup on utilityProcess crash.

Use a stable native context with initialized-invalid RAII handles, a generation/capability identity, a state machine and reference-counted worker lifetime. Serialize registry mutation on the N-API owner thread; native waiters hold shared context, not raw vector pointers. States: pending → creating-suspended → running → closing → drained/failed → disposed. No transition from closing/drained back to connect; context/ID reuse cannot revive authority.

At creation: allocate/set the Job; prepare two STARTUPINFOEX attributes (pseudoconsole, job list); create root suspended, noninheriting; verify IsProcessInJob(root handle, exact job) and persisted nonbreakaway/kill-on-close settings; register retained process/job context; resume once. CreateProcess, attribute, verification or ResumeThread failure terminates the exact newly created handle/job, waits for physical cleanup and closes handles. Never resume on failure and never fall back to unsupervised native spawn. Preserve current argv quoting, environment and ConPTY pipe behavior.

Expose only capability-bound native methods via the exact patched IPty object, e.g. `terminateOwnedJob(deadlineMs)` and `queryOwnedJob()`, plus a native tree-completion event. No `killJob(pid)` or caller-provided HANDLE/int authority. Timeouts are bounded/validated. Termination changes admission to closing, calls TerminateJobObject(exact handle), and polls QueryInformationJobObject BasicAccountingInformation plus BasicProcessIdList. Success requires root HANDLE signaled and successful consistent zero ActiveProcesses/zero returned+assigned process IDs, including nested jobs, after creation was resolved. A completion-port notification alone or a successful TerminateJobObject call is insufficient. Keep job handle open until proof is captured; closing it first destroys query authority.

On natural root exit, close the cohort by terminating remaining job members and collect the same proof before final native disposal. Retain a bounded completed receipt for late/duplicate terminate requests. Ordinary output draining is separate and bounded; output socket close cannot manufacture physical exit. On zero-query failure/timeout, report failed proof, still close job for cleanup, and never claim descendantsExited=true.

If killed while still pending: cancel deferred connect and prove no root creation occurred before returning a no-spawn receipt. If creation has started, use native context cancellation/failure cleanup, never infer from pid=0. Dispose pipe workers/resources in either case. Multiple terminate/kill calls share one context operation.

## Nexus integration ownership

- Native patch/source: new narrowly owned `native/windows-pty-job/` helper and a reviewed patch against exact `src/win/conpty.cc`; optional RAII/context helper to keep conpty.cc cohesive. Changes also required in exact Windows agent/terminal JS and local extension typings. Do not patch Darwin/Linux behavior.
- Build ownership: new `scripts/build-windows-pty-job.mjs` and verification tests/manifest, wired through existing `scripts/rebuild-electron-natives.mjs` and Forge package checks only after review. Exact input SRI/file SHA checks must reject unknown upstream versions/shapes. Stage a separately identified local patched Windows package/addon with provenance; do not relabel newly built bytes as the original npm prebuild or silently edit trust roots. Review the explicit generated-module packaging/trust integration before rollout.
- Adapter: new `src/main/pty/windows-pty-job.ts` (+ test) validates native API version and maps native owned receipt to existing PtyProcessTreeTerminationProof.
- Host: `pty-host-entry.ts` (+ host tests) stores native context/receipt with exact HostPtyEntry, uses it on Windows termination, and retains entry through root/socket exit until receipt/error. `pty-host-core.ts` tests verify duplicate request/session replacement/host-epoch fences. `pty-host-client.ts` preserves failed proof on host loss.
- Leave `pty-descendant-termination.ts` Windows inventory unsupported. Do not weaken its generic POSIX invariants to accept PID/CIM scans. No changes to RunAsNode or other Electron fuses.
- Proof maps `ok/rootExited/descendantsExited` only for the job-owned cohort. Attach internal method/version/state details for diagnostic evidence; no raw handles cross processes.

## Crash and scope limits

KILL_ON_JOB_CLOSE provides cleanup when the utilityProcess crashes, but that dead process cannot deliver an observed zero-member receipt. Keep main's host-down path fail-closed. If post-crash positive proof is required, that is a separate native guardian protocol design, not an invented success based on host death.

ConPTY/OpenConsole infrastructure is created by the utilityProcess before the CLI; it is not automatically inside the CLI Job. Close its exact HPCON and drain/terminate its known pipe worker separately; do not include unowned console-host PIDs in a sweep. Prove absence of console resource leaks through targeted test handles/diagnostics, not a broader process-kill authority.

No Job is a general security sandbox. Ordinary CreateProcess descendants, even detached/new-console/FreeConsole and nested jobs, stay in the nonbreakaway cohort. Brokered launches (e.g. WMI Win32_Process.Create, services, elevation brokers), same-user process manipulation or external daemons are not claimed to belong to it. Do not label this filesystem/network confinement or change existing OCI/sandbox capability status.

## Required native/Electron validation

A native fixture executable should create controlled children and return kernel process HANDLEs to a test driver which retains them for assertions/cleanup. Numeric PIDs may be logged diagnostically but must never authorize termination. Tests run both native Node binding and packaged Electron utilityProcess with RunAsNode=false.

- Child starts detached/new process group, calls FreeConsole, spawns a grandchild, root exits: job receipt must report zero; driver waits on retained child/grandchild handles. An unrelated sentinel launched directly by the test driver remains alive (including same-name sentinel and a second PTY cohort).
- Before first user instruction, fixture reports IsProcessInJob true. Inject failure before/after each create/assign/verify/resume step; failed paths execute no user marker. Crash utilityProcess during creation repeatedly; no running or suspended orphan root under job-list creation.
- Flood rapid grandchild creation while terminate runs; test nested child Jobs and explicit CREATE_BREAKAWAY_FROM_JOB attempt. Attempt must fail or remain in enclosing job, never detach from Nexus ownership.
- Kill before conout ready; force conout readiness timeout; root exits before socket closes and socket closes before native exit; repeated stop; reused session ID; two simultaneous PTYs; query failure; root exits with children holding output pipes; invalid/missing native API. No unbounded wait or false positive receipt.
- Crash/force-kill utility host: OS closes handle and test driver observes descendants stop; main still receives failed/unknown proof. Sentinel remains alive. Do not weaken that distinction.
- Run under hosted Windows runner parent Job, normal installed Windows and packaged Electron utilityProcess; test nested-job compatibility and unchanged standard-user execution without elevation. Unsupported assignment must fail closed with actionable OS error.
- Repeated create/close/leak stress and installed shell/CLI smoke (PowerShell, cmd, typical Node CLIs, real detached helper); no helper Electron process from child_process.fork, no flags re-enabling RunAsNode.

## Build/provenance and review gates

Lydell platform package omits C++/gyp, so it cannot simply be rebuilt in place. Build from the verified Microsoft source tarball plus a versioned local patch. Pin Node/node-gyp/node-addon-api, Electron headers/ABI, Windows SDK/MSVC including Spectre libraries, target x64, build flags and ConPTY DLL pair (upstream 1.25.260303002). Retain original MIT notices (Christopher Jeffrey, Daniel Imms, Microsoft and lydell packaging as applicable) and bundled terminal dependency licensing. No external npm publish is required.

Record source SRI, original file hashes, patch digest, compiler/tool versions, output PE hashes and signature provenance in candidate evidence. Run at least two clean native builds; if PE/debug timestamps prevent bit-for-bit output identity, report the difference rather than promise reproducibility. Never download a replacement native binary ad hoc after signature verification. Build and verify before Forge signs/packages, and prove packaged runtime loaded the intended patched addon; the original `conpty.node` basename/path lookup must be accounted for because LoadConptyDll currently uses GetModuleHandleA("conpty.node").

Independent reviewer must approve: atomic job-list choice vs suspended two-call gap; context lifetime/thread synchronization; capability API/no-PID authority; root/socket completion ordering; pending-connect cancellation; same-host crash semantics and stated broker limits; exact source/build/trust integration. Only then implement in bounded native, wrapper/host and build/test steps.

## Primary references checked

- [lydell pinned split-package build](https://github.com/lydell/node-pty/blob/9ef881c5f15e1a56531e4e687c4984ca74e7f70b/build.js) and exact npm tarballs/integrities above.
- [Microsoft process creation attribute list](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute): JOB_LIST supports Windows 10+, alongside process creation attributes.
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects): inheritance, breakaway flags, last-handle cleanup and WMI exception.
- [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject): access rights and nested job compatibility.
- [TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject), [QueryInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject) and [basic process list](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list): exact owned cohort operations and list sizing.
- [Nested jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs): parent/child job semantics and nested termination.

## Independent-review refinements and standalone spike

Accepted refinements: cancellation-aware/nonblocking ConnectNamedPipe; direct pre-connect cancellation bypassing WindowsTerminal deferred kill; native creation readiness independent of socket output; exactly one shutdown-safe shared context/finalizer; capability bound to host epoch/session generation; separately observed root exit/job-zero/console drain.

Standalone native spike now prepared under `native/windows-pty-job/` with a hosted read-only `.github/workflows/windows-native-job.yml`. It tests system CreatePseudoConsole + JOB_LIST + CREATE_SUSPENDED, retained-handle detached descendants, unrelated sentinel, root natural exit, kill-before-resume, creator-crash last-handle cleanup, negative assignment/query controls and cancelled pipe connection. This is not production addon integration; vendored DLL compatibility is a subsequent test. No native run is claimed before workflow execution.

Proposed exact generated-package location: `resources/native/windows-pty-job/win32-x64/` with conpty.node, reviewed patched JS, conpty/conpty.dll and OpenConsole.exe, and source/patch/toolchain/output manifest. Host Windows adapter must resolve that exact sealed package/resource location, reject missing capability/version/hash, and never search/fall back to original prebuilds. Preserve conpty.node basename for upstream module-relative DLL lookup. Production packaging/native trust integration remains independently reviewed work; no trust roots were edited by the spike.
