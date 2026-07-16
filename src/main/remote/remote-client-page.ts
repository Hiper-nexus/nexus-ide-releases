/**
 * Thin client mobile (self-contained) servido pela remote bridge na mesma
 * origem HTTPS. Pareia por código, lista panes/missões, lê a saída e envia
 * input — a ÚNICA rota de escrita é pane.input (8KB cap), igual ao protocolo
 * WS. Zero dependências externas (CSP-friendly, roda offline no celular).
 *
 * Token persistido em localStorage (origem HTTPS da própria bridge): reload
 * não exige re-pareamento; revogação no desktop invalida o token no servidor
 * e o cliente cai de volta para a tela de pareamento. Terminal em tempo real:
 * consome pushes `pane.stream.data` (terminal-stream-protocol) e usa o poll
 * apenas como reconciliação — um gap de seq dispara pane.read para curar.
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

  <section id="home" class="card hidden">
    <label>Ops · resumo</label>
    <div id="opsSummary" style="color:var(--dim);font-size:12px;margin-bottom:10px"></div>
    <label>Missões</label>
    <div id="missionList"></div>
    <label style="margin-top:12px">Panes</label>
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
  var curStreamId = null, lastSeq = 0, streamLive = false;
  var TOKEN_KEY = 'nexusRemoteToken';
  var $ = function (id) { return document.getElementById(id); };
  function setConn(on, txt) { $('dot').className = 'dot' + (on ? ' on' : ''); $('sub').textContent = txt; }
  function loadToken() { try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; } }
  function saveToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {} }
  function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (_) {} }
  function showPairScreen(msg) {
    token = null; clearToken();
    $('home').classList.add('hidden');
    $('detail').classList.add('hidden');
    $('pair').classList.remove('hidden');
    if (msg) $('pairErr').textContent = msg;
  }

  // Frame do terminal-stream-protocol (16 bytes de header, little-endian):
  // kind 0x74 · version 1 · opcode · streamId u32@4 · seq u64@8 (low u32@12).
  function decodeStreamFrame(b64) {
    try {
      var bin = atob(b64);
      if (bin.length < 16) return null;
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (bytes[0] !== 0x74 || bytes[1] !== 1) return null;
      var view = new DataView(bytes.buffer);
      return {
        opcode: bytes[2],
        streamId: view.getUint32(4, true),
        seq: view.getUint32(12, true),
        text: new TextDecoder().decode(bytes.subarray(16)),
      };
    } catch (_) { return null; }
  }

  var resyncInFlight = false;
  function resyncAfterGap() {
    // Debounce: um gap gera UMA reconciliação; pushes seguintes com seq
    // desalinhada esperam o pane.read realinhar lastSeq em vez de disparar
    // uma rajada de reads (e estourar o rate limit da bridge).
    if (resyncInFlight) return;
    resyncInFlight = true;
    readOutput(function () { resyncInFlight = false; });
  }
  function handleStreamPush(msg) {
    if (!curPane || msg.streamId !== curStreamId) return;
    var frame = decodeStreamFrame(msg.frameBase64 || '');
    if (!frame || frame.opcode !== 1) return; // só Output interessa aqui
    if (resyncInFlight) return; // o pane.read em voo já cobre este trecho
    // Cursor de push dedicado (msg.seq): imune aos encodes de resposta de
    // pane.read/input de OUTROS clientes — gap aqui é perda real de push.
    if (typeof msg.seq !== 'number') return;
    if (msg.seq <= lastSeq) return; // duplicado/atrasado — já coberto
    if (lastSeq && msg.seq !== lastSeq + 1) {
      // Gap (backpressure/reconexão): reconciliar com o tail completo.
      resyncAfterGap();
      return;
    }
    lastSeq = msg.seq;
    var pre = $('output');
    var atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
    var next = pre.textContent + frame.text;
    // Bound de memória no celular: manter só a cauda.
    if (next.length > 200000) next = next.slice(next.length - 160000);
    pre.textContent = next;
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }

  function connect() {
    return new Promise(function (resolve, reject) {
      ws = new WebSocket('wss://' + location.host);
      ws.onopen = function () { setConn(true, 'conectado'); resolve(); };
      ws.onerror = function () { reject(new Error('falha de conexão (aceite o certificado)')); };
      ws.onclose = function (e) {
        setConn(false, 'desconectado');
        if (poll) clearInterval(poll);
        // Revogação/expiração AO VIVO: a bridge fecha com o motivo. Voltar
        // para o pareamento na hora — sem isso a tela fica morta com token
        // podre salvo e o usuário só se recupera limpando o storage.
        var reason = (e && e.reason) || '';
        if (/token|revoked|revogad|expired|expirad/i.test(reason)) {
          showPairScreen('sessão encerrada no desktop — pareie de novo');
        }
      };
      ws.onmessage = function (e) {
        var msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
        if (msg.id && pending[msg.id]) { pending[msg.id](msg); delete pending[msg.id]; return; }
        if (msg.type === 'pane.stream.data') handleStreamPush(msg);
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
        saveToken(token);
        $('pair').classList.add('hidden');
        $('home').classList.remove('hidden');
        return refresh();
      })
      .catch(function (err) { $('pairErr').textContent = err.message; });
  };

  // Token salvo: reload não exige re-pareamento. Só a REJEIÇÃO explícita do
  // auth apaga o token — queda de rede/refresh transitória preserva a sessão
  // (recarregar tenta de novo com o mesmo token).
  (function bootWithSavedToken() {
    var saved = loadToken();
    if (!saved) return;
    connect()
      .then(function () {
        return send('auth', { token: saved }).catch(function (err) {
          err.authRejected = true;
          throw err;
        });
      })
      .then(function () {
        token = saved;
        $('pair').classList.add('hidden');
        $('home').classList.remove('hidden');
        // Falha do refresh não derruba a sessão: a home mostra o erro dela.
        return refresh().catch(function () {});
      })
      .catch(function (err) {
        if (err && err.authRejected) {
          showPairScreen('sessão expirada — pareie de novo (' + err.message + ')');
        } else {
          $('pairErr').textContent =
            'sem conexão com o desktop — recarregue para tentar de novo';
        }
      });
  })();

  function renderMissions(list) {
    var el = $('missionList'); el.textContent = '';
    if (!list || !list.length) {
      var empty = document.createElement('div');
      empty.style.color = 'var(--dim)'; empty.textContent = 'nenhuma missão';
      el.appendChild(empty); return;
    }
    list.slice(0, 40).forEach(function (m) {
      var d = document.createElement('div'); d.className = 'pane';
      var st = document.createElement('span');
      var status = typeof m.status === 'string' ? m.status : '';
      st.className = 'st ' + (status === 'running' ? 'busy' : status === 'done' ? 'idle' : '');
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = (m.title || m.id || 'missão') + (status ? ' · ' + status : '');
      d.appendChild(st); d.appendChild(nm);
      el.appendChild(d);
    });
  }

  function refresh() {
    return send('ops.snapshot').then(function (r) {
      var result = r.result || r;
      var missions = result.missions || [];
      var panes = result.panes || [];
      var sum = result.summary || {};
      $('opsSummary').textContent =
        (sum.runningMissions || 0) + ' missões a correr · ' +
        (sum.busyPanes || 0) + ' panes busy · ' +
        (sum.missions || missions.length) + ' missões · ' +
        (sum.panes || panes.length) + ' panes';
      renderMissions(missions);
      var el = $('paneList'); el.textContent = '';
      if (!panes.length) {
        var empty = document.createElement('div');
        empty.style.color = 'var(--dim)'; empty.textContent = 'nenhum pane';
        el.appendChild(empty); return;
      }
      panes.forEach(function (p) {
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
    }).catch(function (err) {
      var msg = err && err.message ? String(err.message) : String(err || '');
      var unknown =
        /unknown command/i.test(msg) || /ops\.snapshot/i.test(msg);
      if (!unknown) {
        $('opsSummary').textContent = 'erro: ' + msg;
        return;
      }
      // Fallback only when the bridge is older than ops.snapshot.
      return send('panes.list').then(function (r) {
        var list = r.result || r.panes || [];
        var el = $('paneList'); el.textContent = '';
        list.forEach(function (p) {
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
        return send('mission.list').then(function (mr) {
          var res = mr.result || mr;
          renderMissions(Array.isArray(res) ? res : (res.missions || []));
        }).catch(function () {});
      });
    });
  }
  $('refreshBtn').onclick = function () { refresh(); };

  function schedulePoll() {
    if (poll) clearInterval(poll);
    // Com stream ao vivo o poll vira reconciliação lenta; sem stream (bridge
    // antiga), continua sendo a fonte primária.
    poll = setInterval(readOutput, streamLive ? 15000 : 2500);
  }
  function closeStreams() {
    // Abrir mão do push antigo ao trocar de pane/voltar: frames de um pane
    // ruidoso que ninguém está vendo só consomem o buffer do socket.
    send('pane.stream.close', {}).catch(function () { /* bridge antiga */ });
  }
  function openPane(p) {
    if (curPane && curPane.paneId !== p.paneId) closeStreams();
    curPane = p;
    curStreamId = null; lastSeq = 0; streamLive = false; resyncInFlight = false;
    $('home').classList.add('hidden');
    $('detail').classList.remove('hidden');
    $('detailName').textContent = p.title || p.paneId;
    $('detailErr').textContent = '';
    readOutput();
    send('pane.stream.open', { paneId: p.paneId })
      .then(function (r) {
        var res = r.result || r;
        if (curPane !== p) return;
        // Negociação explícita: bridge antiga responde ao open mas nunca
        // empurra — sem a flag, o poll de 2,5 s continua sendo a fonte.
        if (res.pushAvailable !== true) return;
        curStreamId = res.streamId;
        lastSeq = typeof res.pushSeq === 'number' ? res.pushSeq : 0;
        streamLive = true;
        schedulePoll();
      })
      .catch(function () { /* bridge antiga sem push — poll de 2.5s cobre */ });
    schedulePoll();
  }
  function readOutput(done) {
    if (!curPane) { if (done) done(); return; }
    send('pane.read', { paneId: curPane.paneId, lines: 200 })
      .then(function (r) {
        var res = r.result || r;
        var out = res.output || '';
        if (res.stream && typeof res.stream.pushSeq === 'number') {
          // Realinha o cursor de PUSH após a reconciliação (o seq do frame
          // avança com encodes de resposta e não serve de baseline).
          lastSeq = res.stream.pushSeq;
        }
        var pre = $('output'); var atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        pre.textContent = out; if (atBottom) pre.scrollTop = pre.scrollHeight;
        if (done) done();
      })
      .catch(function (err) { $('detailErr').textContent = err.message; if (done) done(); });
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
    if (poll) clearInterval(poll);
    closeStreams();
    curPane = null;
    curStreamId = null; lastSeq = 0; streamLive = false; resyncInFlight = false;
    $('detail').classList.add('hidden');
    $('home').classList.remove('hidden');
    refresh();
  };
})();
</script>
</body>
</html>`;
