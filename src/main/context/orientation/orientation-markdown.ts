import type { ProjectOrientationMap } from './orientation-types';

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 20))}\n\n…(truncated)`;
}

/**
 * Stable, prompt-ready orientation block. Order is fixed for cache friendliness.
 */
export function renderOrientationMarkdown(
  map: Omit<ProjectOrientationMap, 'orientationMarkdown' | 'mapHash'>,
  maxChars: number,
): string {
  const name = map.inventory.projectName ?? 'workspace';
  const head = map.headSha ? map.headSha.slice(0, 12) : 'no-git';
  const languages =
    map.inventory.languages
      .slice(0, 8)
      .map((lang) => `${lang.id} (${lang.files})`)
      .join(', ') || 'none detected';
  const scripts = Object.keys(map.inventory.scripts).sort().join(', ') || 'none';
  const entrypoints = map.inventory.entrypoints.slice(0, 8).join(', ') || 'none detected';

  const lines: string[] = [
    '# Project orientation',
    '',
    `- Project: ${name}`,
    `- HEAD: ${head}`,
    `- Status: ${map.status}`,
    `- Languages: ${languages}`,
    `- Package managers: ${map.inventory.packageManagers.join(', ') || 'unknown'}`,
    `- Scripts: ${scripts}`,
    `- Entrypoints: ${entrypoints}`,
    `- Files scanned: ${map.inventory.fileCount} (${map.inventory.sourceFileCount} source)`,
    '',
    '## Top directories',
  ];

  if (map.inventory.topDirs.length === 0) {
    lines.push('- (empty)');
  } else {
    for (const dir of map.inventory.topDirs.slice(0, 10)) {
      lines.push(`- ${dir.path} (${dir.files} files)`);
    }
  }

  lines.push('', '## Symbol hubs');
  if (map.symbols.hubs.length === 0) {
    lines.push('- (none extracted)');
  } else {
    for (const hub of map.symbols.hubs.slice(0, 16)) {
      const sample = hub.samplePaths[0] ? ` — ${hub.samplePaths[0]}` : '';
      lines.push(`- ${hub.name} (score ${hub.score})${sample}`);
    }
  }

  lines.push('', '## Import sketch');
  if (map.graph.mode === 'none' || map.graph.sampleEdges.length === 0) {
    lines.push('- (not built in this orientation pass)');
  } else {
    for (const edge of map.graph.sampleEdges.slice(0, 12)) {
      lines.push(`- ${edge.from} → ${edge.to} (${edge.relation})`);
    }
  }

  lines.push('', '## Docs & context readiness');
  lines.push(
    `- Present: ${map.docs.rootDocs.concat(map.docs.contextDocsPresent).slice(0, 12).join(', ') || 'none'}`,
  );
  lines.push(
    `- Missing context: ${map.docs.contextDocsMissing.slice(0, 8).join(', ') || 'none'}`,
  );
  lines.push(`- Ready: ${map.contextSummary.ready}`);
  lines.push(
    `- Blockers: ${map.contextSummary.blockerCodes.join(', ') || 'none'}`,
  );

  lines.push(
    '',
    '## Agent guidance',
    '- Prefer small diffs; reuse modules under the hubs above.',
    '- Structural map is orientation only — not mission authority.',
    '- Do not invent business rules; use nexus_context_doctor / drafts for authority.',
    '- Call nexus_code_map_get if you need the map again; nexus_code_map_refresh after large refactors.',
  );

  if (map.error) {
    lines.push('', `## Build notes`, `- ${map.error}`);
  }

  return truncate(lines.join('\n'), maxChars);
}
