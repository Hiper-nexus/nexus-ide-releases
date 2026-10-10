/** WAV PCM16 mono 16 kHz com `seconds` de silêncio (ou cabeçalho declarando mais do que veio). */
export function syntheticWav(seconds: number, declaredSeconds = seconds): Buffer {
  const sampleRate = 16_000; const byteRate = sampleRate * 2;
  const data = Buffer.alloc(Math.round(seconds * byteRate));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(byteRate, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(Math.round(declaredSeconds * byteRate), 40);
  return Buffer.concat([header, data]);
}
