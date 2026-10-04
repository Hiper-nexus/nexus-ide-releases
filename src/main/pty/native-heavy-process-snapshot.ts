import path from 'node:path';
import { execFile } from 'node:child_process';
import { captureDescendantSnapshot, collectDescendantRows, createProcessTableSnapshotReader,
  type ProcessTableRow, type ProcessTableCapture, type DescendantSnapshot } from './pty-descendant-termination';

/** No command text or environment is requested from CIM, only kernel lineage
 * and immutable creation identity. An incomplete inventory is never exit proof. */
export function parseWindowsCommandProcesses(raw: string): ProcessTableRow[] {
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data) || data.length > 131_072) throw new Error('invalid command process inventory');
  const seen = new Set<number>();
  return data.map((value) => {
    const row = value as { pid?: unknown; ppid?: unknown; startedAt?: unknown };
    if (!row || !Number.isSafeInteger(row.pid) || Number(row.pid) <= 0 || !Number.isSafeInteger(row.ppid) || Number(row.ppid) < 0 ||
      typeof row.startedAt !== 'string' || !Number.isFinite(Date.parse(row.startedAt)) || seen.has(Number(row.pid))) throw new Error('ambiguous command process inventory');
    seen.add(Number(row.pid));
    return { pid: Number(row.pid), ppid: Number(row.ppid), startedAt: row.startedAt, pgid: 0, sid: 0, tty: '?' };
  });
}

const WINDOWS_PROCESS_QUERY = "$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object { if ($null -eq $_.CreationDate) { throw 'incomplete process identity' }; @{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;startedAt=$_.CreationDate.ToUniversalTime().ToString('o')} }); ConvertTo-Json -InputObject $rows -Compress";
const readWindowsProcesses = createProcessTableSnapshotReader((timeoutMs = 1_500) => {
  const capturedAtMs = Date.now();
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise<ProcessTableCapture>((resolve, reject) => execFile(powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY],
    { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path.win32.join(systemRoot, 'System32') } },
    (error, output) => { if (error) { reject(error); return; } try { resolve({ rows: parseWindowsCommandProcesses(output.replace(/^\uFEFF/, '')), capturedAtMs }); } catch (failure) { reject(failure); } }));
});

export async function captureNativeHeavyProcessSnapshot(pid: number): Promise<DescendantSnapshot | null> {
  if (process.platform !== 'win32') return captureDescendantSnapshot(pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { const table = await readWindowsProcesses(1_500); return collectDescendantRows(pid, table.rows, table.capturedAtMs); }
  catch { return null; }
}
