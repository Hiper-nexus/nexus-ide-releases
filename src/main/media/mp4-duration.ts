/**
 * Duração de um MP4 lida da caixa `mvhd` (cabeçalho do filme, dentro de
 * `moov`). O Gemini Omni decide quanto dura o vídeo e cobra por segundo
 * gerado (F-1587): o custo do recibo usa este número. `null` quando o arquivo
 * não tem um `mvhd` legível — nunca um chute.
 */

interface Mp4Box {
  type: string;
  /** Início do conteúdo (depois do cabeçalho). */
  start: number;
  end: number;
}

function* mp4Boxes(data: Buffer, from: number, to: number): Generator<Mp4Box> {
  let offset = from;
  while (offset + 8 <= to) {
    let size = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > to) return;
      const large = data.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return;
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < header || offset + size > to) return;
    yield { type, start: offset + header, end: offset + size };
    offset += size;
  }
}

export function mp4DurationSeconds(data: Buffer): number | null {
  for (const box of mp4Boxes(data, 0, data.length)) {
    if (box.type !== 'moov') continue;
    for (const child of mp4Boxes(data, box.start, box.end)) {
      if (child.type !== 'mvhd') continue;
      const version = data[child.start];
      // versão 0: criação, modificação (32 bits cada), escala, duração 32 bits;
      // versão 1: as datas e a duração em 64 bits.
      const timescaleAt = child.start + (version === 1 ? 20 : 12);
      const durationAt = timescaleAt + 4;
      if (durationAt + (version === 1 ? 8 : 4) > child.end) return null;
      const timescale = data.readUInt32BE(timescaleAt);
      const duration =
        version === 1
          ? Number(data.readBigUInt64BE(durationAt))
          : data.readUInt32BE(durationAt);
      const unknown = version === 1 ? !Number.isSafeInteger(duration) : duration === 0xffffffff;
      if (timescale === 0 || duration === 0 || unknown) return null;
      return Math.round((duration / timescale) * 1000) / 1000;
    }
    return null;
  }
  return null;
}
