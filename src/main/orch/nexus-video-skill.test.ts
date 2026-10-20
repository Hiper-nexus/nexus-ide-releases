import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCaptionCues, buildNarrationTimeline, splitParagraphs, wordsFromAlignment } from '../../shared/captions';
import { HYPERFRAMES_VERSION } from '../video/video-engine';
import { BUNDLED_MANIFESTS } from './skill-mirror';

/** F-1597 — skill nexus-video: fluxo do Nexus + recorte das guias do HyperFrames. */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const manifest = BUNDLED_MANIFESTS['nexus-video'];
const skill = manifest['SKILL.md'].content;

describe('skill nexus-video', () => {
  it('é materializada pelo skill-mirror com a mesma versão que o motor fixa', () => {
    expect(manifest).toBeDefined();
    expect(skill).toMatch(/^---\nname: nexus-video\n/u);
    expect(skill).toContain(`npx hyperframes@${HYPERFRAMES_VERSION}`);
    expect(skill.match(/hyperframes@(\d+\.\d+\.\d+)/gu)?.every((pin) => pin === `hyperframes@${HYPERFRAMES_VERSION}`)).toBe(true);
  });

  it('ensina o fluxo com as ferramentas do Nexus e o custo antes de pagar', () => {
    for (const token of [
      'nexus_voiceover_generate',
      'dryRun: true',
      'WAIT for the operator',
      'nexus_voice_list',
      'nexus_music_generate',
      'narration.timeline.json',
      'timeline-to-clips.mjs',
      'nexus_video_render',
      'networkAccess',
      'nexus_video_export',
      'publishChecklist',
      'nexus_media_providers',
    ]) {
      expect(skill, token).toContain(token);
    }
  });

  it('as regras do Nexus vencem as guias: sem nuvem, sem atualização, sem clonar, Remotion só do projeto', () => {
    expect(skill).toContain('THIS FILE WINS');
    expect(skill).toContain('never `skills update`');
    expect(skill).toMatch(/never `auth login`, `cloud`, `lambda`, `cloudrun`/u);
    expect(skill).toContain('No tool clones a voice');
    expect(skill).toContain('`nexus_video_render` refuses one');
  });

  it('recorte: licença e NOTICE juntos, nada de nuvem, nenhum SKILL.md aninhado', () => {
    const files = Object.keys(manifest);
    expect(files).toContain('LICENSE-hyperframes.txt');
    expect(files).toContain('NOTICE.md');
    expect(manifest['LICENSE-hyperframes.txt'].content).toContain('Apache License');
    expect(manifest['NOTICE.md'].content).toContain('2a2a1d2d902aa837c5fc68b4ab28d5e747033a8e');
    expect(files.filter((file) => /(?:^|\/)(?:cloud|lambda|cloudrun)\.md$/u.test(file))).toEqual([]);
    expect(files.filter((file) => file.endsWith('SKILL.md'))).toEqual(['SKILL.md']);
    expect(files.some((file) => file.endsWith('.test.mjs'))).toBe(false);
    for (const guide of ['hyperframes/core/core.md', 'hyperframes/cli/cli.md', 'hyperframes/audio/audio.md', 'hyperframes/product-launch/references/story-design.md']) {
      expect(files, guide).toContain(guide);
    }
    const provenance = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'third_party', 'provenance', 'hyperframes-skills-v0.8.177.json'), 'utf8'),
    ) as { license: string; licenseFile: string; upstreamVersion: string };
    expect(provenance).toMatchObject({ license: 'Apache-2.0', upstreamVersion: HYPERFRAMES_VERSION });
    expect(fs.existsSync(path.join(ROOT, provenance.licenseFile))).toBe(true);
  });

  it('timeline-to-clips gera cenas por frase e as mesmas legendas que o SRT do Nexus', () => {
    const script = 'Olá, este é o Agendify. Ele organiza a agenda.\n\nMarque pelo celular hoje.';
    const paragraphs = splitParagraphs(script);
    const characters = [...paragraphs.join(' ')];
    const timeline = {
      audio: 'narration.mp3',
      ...buildNarrationTimeline(
        paragraphs,
        wordsFromAlignment({
          characters,
          character_start_times_seconds: characters.map((_, index) => index * 0.06),
          character_end_times_seconds: characters.map((_, index) => (index + 1) * 0.06),
        }),
        0,
      ),
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-video-skill-'));
    try {
      const file = path.join(dir, 'narration.timeline.json');
      fs.writeFileSync(file, JSON.stringify(timeline));
      const out = JSON.parse(
        execFileSync(process.execPath, [path.join(ROOT, 'assets/skills/nexus-video/scripts/timeline-to-clips.mjs'), file, '--max-chars', '20'], {
          encoding: 'utf8',
        }),
      ) as { scenes: Array<{ text: string; start: number }>; captions: Array<{ text: string; start: number }>; html: Record<string, string>; durationSec: number };
      expect(out.scenes.map((scene) => scene.text)).toEqual(timeline.sentences.map((sentence) => sentence.text));
      expect(out.scenes[0].start).toBe(timeline.sentences[0].startMs / 1000);
      const cues = buildCaptionCues(timeline.words, { maxChars: 20 });
      expect(out.captions.map((caption) => caption.text)).toEqual(cues.map((cue) => cue.text));
      expect(out.html.scenes).toContain('class="clip scene" data-start="');
      expect(out.html.audio).toContain('src="assets/narration.mp3"');
      expect(out.durationSec).toBeCloseTo((timeline.durationMs + 600) / 1000, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
