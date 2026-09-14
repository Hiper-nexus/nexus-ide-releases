# Windows Job + ConPTY native spike

Independent test executable only. No production addon integration, no fuse change,
no signing or publication. Requires Windows 10+ x64, MSVC and Windows SDK.

Acceptance tests, written before implementation:

1. Create a root suspended with both PSEUDOCONSOLE and JOB_LIST attributes;
   prove exact job membership before resume. After explicit native readiness,
   a marker must traverse that exact pseudoconsole output pipe (output is not
   used as creation readiness). Its detached child and grandchild
   remain in the job, including a nested child job and after the root exits naturally.
2. An unrelated sentinel outside the target job survives target termination.
   All assertions and cleanup use retained process/job handles, never a PID sweep.
3. An explicit breakaway attempt either fails with access denied or remains
   in the same enclosing target job.
4. Kill before resume: no user marker runs, root signals and job count becomes zero.
5. Kill the creator process before resume and after descendants start: last job
   handle closure stops its cohort. The observer retains process handles only,
   never a duplicate job handle. A separate fixture safety job contains test
   processes if the whole test driver dies.
6. Omitted target-job assignment is a negative control: membership must fail
   (the suspended fixture remains in a separate safety job). Invalid-handle
   queries must fail, not become a zero-member receipt. A pipe connection with
   no peer must time out and cancel safely.

`run.ps1` compiles the fixture, records compiler/SDK versions, executes it with
an outer bounded timeout and preserves logs. The workflow runs on hosted Windows
without application credentials. The spike currently uses the system CreatePseudoConsole API. A later production
validation must repeat the combination with the pinned vendored ConPTY DLL.

Native compilation/execution cannot be claimed
from macOS source review; the first workflow run is the actual validation.

## Scope and next production integration (design, not implemented)

This tests inherited process cohort ownership, not filesystem/network confinement
or broker-created service/WMI/elevated processes. ConPTY infrastructure has its own
handle/drain lifecycle. Creator death guarantees cleanup but cannot itself deliver
a positive native query receipt to main.

Production refinement requirements accepted in independent review:

- Nonblocking cancellable ConnectNamedPipe; a timeout cancels instead of forcing
  deferred connect. Cancellation before creation bypasses WindowsTerminal's
  deferred-kill queue.
- Explicit native creation readiness (membership + resume), independent of output.
- One shutdown-safe context/finalizer, with stable shared lifetime through native
  waits; no background-thread erase of a live raw baton pointer.
- Opaque capability is bound to host epoch and session generation. No numeric PID
  or raw handle accepted across app IPC as kill authority.
- Keep root exit, job-zero receipt and console-drain completion separate.

Proposed loading location: build a separately identified local package under
`resources/native/windows-pty-job/win32-x64/`, containing `conpty.node`,
`conpty/conpty.dll`, `conpty/OpenConsole.exe`, reviewed patched Windows JS and a
provenance manifest. The immutable host adapter chooses this exact package on
Windows; Mac/Linux retain @lydell. Preserve the `conpty.node` basename because
upstream DLL loading uses GetModuleHandleA. Production packaging must resolve
native files from the explicit app.asar.unpacked/resource location and validate
original source SRI, patch digest, toolchain and output hashes before signing.
No arbitrary search path/fallback to unpatched prebuilds. Final location and
trust/seal integration require review before implementing that production step.

Exact verified upstream provenance and full design remain in the task's
`windows-native-job-lifecycle-design.md`. This spike uses Windows SDK APIs only,
not copied or patched third-party implementation code.

## First native-run diagnosis

Run 34852749384 compiled successfully with MSVC 19.51.36256, SDK 10.0.26100
and /WX, then reproduced ERROR_INVALID_HANDLE at the root console assertion.
The fixture driver intentionally redirects stdout/stderr to evidence files.
Without STARTF_USESTDHANDLES plus null standard handles, Windows can carry
those redirected defaults into the pseudo-console client instead of creating
ConPTY handles. The spawn helper now follows the exact node-pty startup policy
for ConPTY launches, retaining bInheritHandles=false, JOB_LIST and suspension.
The existing GetConsoleMode assertion and exact-pipe marker remain mandatory;
no assertion was weakened. The rerun is still required to establish success.
See [Microsoft Terminal's documented diagnosis](https://github.com/microsoft/terminal/discussions/15814).
