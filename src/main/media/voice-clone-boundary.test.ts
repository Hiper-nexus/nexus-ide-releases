import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * F-1593 — critério de aceite do estúdio de vídeo: "não existe caminho MCP
 * que crie voz". Só o Main de "Minha voz" fala com `/v1/voices/add`, e nada
 * do MCP (src/main/orch) importa o fluxo de clonagem nem o recibo.
 */

const SRC = path.resolve(__dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) out.push(full);
  }
  return out;
}

describe('fronteira: nenhum caminho MCP cria voz', () => {
  const all = sources(SRC);

  it('só voice-clone.ts chama a criação de voz da ElevenLabs', () => {
    const callers = all
      .filter((file) => fs.readFileSync(file, 'utf8').includes('/v1/voices/add'))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'));
    expect(callers).toEqual(['main/media/voice-clone.ts']);
  }, 60_000);

  it('nada em src/main/orch importa o fluxo de clonagem ou o recibo', () => {
    const offenders = all
      .filter((file) => file.includes(`${path.sep}main${path.sep}orch${path.sep}`))
      .filter((file) => /from ['"][./]*(?:\.\.\/)*media\/voice-(?:clone|consents)(?:-ipc)?['"]/u.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  }, 60_000);

  it('o registro real de ferramentas não tem ferramenta de clonar, criar ou apagar voz', async () => {
    const { buildToolset } = await import('../orch/tools');
    const names = buildToolset().map((tool) => tool.name);
    expect(names).toContain('nexus_voice_list');
    expect(names.filter((name) => /clone|voice_(?:add|create|delete|remove)/u.test(name))).toEqual([]);
  }, 60_000);
});
