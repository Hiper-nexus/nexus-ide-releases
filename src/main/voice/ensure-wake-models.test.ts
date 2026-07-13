import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PTBR_WAKE_MODEL_FILE,
  DEFAULT_PTBR_WAKE_MODEL_SHA256,
  DEFAULT_WAKE_MODEL_FILE,
  DEFAULT_WAKE_MODEL_SHA256,
  ensureAllDefaultWakeModelsInstalled,
  ensureDefaultPtbrWakeModelInstalled,
  ensureDefaultWakeModelInstalled,
} from './ensure-wake-models';
import { HEY_JARVIS_ONNX_B64 } from './wake-models';
import { EI_JARVIS_PTBR_ONNX_B64 } from './wake-models-ptbr';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ensureDefaultWakeModelInstalled', () => {
  it('installs SpeechKit EN + PT-BR trained heads for every client by default', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wake-default-'));
    roots.push(root);

    const installed = ensureAllDefaultWakeModelsInstalled(root);
    expect(installed.en).toBe(path.join(root, DEFAULT_WAKE_MODEL_FILE));
    expect(installed.ptbr).toBe(path.join(root, DEFAULT_PTBR_WAKE_MODEL_FILE));

    expect(
      createHash('sha256').update(fs.readFileSync(installed.en!)).digest('hex'),
    ).toBe(DEFAULT_WAKE_MODEL_SHA256);
    expect(
      createHash('sha256').update(fs.readFileSync(installed.ptbr!)).digest('hex'),
    ).toBe(DEFAULT_PTBR_WAKE_MODEL_SHA256);

    expect(fs.readFileSync(installed.en!).equals(Buffer.from(HEY_JARVIS_ONNX_B64, 'base64'))).toBe(
      true,
    );
    expect(
      fs.readFileSync(installed.ptbr!).equals(Buffer.from(EI_JARVIS_PTBR_ONNX_B64, 'base64')),
    ).toBe(true);
  });

  it('is idempotent when correct models are already present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wake-default-'));
    roots.push(root);
    const first = ensureAllDefaultWakeModelsInstalled(root);
    const second = ensureAllDefaultWakeModelsInstalled(root);
    expect(second).toEqual(first);
  });

  it('repairs a corrupt SpeechKit model', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wake-default-'));
    roots.push(root);
    const target = path.join(root, DEFAULT_WAKE_MODEL_FILE);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(target, 'not-a-model');

    const installed = ensureDefaultWakeModelInstalled(root);
    expect(installed).toBe(target);
    expect(
      createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
    ).toBe(DEFAULT_WAKE_MODEL_SHA256);
  });

  it('preserves a user-trained custom.onnx that is not the stock PT-BR head', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wake-default-'));
    roots.push(root);
    const target = path.join(root, DEFAULT_PTBR_WAKE_MODEL_FILE);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(target, Buffer.from('user-retrained-head-placeholder'));

    const installed = ensureDefaultPtbrWakeModelInstalled(root);
    expect(installed).toBe(target);
    expect(fs.readFileSync(target).toString()).toBe('user-retrained-head-placeholder');
  });
});
