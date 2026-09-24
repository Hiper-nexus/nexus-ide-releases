/**
 * `nexus_skills` — instalar/remover skill em cada CLI/conta (paridade
 * Overclock OVKA-702). Ato de interface: uma chamada, resposta dizendo onde
 * pousou (instalada / já estava / falhou). Nunca shell, nunca scan de disco.
 *
 * Skill ausente do bundle → aponta o catálogo; não inventa payload.
 */

import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { McpToolDef } from './mcp-protocol';
import { assertMcpInvocationCurrent } from './mcp-protocol';
import { BUNDLED_GUIDED_SKILLS } from './guided-squad-skills';
import { bundledSkillSourceDir } from './skill-mirror';

const skillOpsArgsSchema = z
  .object({
    op: z.enum(['install', 'remove', 'list']),
    name: z.string().min(1).max(64).optional(),
    /** Restringe a um CLI (ex. "claude"); omitido = todos os conhecidos. */
    cli: z.string().min(1).max(64).optional(),
  })
  .strict();

const CLI_SKILL_DIRS: ReadonlyArray<{ cli: string; dir: string }> = [
  { cli: 'claude', dir: path.join(os.homedir(), '.claude', 'skills') },
  { cli: 'codex', dir: path.join(os.homedir(), '.codex', 'skills') },
  { cli: 'agents', dir: path.join(os.homedir(), '.agents', 'skills') },
  { cli: 'gemini', dir: path.join(os.homedir(), '.gemini', 'skills') },
  { cli: 'kimi', dir: path.join(os.homedir(), '.kimi', 'skills') },
];

function bundledSkillSourcePath(name: string): string | null {
  if (!BUNDLED_GUIDED_SKILLS.includes(name as (typeof BUNDLED_GUIDED_SKILLS)[number])) {
    return null;
  }
  // F-641: o app empacotado não tem pasta solta de skills — só os manifestos
  // que o skill-mirror materializa na raiz gerada do Main.
  return bundledSkillSourceDir(name);
}

function listTargets(cliFilter?: string): Array<{ cli: string; dir: string }> {
  return CLI_SKILL_DIRS.filter((t) => (cliFilter ? t.cli === cliFilter : true));
}

/**
 * Nome de skill é slug, nunca path. `../`, separadores e nomes vazios são
 * recusados ANTES de tocar o disco — path traversal em `path.join(dir, name)`.
 */
function requireSafeSkillName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > 64) {
    throw new Error('nexus_skills: name inválido (1–64 chars)');
  }
  if (
    name !== path.basename(name) ||
    name.includes('..') ||
    name.includes('\0') ||
    name.startsWith('.')
  ) {
    throw new Error(
      `nexus_skills: name inválido (${raw}) — use o slug da skill, nunca um path`,
    );
  }
  return name;
}

export const skillOpsTool: McpToolDef = {
  name: 'nexus_skills',
  description:
    'Install or remove a bundled app skill in every CLI skill dir (or only ' +
    '`cli`). Interface act: runs now, answers per CLI where it landed ' +
    '(instalada / já estava / falhou / fora do bundle). A skill that does not ' +
    'ship with the app is refused with a pointer to the catalog — never ' +
    'invented. op=list shows what is present. No shell, no disk scan of the ' +
    'user home beyond the known skill dirs.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['install', 'remove', 'list'] },
      name: { type: 'string', description: 'Bundled skill name (e.g. oc-pilot).' },
      cli: { type: 'string', description: 'Optional CLI filter: claude|codex|agents|gemini|kimi.' },
    },
    required: ['op'],
    additionalProperties: false,
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const parsed = skillOpsArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      throw new Error(
        `nexus_skills: argumentos inválidos: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    const input = parsed.data;

    if (input.op === 'list') {
      const rows = listTargets(input.cli).map((t) => {
        let present: string[] = [];
        try {
          present = fs.readdirSync(t.dir).filter((n) => !n.startsWith('.'));
        } catch {
          present = [];
        }
        // Privacidade: o agente vê o CLI e os nomes — nunca o HOME absoluto.
        return { cli: t.cli, skills: present };
      });
      return Object.freeze({ ok: true, rows });
    }

    if (!input.name?.trim()) {
      throw new Error('nexus_skills: name é obrigatório para install/remove');
    }
    const name = requireSafeSkillName(input.name);
    const source = bundledSkillSourcePath(name);
    if (input.op === 'install' && !source) {
      return Object.freeze({
        ok: false,
        name,
        reason:
          `skill '${name}' não embarca com o app — instale pelo catálogo ` +
          '(nexus_catalog_install) ou Skills da interface; nada foi copiado',
        bundled: [...BUNDLED_GUIDED_SKILLS],
      });
    }
    // remove só de skill que o APP embarca — nunca apaga skill do usuário.
    if (
      input.op === 'remove' &&
      !BUNDLED_GUIDED_SKILLS.includes(name as (typeof BUNDLED_GUIDED_SKILLS)[number])
    ) {
      return Object.freeze({
        ok: false,
        name,
        reason:
          `remove só vale para skills embarcadas; '${name}' não é do app — ` +
          'nada foi apagado (a skill do usuário permanece)',
      });
    }

    const results = listTargets(input.cli).map((t) => {
      const target = path.join(t.dir, name);
      try {
        if (input.op === 'remove') {
          if (!fs.existsSync(target)) {
            return { cli: t.cli, status: 'já estava ausente' as const };
          }
          fs.rmSync(target, { recursive: true, force: true });
          return { cli: t.cli, status: 'removida' as const };
        }
        if (fs.existsSync(target)) {
          return { cli: t.cli, status: 'já estava' as const };
        }
        fs.mkdirSync(t.dir, { recursive: true, mode: 0o700 });
        fs.cpSync(source!, target, { recursive: true });
        return { cli: t.cli, status: 'instalada' as const };
      } catch (err) {
        return {
          cli: t.cli,
          status: 'falhou' as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });

    void ctx;
    return Object.freeze({
      ok: results.every((r) => r.status !== 'falhou'),
      name,
      op: input.op,
      results,
    });
  },
};
