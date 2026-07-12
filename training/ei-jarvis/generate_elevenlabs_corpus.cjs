#!/usr/bin/env node
/* Generate a small, diverse PT-BR wake-word corpus without exposing the API key. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const API_BASE = 'https://api.elevenlabs.io/v1';
const MODEL_ID = 'eleven_multilingual_v2';
const POSITIVE_TEXTS = ['Ei, Jarvis.', 'Ei Jarvis.', 'Jarvis.', 'Hey Jarvis.'];
const NEGATIVE_TEXTS = [
  'Ei, Java.',
  'Ei, Jason.',
  'Ei, Javis.',
  'Ei, Jardins.',
  'Ei, Travis.',
  'Ei, Jorge.',
  'Abrir o terminal.',
  'Bom dia.',
];
const SETTINGS = [
  { stability: 0.28, similarity_boost: 0.72, style: 0.05, use_speaker_boost: true },
  { stability: 0.48, similarity_boost: 0.78, style: 0.18, use_speaker_boost: true },
  { stability: 0.68, similarity_boost: 0.66, style: 0.32, use_speaker_boost: false },
];

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

function decryptKey() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('secure storage unavailable');
  const vault = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), '.nexus', 'secrets.enc'), 'utf8'),
  );
  const blob = vault['voice-env:ELEVENLABS_API_KEY'];
  if (typeof blob !== 'string') throw new Error('ElevenLabs key is not configured');
  return safeStorage.decryptString(Buffer.from(blob, 'base64')).trim();
}

function wavFromPcm16(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function checkedFetch(url, init) {
  let last;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, init);
    if (response.ok) return response;
    const detail = (await response.text()).slice(0, 300);
    last = new Error(`ElevenLabs HTTP ${response.status}: ${detail}`);
    if (response.status !== 429 && response.status < 500) break;
    await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
  }
  throw last;
}

async function main() {
  const output = path.resolve(arg('--output', path.join(__dirname, 'work', 'elevenlabs')));
  const perClass = Number.parseInt(arg('--per-class', '48'), 10);
  if (!Number.isInteger(perClass) || perClass < 1 || perClass > 500) {
    throw new Error('--per-class must be between 1 and 500');
  }
  const key = decryptKey();
  const voiceResponse = await checkedFetch(`${API_BASE}/voices`, {
    headers: { 'xi-api-key': key },
  });
  const payload = await voiceResponse.json();
  const voices = (payload.voices || []).filter((voice) => voice.voice_id);
  if (voices.length < 2) throw new Error('account needs at least two ElevenLabs voices');

  fs.mkdirSync(path.join(output, 'positive'), { recursive: true });
  fs.mkdirSync(path.join(output, 'negative'), { recursive: true });
  const classes = [
    ['positive', POSITIVE_TEXTS],
    ['negative', NEGATIVE_TEXTS],
  ];
  let generated = 0;
  for (const [kind, texts] of classes) {
    for (let index = 0; index < perClass; index += 1) {
      const voice = voices[index % voices.length];
      const text = texts[index % texts.length];
      const settings = SETTINGS[Math.floor(index / voices.length) % SETTINGS.length];
      const filename = `${kind}-eleven-${String(index).padStart(4, '0')}.wav`;
      const destination = path.join(output, kind, filename);
      if (fs.existsSync(destination) && fs.statSync(destination).size > 44) {
        generated += 1;
        continue;
      }
      const response = await checkedFetch(
        `${API_BASE}/text-to-speech/${encodeURIComponent(voice.voice_id)}?output_format=pcm_16000`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({ text, model_id: MODEL_ID, voice_settings: settings }),
        },
      );
      const pcm = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(destination, wavFromPcm16(pcm), { mode: 0o600 });
      generated += 1;
      if (generated % 12 === 0) process.stdout.write(`generated ${generated}\n`);
    }
  }
  process.stdout.write(`complete: ${generated} clips across ${voices.length} voices\n`);
}

app.whenReady().then(main).then(() => app.quit()).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  app.exit(1);
});
