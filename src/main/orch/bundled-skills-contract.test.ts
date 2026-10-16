import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTENT_PROVENANCES } from '../security/content-audit';
import { BUILTIN_BRIDGEMIND_SKILLS } from './bridge-mind-skills';
import { BUNDLED_MANIFESTS } from './skill-mirror';

/**
 * As skills embutidas têm DUAS fontes que andam juntas: o `SKILL.md` em
 * `assets/skills/<nome>/` e o manifest gerado por `scripts/bundle-skills.mjs`
 * (versionado). Editar o `SKILL.md` sem regerar o manifest faz o agente receber
 * o texto velho. Este arquivo trava isso e o contrato que as skills de papel
 * ensinam aos agentes (docs/SKILLS.md).
 */
const SKILLS_ROOT = fileURLToPath(new URL('../../../assets/skills', import.meta.url));

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function skillFiles(name: string): Map<string, Buffer> {
  const root = path.join(SKILLS_ROOT, name);
  const files = new Map<string, Buffer>();
  for (const file of walk(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    // Mesma exclusão do gerador: lixo do Finder nunca entra no bundle.
    if (relative.includes('.DS_Store')) continue;
    files.set(relative, fs.readFileSync(file));
  }
  return files;
}

describe('manifests embutidos seguem assets/skills (rode `node scripts/bundle-skills.mjs`)', () => {
  it.each(Object.keys(BUNDLED_MANIFESTS))('%s: mesmos arquivos e mesmos bytes', (name) => {
    const manifest = BUNDLED_MANIFESTS[name];
    const onDisk = skillFiles(name);
    expect([...Object.keys(manifest)].sort()).toEqual([...onDisk.keys()].sort());
    for (const [relative, asset] of Object.entries(manifest)) {
      const disk = onDisk.get(relative)!;
      if (asset.encoding === 'base64') {
        expect(Buffer.from(asset.content, 'base64').equals(disk), `${name}/${relative}`).toBe(true);
      } else {
        // O gerador grava a forma canônica LF, mesmo num checkout CRLF.
        expect(asset.content, `${name}/${relative}`).toBe(disk.toString('utf8').replace(/\r\n?/gu, '\n'));
      }
    }
  });
});

function manifestSkill(name: string): string {
  return BUNDLED_MANIFESTS[name]['SKILL.md'].content;
}

describe('skills de papel ensinam o contrato vigente de handoff, Git e revisão', () => {
  it('oc-pilot: modo de workspace, ACK em rodadas, portão formal e handoff sem missão', () => {
    const body = manifestSkill('oc-pilot');
    for (const token of [
      'isolatedWriter: true',
      'readOnly: true',
      'isolatedWorktree',
      'isolationFallback',
      'nexus_handoff_ack',
      'verdict: "rework"',
      'new round',
      'nexus_review_verdict',
      'satisfiesGate: false',
      'informative review',
      'no `nexus_handoff_ack`',
    ]) {
      expect(body, token).toContain(token);
    }
    // `oc-mcp` é skill do Overclock: o Nexus não a embarca.
    expect(body).not.toContain('`oc-mcp`');
  });

  it('oc-builder: caminhos explícitos no commit, faixa de Git do writer isolado e rodadas', () => {
    const body = manifestSkill('oc-builder');
    for (const token of [
      'nexus_git_add({ paths',
      'never `-A`, never `.`',
      '`git commit` takes only `-m`',
      'push, pull, stash, checkout, reset, clean',
      '[NEXUS_REWORK]',
      'new round',
      'status: "blocked"',
    ]) {
      expect(body, token).toContain(token);
    }
    expect(body).not.toContain('Never submit twice for the same task');
  });

  it('oc-scout e oc-conveyor: entregam texto, sem pedir nada ao humano', () => {
    for (const name of ['oc-scout', 'oc-conveyor']) {
      const body = manifestSkill(name);
      expect(body, name).toContain('read-only');
      expect(body, name).toContain('status: "blocked"');
    }
    const conveyor = manifestSkill('oc-conveyor');
    expect(conveyor).toContain('nexus_review_verdict');
    expect(conveyor).toContain('satisfiesGate: false');
  });
});

describe('bridgeward e bridgesecurity citam o que as auditorias aceitam', () => {
  const bodyOf = (name: string) =>
    BUILTIN_BRIDGEMIND_SKILLS.find((skill) => skill.name === name)!.body;

  it('bridgeward lista exatamente os valores de `provenance` da ferramenta', () => {
    const body = bodyOf('bridgeward');
    for (const value of CONTENT_PROVENANCES) expect(body, value).toContain(`\`${value}\``);
    // Os rótulos UPPER_SNAKE do upstream são recusados por `nexus_content_audit`.
    expect(body).not.toMatch(/\b(?:REPO_UNTRUSTED|WEB_PAGE|MCP_TOOL_RESULT|MCP_TOOL_DESCRIPTION)\b/u);
    expect(body).toContain('nexus_content_audit');
  });

  it('bridgesecurity aponta a auditoria de código e as severidades reais', () => {
    const body = bodyOf('bridgesecurity');
    expect(body).toContain('nexus_security_audit');
    for (const severity of ['critical', 'high', 'medium', 'low', 'info']) {
      expect(body, severity).toContain(severity);
    }
  });
});
