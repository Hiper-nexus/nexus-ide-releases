#!/usr/bin/env node
// timeline-to-clips — turn a Nexus narration timeline into HyperFrames clips.
//
//   node timeline-to-clips.mjs <narration.timeline.json> [--max-chars 28] [--tail-ms 600]
//
// Prints JSON: { durationSec, scenes[], captions[], html: { scenes, captions, audio } }.
// Scenes are the narration sentences; captions group words (script spelling)
// up to --max-chars, closing at sentence ends and pauses over 600 ms. Every
// number comes from the timeline written by nexus_voiceover_generate — never
// type timings by hand. No dependencies; reads one file, writes stdout.

import fs from 'node:fs';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index > 0 && process.argv[index + 1] ? Number(process.argv[index + 1]) : fallback;
}

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('uso: node timeline-to-clips.mjs <narration.timeline.json> [--max-chars 28] [--tail-ms 600]');
  process.exit(2);
}
const timeline = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(timeline.words) || !Array.isArray(timeline.sentences)) {
  console.error('arquivo sem words/sentences: use o narration.timeline.json do nexus_voiceover_generate');
  process.exit(2);
}
const maxChars = arg('--max-chars', 28);
const tailMs = arg('--tail-ms', 600);
const maxGapMs = 600;
const seconds = (ms) => Math.round(ms) / 1000;
const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const totalMs = Math.max(timeline.durationMs ?? 0, timeline.words.at(-1)?.endMs ?? 0) + tailMs;

const scenes = timeline.sentences.map((sentence, index) => {
  const next = timeline.sentences[index + 1];
  const endMs = next ? next.startMs : totalMs;
  return {
    id: `scene-${index + 1}`,
    text: sentence.text,
    start: seconds(sentence.startMs),
    duration: seconds(Math.max(1, endMs - sentence.startMs)),
  };
});

const captions = [];
let group = [];
const flush = () => {
  if (group.length === 0) return;
  captions.push({ startMs: group[0].startMs, endMs: group.at(-1).endMs, text: group.map((word) => word.text).join(' ') });
  group = [];
};
for (const word of timeline.words) {
  const last = group.at(-1);
  if (last) {
    const text = `${group.map((item) => item.text).join(' ')} ${word.text}`;
    if (word.sentence !== last.sentence || word.startMs - last.endMs > maxGapMs || text.length > maxChars) flush();
  }
  group.push(word);
}
flush();
const captionClips = captions.map((cue, index) => {
  const next = captions[index + 1];
  const endMs = next ? Math.min(cue.endMs, next.startMs) : cue.endMs;
  return { id: `cap-${index + 1}`, text: cue.text, start: seconds(cue.startMs), duration: seconds(Math.max(120, endMs - cue.startMs)) };
});

const clip = (tag, className, item, track) =>
  `<${tag} id="${item.id}" class="clip ${className}" data-start="${item.start}" data-duration="${item.duration}" data-track-index="${track}">${escape(item.text)}</${tag}>`;

const audio = timeline.audio
  ? `<audio id="narration" class="clip" src="assets/${escape(timeline.audio)}" data-start="0" data-duration="${seconds(totalMs)}" data-volume="1" data-track-index="9"></audio>`
  : '';

process.stdout.write(
  `${JSON.stringify(
    {
      durationSec: seconds(totalMs),
      scenes,
      captions: captionClips,
      html: {
        scenes: scenes.map((scene) => clip('section', 'scene', scene, 1)).join('\n'),
        captions: captionClips.map((cue) => clip('div', 'caption', cue, 2)).join('\n'),
        audio,
      },
    },
    null,
    2,
  )}\n`,
);
