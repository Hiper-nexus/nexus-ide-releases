import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { createBrowserAutomation } from './browser-automation';

type BrowserDomWindow = Window & typeof globalThis;

function fixture(): {
  dom: JSDOM;
  automation: ReturnType<typeof createBrowserAutomation>;
} {
  const dom = new JSDOM(
    `<!doctype html>
      <html lang="pt-BR">
        <head>
          <title>Token: title-secret-value</title>
          <meta name="description" content="Dashboard seguro">
        </head>
        <body>
          <h1>Painel determinístico</h1>
          <p id="public">Status inicial</p>
          <p>API key: sk-abcdefghijklmnopqrstuvwxyz</p>
          <div hidden>Bearer hidden-token-that-must-never-leak</div>
          <label for="query">Pesquisar</label>
          <input id="query" value="existing-input-secret">
          <label for="password">Senha</label>
          <input id="password" type="password" value="never-return-this">
          <button id="save">Salvar</button>
          <div id="status">Aguardando</div>
        </body>
      </html>`,
    {
      url: 'https://example.test/app?page=2&access_token=query-secret#token=fragment-secret',
      pretendToBeVisual: true,
    },
  );
  return {
    dom,
    automation: createBrowserAutomation(dom.window as unknown as BrowserDomWindow),
  };
}

describe('isolated browser automation', () => {
  it('returns bounded accessible text and opaque refs without input values or tokens', async () => {
    const { automation } = fixture();
    const result = (await automation.run('read', {
      maxChars: 2_000,
      maxElements: 20,
    })) as {
      url: string;
      title: string;
      bodyText: string;
      headings: Array<{ text: string }>;
      elements: Array<{ ref: string; name: string; inputType?: string }>;
    };

    expect(result.url).not.toContain('query-secret');
    expect(result.url).not.toContain('fragment-secret');
    expect(result.url).toContain('access_token=%5BREDACTED%5D');
    expect(result.title).not.toContain('title-secret-value');
    expect(result.bodyText).toContain('Painel determinístico');
    expect(result.bodyText).toContain('[REDACTED]');
    expect(result.bodyText).not.toContain('hidden-token');
    expect(result.bodyText).not.toContain('existing-input-secret');
    expect(result.bodyText).not.toContain('never-return-this');
    expect(result.headings).toEqual([{ level: 1, text: 'Painel determinístico' }]);
    expect(result.elements.every((element) => /^e\d+$/.test(element.ref))).toBe(true);
    expect(result.elements.find((element) => element.inputType === 'password')?.name).toBe(
      '[sensitive field hidden]',
    );
  });

  it('fills a normal text field, dispatches events, and never echoes the filled text', async () => {
    const { dom, automation } = fixture();
    const read = (await automation.run('read', {})) as {
      elements: Array<{ ref: string; name: string }>;
    };
    const field = read.elements.find((element) => element.name === 'Pesquisar');
    expect(field).toBeTruthy();

    let inputEvents = 0;
    let changeEvents = 0;
    const input = dom.window.document.querySelector('#query') as HTMLInputElement;
    input.addEventListener('input', () => inputEvents += 1);
    input.addEventListener('change', () => changeEvents += 1);

    const result = await automation.run('fill', {
      ref: field!.ref,
      text: 'novo conteúdo',
    });
    expect(input.value).toBe('novo conteúdo');
    expect(inputEvents).toBe(1);
    expect(changeEvents).toBe(1);
    expect(result).toEqual({
      filled: true,
      ref: field!.ref,
      length: 'novo conteúdo'.length,
    });
    expect(JSON.stringify(result)).not.toContain('novo conteúdo');
  });

  it('clicks only a previously read ref and reflects deterministic page changes', async () => {
    const { dom, automation } = fixture();
    dom.window.document.querySelector('#save')!.addEventListener('click', () => {
      dom.window.document.querySelector('#status')!.textContent = 'Salvo com sucesso';
    });
    const read = (await automation.run('read', {})) as {
      elements: Array<{ ref: string; name: string }>;
    };
    const button = read.elements.find((element) => element.name === 'Salvar');
    expect(button).toBeTruthy();
    await automation.run('click', { ref: button!.ref });

    const after = (await automation.run('read', {})) as { bodyText: string };
    expect(after.bodyText).toContain('Salvo com sucesso');
    await expect(automation.run('click', { ref: '#save' })).rejects.toThrow(/reference/);
  });

  it('refuses password and sensitive fields even when the ref is valid', async () => {
    const { automation } = fixture();
    const read = (await automation.run('read', {})) as {
      elements: Array<{ ref: string; inputType?: string }>;
    };
    const password = read.elements.find((element) => element.inputType === 'password');
    await expect(
      automation.run('fill', { ref: password!.ref, text: 'do-not-type' }),
    ).rejects.toThrow(/refusing/);
  });

  it('waits for visible text and enforces output bounds', async () => {
    const { dom, automation } = fixture();
    dom.window.setTimeout(() => {
      dom.window.document.querySelector('#status')!.textContent = 'Pronto agora';
    }, 20);
    const waited = await automation.run('wait', {
      condition: 'text',
      value: 'Pronto agora',
      timeoutMs: 500,
    });
    expect(waited).toMatchObject({ matched: true, condition: 'text' });

    dom.window.document.querySelector('#public')!.textContent = 'x'.repeat(30_000);
    const read = (await automation.run('read', { maxChars: 100 })) as {
      bodyText: string;
      truncated: boolean;
    };
    expect(read.bodyText.length).toBeLessThanOrEqual(100);
    expect(read.truncated).toBe(true);
  });
});
