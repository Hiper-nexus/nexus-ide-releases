import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { ProjectExecutionScope } from '../../../shared/types';
import { openWorkspaceFileForRead } from '../../orch/workspace-file';
import { redactSecretText } from '../../terminal/command-redaction';
import { getWorkspaceMemoryStore } from '../../memory/workspace-memory';
import { workspaceMemoryInjectionEnabled } from '../../memory/workspace-memory-context';

const MAX_DOC_BYTES = 65_536;
const PRODUCT_SECTION = /cliente|customer|p[úu]blico|audience|usu[aá]rios|users|proposta|valor|value|pre[çc]o|pricing|moneti|produto|product|objetivo|purpose|problem|neg[oó]cio|business/i;

/** Local quoted references; neither a repo file nor a model grants operator authority. */
export function businessProfileLines(scope: ProjectExecutionScope, projectScope?: ProjectExecutionScope): string[] {
  if (projectScope && (projectScope.projectId !== scope.projectId || projectScope.installationId !== scope.installationId)) projectScope = undefined;
  const lines: string[] = [];
  if (workspaceMemoryInjectionEnabled()) {
    try {
      for (const fact of getWorkspaceMemoryStore(projectScope ?? scope).activeBySource('trusted:business-fact').slice(-3)) {
        if (!fact.content.includes('Operator attestation (business-fact; workspace):')) continue;
        const title = /^# (.+)$/m.exec(fact.content)?.[1] ?? 'Negócio';
        const summary = /^Summary: (.+)$/m.exec(fact.content)?.[1];
        if (summary) lines.push(`- Fato confirmado pelo operador [${fact.id}]: ${title}: ${summary.slice(0, 220)}`);
      }
    } catch { /* No bank means no confirmed facts, never inferred authority. */ }
  }
  for (const source of ['PRODUCT.md', 'PRD.md']) {
    for (const target of [scope, ...(projectScope && projectScope.rootRealPath !== scope.rootRealPath ? [projectScope] : [])]) {
      let handle: ReturnType<typeof openWorkspaceFileForRead> | undefined;
      try {
        handle = openWorkspaceFileForRead(target, source);
        if (handle.stat.size > MAX_DOC_BYTES) continue;
        const buffer = Buffer.alloc(MAX_DOC_BYTES + 1);
        const count = fs.readSync(handle.fd, buffer, 0, buffer.length, 0);
        if (count !== handle.stat.size || count > MAX_DOC_BYTES) continue;
        const raw = buffer.subarray(0, count).toString('utf8');
        const hash = createHash('sha256').update(raw).digest('hex');
        let active = false, fenced = false, added = 0;
        raw.split(/\r?\n/).forEach((line, index) => {
          if (/^\s*```/.test(line)) { fenced = !fenced; return; }
          if (fenced) return;
          const heading = /^#{1,6}\s+(.+)$/.exec(line);
          if (heading) { active = PRODUCT_SECTION.test(heading[1]!); return; }
          if (!active || !line.trim() || added >= 2) return;
          lines.push(`- Referência não verificada [${source}:${index + 1}; sha256=${hash}]: ${redactSecretText(line.trim()).text.slice(0, 220)}`);
          added++;
        });
        break; // Execution checkout wins; do not mix versions of the same document.
      } catch { /* Missing/linked/invalid files confer no authority. */ }
      finally { handle?.close(); }
    }
  }
  return lines;
}
