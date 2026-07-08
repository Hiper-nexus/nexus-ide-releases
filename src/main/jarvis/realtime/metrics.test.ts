import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JarvisLatencyTracker, JarvisMetricsLogger } from './metrics';

describe('JarvisMetricsLogger', () => {
  it('honors the test/runtime metrics file override', () => {
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-metrics-')),
      'override.log',
    );
    const previous = process.env.NEXUS_JARVIS_METRICS_FILE;
    process.env.NEXUS_JARVIS_METRICS_FILE = filePath;
    try {
      const logger = new JarvisMetricsLogger({
        now: () => new Date('2026-07-07T12:00:00.000Z'),
      });

      logger.log('roundtrip_ms', 99, 's-env');

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toContain('"session_id":"s-env"');
    } finally {
      if (previous === undefined) delete process.env.NEXUS_JARVIS_METRICS_FILE;
      else process.env.NEXUS_JARVIS_METRICS_FILE = previous;
    }
  });

  it('writes metrics as JSONL records', () => {
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-metrics-')),
      'jarvis-metrics.log',
    );
    const logger = new JarvisMetricsLogger({
      filePath,
      now: () => new Date('2026-07-07T12:00:00.000Z'),
    });

    logger.log('roundtrip_ms', 420.4, 's1');

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({
      ts: '2026-07-07T12:00:00.000Z',
      metric: 'roundtrip_ms',
      value: 420,
      session_id: 's1',
    });
  });
});

describe('JarvisLatencyTracker', () => {
  it('derives transcript, audio and roundtrip latency metrics from turn events', () => {
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-metrics-')),
      'jarvis-metrics.log',
    );
    let wall = 0;
    const logger = new JarvisMetricsLogger({
      filePath,
      now: () => new Date('2026-07-07T12:00:00.000Z'),
    });
    const tracker = new JarvisLatencyTracker(logger, () => wall);

    tracker.markAudioIn('s1');
    wall = 120;
    tracker.markTranscript('s1', false);
    wall = 180;
    tracker.markTranscript('s1', true);
    wall = 220;
    tracker.markAction('s1');
    wall = 260;
    tracker.markAudioOut('s1');
    wall = 420;
    tracker.markResponseDone('s1');

    const metrics = fs
      .readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(metrics.map((line) => [line.metric, line.value])).toEqual([
      ['audio_in_to_transcript_delta_ms', 120],
      ['transcript_final_to_action_ms', 40],
      ['transcript_final_to_audio_out_ms', 80],
      ['roundtrip_ms', 420],
    ]);
  });

  it('can measure text-to-action when the transcript source was already text', () => {
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-metrics-')),
      'jarvis-metrics.log',
    );
    let wall = 100;
    const logger = new JarvisMetricsLogger({
      filePath,
      now: () => new Date('2026-07-07T12:00:00.000Z'),
    });
    const tracker = new JarvisLatencyTracker(logger, () => wall);

    tracker.markTranscript('s2', true);
    wall = 175;
    tracker.markAction('s2');

    const metrics = fs
      .readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(metrics.map((line) => [line.metric, line.value])).toEqual([
      ['transcript_final_to_action_ms', 75],
    ]);
  });
});
