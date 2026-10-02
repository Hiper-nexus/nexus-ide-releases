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

  it('never marks buttons, checkboxes or radios as editable', async () => {
    const dom = new JSDOM(
      `<!doctype html>
        <html><body>
          <input type="submit" value="Buscar">
          <input type="checkbox" id="aceite">
          <input type="radio" name="opcao" value="a">
          <input type="text" id="nome">
        </body></html>`,
      { url: 'https://example.test/formulario', pretendToBeVisual: true },
    );
    const automation = createBrowserAutomation(dom.window as unknown as BrowserDomWindow);
    const read = (await automation.run('read', {})) as {
      elements: Array<{ inputType?: string; editable?: boolean }>;
    };
    const submit = read.elements.find((element) => element.inputType === 'submit');
    const checkbox = read.elements.find((element) => element.inputType === 'checkbox');
    const radio = read.elements.find((element) => element.inputType === 'radio');
    const text = read.elements.find((element) => element.inputType === 'text');
    expect(submit?.editable).toBeUndefined();
    expect(checkbox?.editable).toBeUndefined();
    expect(radio?.editable).toBeUndefined();
    expect(text?.editable).toBe(true);
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

  it('hides camelCase OTP/session subtrees from read and refuses fill, but not MediaWiki rootpage', async () => {
    const dom = new JSDOM(
      `<!doctype html>
        <html><body class="skin-vector rootpage-Brasil">
          <a class="mw-jump-link" href="#conteudo">Ir para o conteúdo</a>
          <div class="ssoOtp"><span>otp-value-424242</span></div>
          <div id="expressSession">session-value-abcdef</div>
          <input id="ssoOtpInput" type="text">
        </body></html>`,
      { url: 'https://example.test/', pretendToBeVisual: true },
    );
    const automation = createBrowserAutomation(dom.window as unknown as BrowserDomWindow);
    const read = (await automation.run('read', {})) as {
      bodyText: string;
      elements: Array<{ ref: string; name: string; inputType?: string }>;
    };
    expect(read.bodyText).toContain('Ir para o conteúdo');
    expect(read.bodyText).not.toContain('otp-value-424242');
    expect(read.bodyText).not.toContain('session-value-abcdef');
    const input = read.elements.find((element) => element.inputType === 'text');
    await expect(automation.run('fill', { ref: input!.ref, text: '123456' })).rejects.toThrow(
      /refusing/,
    );
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

  it('scrolls the page by a relative offset and reports the page target', async () => {
    const { automation } = fixture();
    const result = (await automation.run('scroll', { dx: 0, dy: 200 })) as {
      scrolled: true;
      target: 'page' | 'element';
      scrollX: number;
      scrollY: number;
    };
    expect(result.scrolled).toBe(true);
    expect(result.target).toBe('page');
    expect(Number.isFinite(result.scrollX)).toBe(true);
    expect(Number.isFinite(result.scrollY)).toBe(true);
  });

  it('scrolls an element into view when a ref is given', async () => {
    const { automation } = fixture();
    const read = (await automation.run('read', {})) as {
      elements: Array<{ ref: string; name: string }>;
    };
    const button = read.elements.find((element) => element.name === 'Salvar');
    expect(button).toBeTruthy();
    const result = (await automation.run('scroll', { ref: button!.ref })) as {
      scrolled: true;
      target: 'page' | 'element';
    };
    expect(result.scrolled).toBe(true);
    expect(result.target).toBe('element');
  });

  it('press dispatches keydown with the given key on the focused element', async () => {
    const { dom, automation } = fixture();
    const button = dom.window.document.querySelector('#save') as HTMLButtonElement;
    const seen: string[] = [];
    button.addEventListener('keydown', (event) => {
      seen.push((event as KeyboardEvent).key);
    });
    button.focus();
    const result = (await automation.run('press', { key: 'Enter' })) as {
      pressed: true;
      key: string;
    };
    expect(result.pressed).toBe(true);
    expect(result.key).toBe('Enter');
    expect(seen).toContain('Enter');
  });

  it('press accepts a single char and modifiers, and rejects disallowed keys/modifiers', async () => {
    const { dom, automation } = fixture();
    const input = dom.window.document.querySelector('#query') as HTMLInputElement;
    input.focus();
    const ok = (await automation.run('press', { key: 'a', modifiers: ['Shift'] })) as {
      pressed: true;
      key: string;
    };
    expect(ok.pressed).toBe(true);
    expect(ok.key).toBe('a');

    await expect(automation.run('press', { key: 'Control+Alt+Del' })).rejects.toThrow(
      /invalid|not allowed/i,
    );
    await expect(
      automation.run('press', { key: 'Enter', modifiers: ['Hyper'] }),
    ).rejects.toThrow(/modifier/i);
  });

  it('press supplies physical key codes for code-based game controls', async () => {
    const { dom, automation } = fixture();
    const seen: Array<{ key: string; code: string; type: string }> = [];
    let moves = 0;
    dom.window.document.addEventListener('keydown', (event) => {
      seen.push({ key: event.key, code: event.code, type: event.type });
      if (event.code === 'KeyW' || event.code === 'ArrowUp') moves += 1;
    });
    dom.window.document.addEventListener('keyup', (event) => {
      seen.push({ key: event.key, code: event.code, type: event.type });
    });

    await automation.run('press', { key: 'w' });
    await automation.run('press', { key: 'ArrowUp' });

    expect(moves).toBe(2);
    expect(seen).toEqual([
      { type: 'keydown', key: 'w', code: 'KeyW' },
      { type: 'keyup', key: 'w', code: 'KeyW' },
      { type: 'keydown', key: 'ArrowUp', code: 'ArrowUp' },
      { type: 'keyup', key: 'ArrowUp', code: 'ArrowUp' },
    ]);
  });

  it('press preserves character keys while supplying their physical codes', async () => {
    const { dom, automation } = fixture();
    const seen: Array<{ key: string; code: string; shiftKey: boolean }> = [];
    dom.window.document.addEventListener('keydown', (event) => {
      seen.push({ key: event.key, code: event.code, shiftKey: event.shiftKey });
    });
    for (const key of ['W', '7', '!', '/', ' ', 'Space', 'Tab']) {
      await automation.run('press', { key, modifiers: key === '!' ? ['Shift'] : [] });
    }
    expect(seen).toEqual([
      { key: 'W', code: 'KeyW', shiftKey: false },
      { key: '7', code: 'Digit7', shiftKey: false },
      { key: '!', code: 'Digit1', shiftKey: true },
      { key: '/', code: 'Slash', shiftKey: false },
      { key: ' ', code: 'Space', shiftKey: false },
      { key: ' ', code: 'Space', shiftKey: false },
      { key: 'Tab', code: 'Tab', shiftKey: false },
    ]);
  });

  it('holds a game key across animation frames only when requested and can restart', async () => {
    const { dom, automation } = fixture();
    let held = false;
    dom.window.document.addEventListener('keydown', (event) => { if (event.code === 'ArrowRight') held = true; });
    dom.window.document.addEventListener('keyup', (event) => { if (event.code === 'ArrowRight') held = false; });
    await automation.run('press', { key: 'ArrowRight' });
    expect(held).toBe(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = automation.run('press', { key: 'ArrowRight', holdMs: 80 });
      await new Promise<void>(resolve => dom.window.requestAnimationFrame(() => { expect(held).toBe(true); resolve(); }));
      await pending;
      expect(held).toBe(false);
    }
    dom.window.close();
  });

  it('cancels a held key, releases it in the live document, and permits another press', async () => {
    const { dom, automation } = fixture();
    const controller = new AbortController();
    const events: string[] = [];
    dom.window.document.addEventListener('keydown', () => events.push('down'));
    dom.window.document.addEventListener('keyup', () => events.push('up'));
    const pending = automation.run('press', { key: 'w', holdMs: 1_000 }, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('cancelled');
    controller.abort();
    await rejected;
    expect(events).toEqual(['down', 'up']);
    await automation.run('press', { key: 'w' });
    expect(events).toEqual(['down', 'up', 'down', 'up']);
    dom.window.close();
  });

  it('does not send a held key release after the document begins navigation', async () => {
    const { dom, automation } = fixture();
    const events: string[] = [];
    dom.window.document.addEventListener('keydown', () => events.push('down'));
    dom.window.document.addEventListener('keyup', () => events.push('up'));
    const pending = automation.run('press', { key: 'w', holdMs: 1_000 });
    const rejected = expect(pending).rejects.toThrow('cancelled');
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    await rejected;
    expect(events).toEqual(['down']);
    dom.window.close();
  });

  it('rejects invalid hold durations and already-cancelled presses before input', async () => {
    const { dom, automation } = fixture();
    let downs = 0;
    dom.window.document.addEventListener('keydown', () => downs++);
    for (const holdMs of [-1, 1_001, 1.5, '100']) {
      await expect(automation.run('press', { key: 'w', holdMs })).rejects.toThrow('holdMs');
    }
    const controller = new AbortController(); controller.abort();
    await expect(automation.run('press', { key: 'w', holdMs: 100 }, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(downs).toBe(0);
    dom.window.close();
  });

  it('hover dispatches the mouse over sequence on a previously read ref', async () => {
    const { dom, automation } = fixture();
    const read = (await automation.run('read', {})) as {
      elements: Array<{ ref: string; name: string }>;
    };
    const button = read.elements.find((element) => element.name === 'Salvar');
    expect(button).toBeTruthy();
    const el = dom.window.document.querySelector('#save')!;
    let hovered = false;
    el.addEventListener('mouseover', () => {
      hovered = true;
    });
    const result = (await automation.run('hover', { ref: button!.ref })) as {
      hovered: true;
      element: { tag: string };
    };
    expect(result.hovered).toBe(true);
    expect(result.element.tag).toBe('button');
    expect(hovered).toBe(true);
  });

  it('read reports viewport metrics and scroll reports atBottom', async () => {
    const { dom, automation } = fixture();
    const read = (await automation.run('read', {})) as {
      viewport: {
        scrollY: number;
        scrollHeight: number;
        innerHeight: number;
        pagesBelow: number;
      };
    };
    expect(read.viewport.scrollY).toBe(0);
    expect(read.viewport.innerHeight).toBeGreaterThan(0);
    expect(read.viewport.pagesBelow).toBe(0);

    const scrolled = (await automation.run('scroll', { dx: 0, dy: 10 })) as {
      atBottom: boolean;
      viewport: { pagesBelow: number };
    };
    expect(typeof scrolled.atBottom).toBe('boolean');
    expect(scrolled.atBottom).toBe(true);
    expect(scrolled.viewport.pagesBelow).toBe(0);
    void dom;
  });

  it('read reports alerts from roles, aria-invalid, and allowlisted error classes', async () => {
    const dom = new JSDOM(
      `<!doctype html><body>
        <div role="alert">Falha ao salvar</div>
        <div role="alertdialog"><h2>Erro fatal</h2></div>
        <input aria-invalid="true" aria-label="CPF">
        <div class="error-message">Campo obrigatório</div>
        <div class="unrelated">não é alerta</div>
        <div data-sensitive="true"><div role="alert">segredo escondido</div></div>
      </body>`,
      { url: 'https://example.test/', pretendToBeVisual: true },
    );
    const automation = createBrowserAutomation(
      dom.window as unknown as BrowserDomWindow,
    );
    const read = (await automation.run('read', {})) as {
      alerts: Array<{ ref?: string; role: string; text: string }>;
    };
    const texts = read.alerts.map((alert) => alert.text);
    expect(texts.some((t) => t.includes('Falha ao salvar'))).toBe(true);
    expect(texts.some((t) => t.includes('Campo obrigatório'))).toBe(true);
    expect(texts.some((t) => t.includes('segredo escondido'))).toBe(false);
    expect(texts.some((t) => t.includes('não é alerta'))).toBe(false);
    expect(read.alerts.length).toBeLessThanOrEqual(10);
    const invalid = read.alerts.find((a) => a.text === 'CPF');
    expect(invalid?.role).toBe('textbox');
  });

  it('find scores accessible names and filters by role without CSS selectors', async () => {
    const dom = new JSDOM(
      `<!doctype html><body>
        <a href="/en/squads">See the squads</a>
        <a href="/en/squadron">Squadron</a>
        <button>Abrir menu</button>
        <button>Salvar edição</button>
      </body>`,
      { url: 'https://example.test/', pretendToBeVisual: true },
    );
    const automation = createBrowserAutomation(
      dom.window as unknown as BrowserDomWindow,
    );

    const exact = (await automation.run('find', { text: 'See the squads' })) as {
      matches: Array<{ name: string; score: number }>;
    };
    expect(exact.matches[0]?.score).toBe(1);
    expect(exact.matches[0]?.name).toBe('See the squads');

    const diacritics = (await automation.run('find', {
      text: 'edicao',
    })) as { matches: Array<{ name: string; score: number }> };
    expect(diacritics.matches.some((m) => m.name === 'Salvar edição')).toBe(true);

    const byRole = (await automation.run('find', {
      text: 'squads',
      role: 'button',
    })) as { matches: Array<{ role: string }> };
    expect(byRole.matches).toHaveLength(0);
    const byLink = (await automation.run('find', {
      text: 'squads',
      role: 'link',
    })) as { matches: Array<{ role: string; score: number }> };
    expect(byLink.matches.every((m) => m.role === 'link')).toBe(true);
    expect(byLink.matches.length).toBeGreaterThan(0);

    const hrefMatch = (await automation.run('find', { text: 'en/squads' })) as {
      matches: Array<{ name: string; score: number }>;
    };
    expect(hrefMatch.matches.some((m) => m.score === 0.5)).toBe(true);
  });

  it('extract_candidates returns bounded jsonLd, pairs, and typed tokens', async () => {
    const dom = new JSDOM(
      `<!doctype html><head>
        <script type="application/ld+json">{"name":"Produto X","price":42.5}</script>
      </head><body>
        <dl><dt>Autor</dt><dd>Maria Silva</dd><dt>Chave sk-abcdefghijklmnopqrstuvwxyz</dt><dd>ok</dd></dl>
        <table><tr><th>Total</th><td>R$ 1.234,56</td></tr></table>
        <label for="email">E-mail</label><input id="email" value="a@b.com">
        <label for="plano">Plano</label><select id="plano"><option>Basic</option><option selected>Pro</option></select>
        <p>Entrega em 12/03/2026</p>
        <div data-sensitive="true"><dl><dt>Secret</dt><dd>hidden</dd></dl></div>
      </body>`,
      { url: 'https://example.test/', pretendToBeVisual: true },
    );
    const automation = createBrowserAutomation(
      dom.window as unknown as BrowserDomWindow,
    );
    const result = (await automation.run('extract_candidates', {})) as {
      jsonLd: unknown[];
      pairs: Array<{ label: string; value: string; ref?: string }>;
      tokens: Array<{ kind: string; text: string; context: string }>;
    };
    expect(result.jsonLd).toHaveLength(1);
    expect(JSON.stringify(result.jsonLd[0])).toContain('Produto X');
    expect(result.pairs.some((p) => p.label === 'Autor' && p.value === 'Maria Silva')).toBe(true);
    expect(result.pairs.some((p) => p.label === 'Total')).toBe(true);
    expect(result.pairs.some((p) => p.label === 'Secret')).toBe(false);
    // valores digitados nunca saem da página; a opção de um select sai
    expect(result.pairs.some((p) => p.value === 'a@b.com')).toBe(false);
    expect(result.pairs.some((p) => p.label === 'E-mail')).toBe(false);
    expect(result.pairs.some((p) => p.label === 'Plano' && p.value === 'Pro')).toBe(true);
    // labels também passam pela máscara de redação
    expect(result.pairs.some((p) => p.label.includes('sk-abc'))).toBe(false);
    expect(
      result.pairs.some((p) => p.label.includes('[REDACTED]')),
    ).toBe(true);
    expect(result.tokens.some((t) => t.kind === 'money')).toBe(true);
    expect(result.tokens.some((t) => t.kind === 'date')).toBe(true);
    expect(result.pairs.length).toBeLessThanOrEqual(60);
    expect(result.tokens.length).toBeLessThanOrEqual(40);
  });

  it('strips a leading bullet marker from table-row labels', async () => {
    // pt.wikipedia.org/wiki/Brasil infobox shape: <th><div>• Presidente</div></th>.
    const dom = new JSDOM(
      `<!doctype html><body>
        <table>
          <tr><th><div>•<span> </span>Presidente</div></th><td>Lula da Silva</td></tr>
          <tr><th><div>•<span> </span>Vice-presidente</div></th><td>Geraldo Alckmin</td></tr>
          <tr><th>
            •&nbsp;Governador
          </th><td>Fulano</td></tr>
        </table>
      </body>`,
      { url: 'https://example.test/', pretendToBeVisual: true },
    );
    const automation = createBrowserAutomation(dom.window as unknown as BrowserDomWindow);
    const result = (await automation.run('extract_candidates', {})) as {
      pairs: Array<{ label: string; value: string }>;
    };
    expect(result.pairs.some((p) => p.label === 'Presidente' && p.value === 'Lula da Silva')).toBe(true);
    expect(
      result.pairs.some((p) => p.label === 'Vice-presidente' && p.value === 'Geraldo Alckmin'),
    ).toBe(true);
    // Indented markup: whitespace before the bullet must not keep it.
    expect(result.pairs.some((p) => p.label === 'Governador' && p.value === 'Fulano')).toBe(true);
  });

  it('keeps multi-line <br> values whole and offers the first line as an extra candidate', async () => {
    // pt.wikipedia.org/wiki/Brasil infobox "Capital" cell: name, then <br>,
    // then unrelated geocoordinate markup glued on by .textContent.
    const dom = new JSDOM(
      `<!doctype html><body>
        <table>
          <tr><th>Capital</th><td><a href="/wiki/Brasília">Brasília</a><br><span>15° 47' S 47° 52' O</span></td></tr>
          <tr><th>Endereço</th><td>Rua das Flores<br>São Paulo, SP</td></tr>
          <tr><th>Sede</th><td><br>Recife</td></tr>
        </table>
        <dl><dt>Entrega</dt><dd>Av. Paulista, 1000<br>Bela Vista</dd></dl>
      </body>`,
      { url: 'https://example.test/', pretendToBeVisual: true },
    );
    const automation = createBrowserAutomation(dom.window as unknown as BrowserDomWindow);
    const result = (await automation.run('extract_candidates', {})) as {
      pairs: Array<{ label: string; value: string }>;
    };
    const valuesOf = (label: string): string[] =>
      result.pairs.filter((p) => p.label === label).map((p) => p.value);
    expect(valuesOf('Capital')).toEqual(["Brasília / 15° 47' S 47° 52' O", 'Brasília']);
    expect(valuesOf('Endereço')).toEqual(['Rua das Flores / São Paulo, SP', 'Rua das Flores']);
    expect(valuesOf('Sede')).toEqual(['Recife']);
    expect(valuesOf('Entrega')).toEqual(['Av. Paulista, 1000 / Bela Vista', 'Av. Paulista, 1000']);
  });

  it('tokenizes space/nbsp-grouped pt-BR thousands as number candidates', async () => {
    // pt.wikipedia.org/wiki/Brasil: population "213 421 037" and
    // area "8 510 417,771 km²" use NBSP thousand separators.
    const dom = new JSDOM(
      `<!doctype html><body>
        <p>População: 213 421 037 habitantes</p>
        <p>Área total: 8 510 417,771 km²</p>
      </body>`,
      { url: 'https://example.test/', pretendToBeVisual: true },
    );
    const automation = createBrowserAutomation(dom.window as unknown as BrowserDomWindow);
    const result = (await automation.run('extract_candidates', {})) as {
      tokens: Array<{ kind: string; text: string }>;
    };
    const numbers = result.tokens.filter((t) => t.kind === 'number').map((t) => t.text);
    expect(numbers.some((t) => t.replace(/\s| /g, '') === '213421037')).toBe(true);
    expect(numbers.some((t) => t.replace(/\s| /g, '') === '8510417,771')).toBe(true);
  });
});

describe('layout_audit (responsividade)', () => {
  type Rect = { left: number; right: number; width: number; height: number };
  function withGeometry(
    dom: JSDOM,
    layout: Record<string, Rect & { scrollWidth?: number; clientWidth?: number; scrollHeight?: number; clientHeight?: number }>,
    page: { clientWidth: number; scrollWidth: number },
  ): void {
    const doc = dom.window.document;
    Object.defineProperty(doc.documentElement, 'clientWidth', { value: page.clientWidth });
    Object.defineProperty(doc.documentElement, 'scrollWidth', { value: page.scrollWidth });
    for (const [id, geometry] of Object.entries(layout)) {
      const element = doc.getElementById(id)!;
      element.getBoundingClientRect = () =>
        ({ ...geometry, top: 0, bottom: geometry.height, x: geometry.left, y: 0 }) as DOMRect;
      for (const key of ['scrollWidth', 'clientWidth', 'scrollHeight', 'clientHeight'] as const) {
        if (geometry[key] !== undefined) Object.defineProperty(element, key, { value: geometry[key] });
      }
    }
  }

  it('reports sideways scroll, the outermost straddling element and overflow-hidden cuts', async () => {
    const dom = new JSDOM(
      `<!doctype html><body>
        <div id="hero"><img id="banner" alt="Banner largo"></div>
        <nav id="drawer">Menu fora da tela</nav>
        <div id="card" style="overflow-x: hidden; overflow-y: hidden">Texto longo cortado</div>
        <div id="ssoOtp" style="overflow-x: clip; overflow-y: clip">123456</div>
      </body>`,
      { url: 'https://example.test/', pretendToBeVisual: true },
    );
    withGeometry(
      dom,
      {
        hero: { left: 0, right: 390, width: 390, height: 200 },
        banner: { left: 0, right: 520, width: 520, height: 200 },
        drawer: { left: 400, right: 700, width: 300, height: 800 },
        card: { left: 0, right: 200, width: 200, height: 40, scrollWidth: 200, clientWidth: 200, scrollHeight: 90, clientHeight: 40 },
        ssoOtp: { left: 0, right: 100, width: 100, height: 20, scrollWidth: 160, clientWidth: 100, scrollHeight: 20, clientHeight: 20 },
      },
      { clientWidth: 390, scrollWidth: 520 },
    );
    const automation = createBrowserAutomation(dom.window as unknown as BrowserDomWindow);
    const audit = (await automation.run('layout_audit', {})) as {
      layoutWidth: number;
      scrollWidth: number;
      horizontalOverflow: boolean;
      overflowing: Array<{ tag: string; name: string; overflowPx: number }>;
      clipped: Array<{ name: string; hiddenX: number; hiddenY: number }>;
    };
    expect(audit).toMatchObject({ layoutWidth: 390, scrollWidth: 520, horizontalOverflow: true });
    // Only the banner (not its in-bounds parent, not the fully off-canvas drawer).
    expect(audit.overflowing).toHaveLength(1);
    expect(audit.overflowing[0]).toMatchObject({ tag: 'img', name: 'Banner largo', overflowPx: 130 });
    expect(audit.clipped).toHaveLength(2);
    expect(audit.clipped[0]).toMatchObject({ name: 'Texto longo cortado', hiddenX: 0, hiddenY: 50 });
    // Sensitive boxes are reported by geometry only — never their text.
    expect(audit.clipped[1]).toMatchObject({ name: '[sensitive field hidden]', hiddenX: 60 });
    expect(JSON.stringify(audit)).not.toContain('123456');
  });

  it('a page that fits reports no overflow', async () => {
    const dom = new JSDOM(`<!doctype html><body><p id="p">ok</p></body>`, {
      url: 'https://example.test/',
      pretendToBeVisual: true,
    });
    withGeometry(dom, { p: { left: 0, right: 300, width: 300, height: 20 } }, { clientWidth: 390, scrollWidth: 390 });
    const automation = createBrowserAutomation(dom.window as unknown as BrowserDomWindow);
    expect(await automation.run('layout_audit', {})).toMatchObject({
      horizontalOverflow: false,
      overflowing: [],
      clipped: [],
      truncated: false,
    });
  });
});
