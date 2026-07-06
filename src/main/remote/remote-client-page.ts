/**
 * Thin client mobile (self-contained) servido pela remote bridge na mesma
 * origem HTTPS. Pareia por código, lista panes/missões, lê a saída e envia
 * input — a ÚNICA rota de escrita é pane.input (8KB cap), igual ao protocolo
 * WS. Zero dependências externas (CSP-friendly, roda offline no celular).
 */

export const REMOTE_CLIENT_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<meta name="color-scheme" content="dark" />
<title>Nexus Remote</title>
<style>
  :root {
    --bg: #0a0c10; --panel: #12151c; --line: #232a36; --text: #d8dee9;
    --dim: #7b8494; --accent: #35d0a5; --danger: #e5484d;
    --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: var(--mono); font-size: 14px; line-height: 1.5;
    padding: env(safe-area-inset-top) env(safe-area-inset-right)
             env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
  header {
    display: flex; align-items: center; gap: 10px; padding: 12px 14px;
    border-bottom: 1px solid var(--line); position: sticky; top: 0;
    background: var(--bg); z-index: 2;
  }
  header .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--danger); }
  header .dot.on { background: var(--accent); }
  header h1 { font-size: 14px; margin: 0; letter-spacing: .04em; }
  header .sub { color: var(--dim); font-size: 12px; margin-left: auto; }
  main { padding: 14px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-bottom: 12px; }
  label { display: block; color: var(--dim); font-size: 12px; margin-bottom: 6px; }
  input, textarea {
    width: 100%; background: var(--bg); border: 1px solid var(--line);
    border-radius: 9px; color: var(--text); font-family: var(--mono);
    font-size: 16px; padding: 12px; -webkit-appearance: none;
  }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  button {
    background: var(--accent); color: #05231a; border: none; border-radius: 9px;
    font-family: var(--mono); font-weight: 600; font-size: 15px; padding: 12px 16px;
    width: 100%; margin-top: 10px;
  }
  button.ghost { background: transparent; color: var(--dim); border: 1px solid var(--line); }
  .pane { display: flex; align-items: center; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; margin-bottom: 8px; }
  .pane .st { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); flex: 0 0 auto; }
  .pane .st.idle { background: var(--accent); } .pane .st.busy { background: #e0b341; }
  .pane .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pane .go { color: var(--dim); }
  pre {
    background: #05070a; border: 1px solid var(--line); border-radius: 10px;
    padding: 12px; overflow-x: auto; font-size: 12px; white-space: pre-wrap;
    word-break: break-word; max-height: 52vh; margin: 0 0 10px;
  }
  .err { color: var(--danger); font-size: 13px; margin-top: 8px; }
  .row { display: flex; gap: 8px; }
  .row button { margin-top: 0; }
  .hidden { display: none; }
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <h1>NEXUS REMOTE</h1>
  <span class="sub" id="sub">desconectado</span>
</header>
<main>
  <section id="pair" class="card">
    <label>Código de pareamento (mostrado no Mac)</label>
    <input id="code" inputmode="latin" autocapitalize="characters" autocomplete="off" placeholder="ex.: 7K2M9QXR" />
    <button id="pairBtn">Parear</button>
    <div class="err" id="pairErr"></div>
  </section>

  <section id="panes" class="card hidden">
    <label>Panes</label>
    <div id="paneList"></div>
    <button class="ghost" id="refreshBtn">Atualizar</button>
  </section>

  <section id="detail" class="card hidden">
    <label id="detailName">pane</label>
    <pre id="output">…</pre>
    <textarea id="input" rows="2" placeholder="digite um comando…"></textarea>
    <div class="row">
      <button id="sendBtn">Enviar ⏎</button>
      <button class="ghost" id="backBtn" style="max-width:120px">‹ Voltar</button>
    </div>
    <div class="err" id="detailErr"></div>
  </section>
</main>
<script>
(function () {
  var ws = null, token = null, nextId = 1, pending = {}, curPane = null, poll = null;
  var $ = function (id) { return document.getElementById(id); };
  function setConn(on, txt) { $('dot').className = 'dot' + (on ? ' on' : ''); $('sub').textContent = txt; }

  function connect() {
    return new Promise(function (resolve, reject) {
      ws = new WebSocket('wss://' + location.host);
      ws.onopen = function () { setConn(true, 'conectado'); resolve(); };
      ws.onerror = function () { reject(new Error('falha de conexão (aceite o certificado)')); };
      ws.onclose = function () { setConn(false, 'desconectado'); if (poll) clearInterval(poll); };
      ws.onmessage = function (e) {
        var msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
        if (msg.id && pending[msg.id]) { pending[msg.id](msg); delete pending[msg.id]; }
      };
    });
  }
  function send(type, extra) {
    return new Promise(function (resolve, reject) {
      var id = String(nextId++);
      pending[id] = function (msg) {
        if (msg.error) reject(new Error(msg.error)); else resolve(msg);
      };
      var frame = { id: id, type: type };
      if (extra) for (var k in extra) frame[k] = extra[k];
      if (token) frame.token = token;
      ws.send(JSON.stringify(frame));
      setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error('timeout')); } }, 8000);
    });
  }

  $('pairBtn').onclick = function () {
    $('pairErr').textContent = '';
    var code = $('code').value.trim().toUpperCase();
    if (!code) { $('pairErr').textContent = 'informe o código'; return; }
    (ws && ws.readyState === 1 ? Promise.resolve() : connect())
      .then(function () { return send('pair', { code: code }); })
      .then(function (r) {
        token = r.token || (r.result && r.result.token);
        if (!token) throw new Error('sem token');
        $('pair').classList.add('hidden');
        $('panes').classList.remove('hidden');
        return refresh();
      })
      .catch(function (err) { $('pairErr').textContent = err.message; });
  };

  function refresh() {
    return send('panes.list').then(function (r) {
      var list = r.result || r.panes || [];
      var el = $('paneList'); el.textContent = '';
      if (!list.length) {
        var empty = document.createElement('div');
        empty.style.color = 'var(--dim)'; empty.textContent = 'nenhum pane';
        el.appendChild(empty); return;
      }
      list.forEach(function (p) {
        // DOM seguro: título do pane vai por textContent (nunca innerHTML) —
        // um título com '<' não vira markup no celular.
        var d = document.createElement('div'); d.className = 'pane';
        var st = document.createElement('span');
        st.className = 'st ' + (typeof p.state === 'string' ? p.state.replace(/[^a-z]/gi, '') : '');
        var nm = document.createElement('span');
        nm.className = 'nm'; nm.textContent = p.title || p.paneId;
        var go = document.createElement('span'); go.className = 'go'; go.textContent = '›';
        d.appendChild(st); d.appendChild(nm); d.appendChild(go);
        d.onclick = function () { openPane(p); };
        el.appendChild(d);
      });
    });
  }
  $('refreshBtn').onclick = function () { refresh(); };

  function openPane(p) {
    curPane = p;
    $('panes').classList.add('hidden');
    $('detail').classList.remove('hidden');
    $('detailName').textContent = p.title || p.paneId;
    $('detailErr').textContent = '';
    readOutput();
    if (poll) clearInterval(poll);
    poll = setInterval(readOutput, 2500);
  }
  function readOutput() {
    if (!curPane) return;
    send('pane.read', { paneId: curPane.paneId, lines: 200 })
      .then(function (r) {
        var out = (r.result && r.result.output) || r.output || '';
        var pre = $('output'); var atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        pre.textContent = out; if (atBottom) pre.scrollTop = pre.scrollHeight;
      })
      .catch(function (err) { $('detailErr').textContent = err.message; });
  }
  $('sendBtn').onclick = function () {
    if (!curPane) return;
    var data = $('input').value;
    if (!data) return;
    send('pane.input', { paneId: curPane.paneId, data: data })
      .then(function () { $('input').value = ''; setTimeout(readOutput, 300); })
      .catch(function (err) { $('detailErr').textContent = err.message; });
  };
  $('backBtn').onclick = function () {
    if (poll) clearInterval(poll); curPane = null;
    $('detail').classList.add('hidden');
    $('panes').classList.remove('hidden');
    refresh();
  };
})();
</script>
</body>
</html>`;
