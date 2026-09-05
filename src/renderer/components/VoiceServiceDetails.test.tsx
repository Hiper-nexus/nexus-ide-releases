/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { VoiceServiceDetails } from './VoiceServiceDetails';

it('keeps the exact unavailable-service reason discoverable in collapsed diagnostics', () => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<VoiceServiceDetails groups={[{
    label: 'Transcrição', providers: [{ provider: 'whisper', kind: 'local', available: false, reason: 'binary not found: whisper' }],
  }]} />);
  expect(host.querySelector('details')?.open).toBe(false);
  expect(host.querySelector('summary')?.textContent).toBe('Diagnóstico dos serviços');
  expect(host.querySelector('dd')?.textContent).toBe('binary not found: whisper');
});
