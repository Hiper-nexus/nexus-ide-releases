/**
 * Derivado de oh-my-pi (omp) — packages/coding-agent/src/discovery/cline.ts
 * https://github.com/can1357/oh-my-pi @ 03c48d073bd4849726cc14750b5aecfa310bdf26 (MIT)
 * Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük — ver NOTICE.
 *
 * Provider Cline — prioridade 40. Só nível projeto (paridade omp).
 * Adaptação NexusIDE: sem walk-up de ancestrais — o .clinerules é procurado
 * apenas na raiz do workspace (arquivo único ou diretório com *.md).
 */
import path from 'node:path';
import {
  emptyProviderResult,
  type DiscoveryContext,
  type ProviderResult,
} from './types';

const SOURCE = 'cline' as const;

export function loadCline(ctx: DiscoveryContext): ProviderResult {
  const result = emptyProviderResult();

  const clinerules = path.join(ctx.workspaceRoot, '.clinerules');
  const kind = ctx.io.statKind(clinerules);
  if (kind === 'file') {
    // Formato arquivo único.
    result.contextFiles.push({
      source: SOURCE,
      level: 'project',
      path: clinerules,
      name: '.clinerules',
      kind: 'rule',
    });
  } else if (kind === 'dir') {
    // Formato diretório: todas as regras *.md.
    for (const filePath of ctx.io.walkFiles(clinerules, {
      extensions: ['md'],
      recursive: false,
    })) {
      result.contextFiles.push({
        source: SOURCE,
        level: 'project',
        path: filePath,
        name: path.basename(filePath),
        kind: 'rule',
      });
    }
  }

  return result;
}
