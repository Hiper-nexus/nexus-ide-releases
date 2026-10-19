import { describe, expect, it } from 'vitest';
import { parseFfprobeJson } from './ffprobe';

describe('parseFfprobeJson', () => {
  it('lê duração, vídeo, áudio e etiquetas', () => {
    const probe = parseFfprobeJson(
      JSON.stringify({
        format: { duration: '30.033', size: '3412345', format_name: 'mov,mp4', tags: { DigitalSourceType: 'x' } },
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, avg_frame_rate: '30/1', pix_fmt: 'yuv420p', profile: 'High', disposition: { attached_pic: 0 } },
          { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
        ],
      }),
    );
    expect(probe).toEqual({
      durationSec: 30.033,
      sizeBytes: 3412345,
      formatName: 'mov,mp4',
      video: { codec: 'h264', width: 1080, height: 1920, fps: 30, pixFmt: 'yuv420p', profile: 'High' },
      audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
      tags: { digitalsourcetype: 'x' },
    });
  });

  it('sem stream de vídeo ou áudio devolve null nelas; fps 30000/1001', () => {
    expect(parseFfprobeJson('{"format":{},"streams":[]}')).toMatchObject({ video: null, audio: null, durationSec: null });
    const ntsc = parseFfprobeJson(JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1, height: 1, avg_frame_rate: '30000/1001' }] }));
    expect(ntsc.video?.fps).toBe(29.97);
  });
});
