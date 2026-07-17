import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  PACKAGED_LEGAL_FILES,
  materializeOpenableNoticesPath,
  resolveThirdPartyNoticesPath,
} from './legal-notices-path';
import { shouldPackageFile } from '../../forge.config';

describe('legal notices packaging', () => {
  it('resolves THIRD_PARTY_NOTICES from the repo cwd in dev', () => {
    const found = resolveThirdPartyNoticesPath({
      appPath: '/nonexistent/app.asar',
      cwd: process.cwd(),
    });
    expect(found).toBe(path.join(process.cwd(), 'THIRD_PARTY_NOTICES.md'));
  });

  it('requires the MIT/third-party set in the packager allowlist', () => {
    for (const file of PACKAGED_LEGAL_FILES) {
      expect(shouldPackageFile(file)).toBe(true);
    }
  });

  it('extracts a copy when the notices live inside app.asar', () => {
    // shell.openPath entrega o caminho ao Finder/editor externo, que não lê
    // dentro do asar — o handler precisa abrir uma cópia extraída.
    const copy = vi.fn();
    const found = path.join('/Applications/N.app/Contents/Resources/app.asar', 'THIRD_PARTY_NOTICES.md');
    const openable = materializeOpenableNoticesPath(found, '/tmp/t', copy);
    expect(openable).toBe(path.join('/tmp/t', 'NexusIDE-THIRD_PARTY_NOTICES.md'));
    expect(copy).toHaveBeenCalledWith(found, openable);
  });

  it('opens dev paths directly without copying', () => {
    const copy = vi.fn();
    const found = path.join(process.cwd(), 'THIRD_PARTY_NOTICES.md');
    expect(materializeOpenableNoticesPath(found, '/tmp/t', copy)).toBe(found);
    expect(copy).not.toHaveBeenCalled();
  });
});
