#!/usr/bin/env node
// Sonda sintética do relay publicado: sala aleatória inventada, nenhum link,
// chave ou token real. Imprime só status HTTP e códigos de fechamento.
//
//   node relay-worker/scripts/probe-relay.mjs [wss://relay.nexuside.app] [--idle=130]
//
// --idle=N mantém host e guest calados por N segundos e confere que a borda
// não derruba conexão ociosa (o PWA não pinga).
// --skip-takeover pula os casos de vaga ociosa (esperam RELAY_IDLE_TAKEOVER_MS + 2 s).
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const base = (args.find((arg) => !arg.startsWith('--')) ?? 'wss://relay.nexuside.app').replace(/\/+$/, '');
const idleSeconds = Number(args.find((arg) => arg.startsWith('--idle='))?.slice(7) ?? 0);
const takeover = !args.includes('--skip-takeover');
// Valores de produção (relay-worker/wrangler.jsonc).
const IDLE_TAKEOVER_MS = 45_000;
const MAX_FRAME_BYTES = 262_144;
const MAX_MESSAGES_PER_SECOND = 1_000;
const APP_ORIGIN = 'https://app.nexuside.app';
const results = [];
let failed = false;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
}

const room = () => randomBytes(16).toString('hex');

function client(url, origin) {
  const ws = new WebSocket(url, origin ? { origin } : {});
  ws.binaryType = 'nodebuffer';
  const state = { ws, texts: [], frames: [], status: null };
  state.opened = new Promise((resolve) => {
    ws.once('open', () => resolve(true));
    ws.once('unexpected-response', (_request, response) => {
      state.status = response.statusCode;
      response.resume();
      ws.terminate();
      resolve(false);
    });
    ws.once('error', () => resolve(false));
  });
  state.closed = new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) state.frames.push(new Uint8Array(data));
    else state.texts.push(data.toString());
  });
  return state;
}

async function waitFor(pick, ms = 8_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = pick();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

const within = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))]);

function envelope(peer, body) {
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, peer, false);
  out.set(body, 4);
  return out;
}

const httpBase = base.replace(/^ws/, 'http');
const plain = await fetch(`${httpBase}/`);
record('HTTP sem upgrade', plain.status === 404, `status ${plain.status}${plain.headers.get('x-railway-fallback') ? ' (x-railway-fallback)' : ''}`);

const evil = client(`${base}/r/${room()}?role=guest`, 'https://evil.example');
await evil.opened;
record('Origin estranha', evil.status === 403, `status ${evil.status ?? 101}`);

const lonely = client(`${base}/r/${room()}?role=guest`, APP_ORIGIN);
const lonelyOpened = await lonely.opened;
const lonelyClose = lonelyOpened ? await within(lonely.closed, 8_000) : null;
record(
  'guest sem host (Origin do PWA)',
  lonelyOpened && lonelyClose?.code === 4004,
  lonelyOpened ? `101, close ${lonelyClose?.code ?? lonelyClose}` : `status ${lonely.status}`,
);

const roomId = room();
const host = client(`${base}/r/${roomId}?role=host`);
const hostOpened = await host.opened;
record('host cria a sala', hostOpened, hostOpened ? '101' : `status ${host.status}`);
if (hostOpened) {
  host.ws.send('{"t":"ping"}');
  const pong = await waitFor(() => host.texts.find((text) => text === '{"t":"pong"}'));
  record('heartbeat do host', pong !== undefined, pong ? 'pong' : 'sem pong');

  const second = client(`${base}/r/${roomId}?role=host`);
  const secondOpened = await second.opened;
  const secondClose = secondOpened ? await within(second.closed, 8_000) : null;
  record('segundo host', secondClose?.code === 4009, `close ${secondClose?.code ?? secondClose}`);

  const guest = client(`${base}/r/${roomId}?role=guest`, APP_ORIGIN);
  const guestOpened = await guest.opened;
  const joined = await waitFor(() => host.texts.find((text) => text.includes('peer-joined')));
  record('guest entra', guestOpened && joined === '{"t":"peer-joined","peer":1}', `${guestOpened ? '101' : guest.status}, ${joined ?? 'sem peer-joined'}`);

  const up = randomBytes(24);
  guest.ws.send(envelope(0, up));
  const atHost = await waitFor(() => host.frames[0]);
  const upOk =
    atHost !== undefined &&
    new DataView(atHost.buffer, atHost.byteOffset).getUint32(0, false) === 1 &&
    Buffer.from(atHost.subarray(4)).equals(up);
  record('frame guest → host', upOk, upOk ? `${atHost.length} bytes, peer 1` : 'não chegou igual');

  const down = randomBytes(24);
  host.ws.send(envelope(1, down));
  const atGuest = await waitFor(() => guest.frames[0]);
  const downOk = atGuest !== undefined && Buffer.from(atGuest).equals(Buffer.from(envelope(1, down)));
  record('frame host → guest', downOk, downOk ? `${atGuest.length} bytes, sem alteração` : 'não chegou igual');

  if (idleSeconds > 0) {
    console.log(`.... ocioso por ${idleSeconds} s (host já pingou uma vez; guest nunca pinga)`);
    // Sem ping periódico o host passaria do limite do heartbeat; o teste aqui é
    // a borda com o guest calado, então o host segue pingando como o desktop.
    const pinger = setInterval(() => host.ws.send('{"t":"ping"}'), 20_000);
    const idle = await within(Promise.race([host.closed, guest.closed]), idleSeconds * 1000);
    clearInterval(pinger);
    record('conexão ociosa', idle === 'timeout', idle === 'timeout' ? `aberta após ${idleSeconds} s` : `fechou ${JSON.stringify(idle)}`);
  }

  const started = Date.now();
  host.ws.close(1000);
  const roomClosed = await waitFor(() => guest.texts.find((text) => text === '{"t":"room-closed"}'));
  const guestClose = await within(guest.closed, 15_000);
  record(
    'host sai, sala fecha',
    roomClosed !== undefined && guestClose?.code === 4001,
    `${roomClosed ? 'room-closed' : 'sem room-closed'}, close ${guestClose?.code ?? guestClose} em ${Date.now() - started} ms`,
  );
  const late = client(`${base}/r/${roomId}?role=guest`, APP_ORIGIN);
  const lateOpened = await late.opened;
  const lateClose = lateOpened ? await within(late.closed, 8_000) : null;
  record('QR antigo depois do fim', lateClose?.code === 4004, `close ${lateClose?.code ?? lateClose}`);
}

// Teto de frame também no TEXT, contado em bytes UTF-8; e rajada de mensagens.
{
  const textRoom = room();
  const textHost = client(`${base}/r/${textRoom}?role=host`);
  if (await textHost.opened) {
    const small = client(`${base}/r/${textRoom}?role=guest`, APP_ORIGIN);
    const ascii = client(`${base}/r/${textRoom}?role=guest`, APP_ORIGIN);
    const multibyte = client(`${base}/r/${textRoom}?role=guest`, APP_ORIGIN);
    await Promise.all([small.opened, ascii.opened, multibyte.opened]);
    small.ws.send('é'.repeat(1_000));
    ascii.ws.send('a'.repeat(MAX_FRAME_BYTES + 1));
    multibyte.ws.send('é'.repeat(140_000)); // 140 000 caracteres, 280 000 bytes
    const asciiClose = await within(ascii.closed, 8_000);
    const multiClose = await within(multibyte.closed, 8_000);
    const smallState = await within(small.closed, 1_000);
    record(
      'TEXT grande recusado',
      asciiClose?.code === 1009 && multiClose?.code === 1009 && smallState === 'timeout',
      `ASCII ${MAX_FRAME_BYTES + 1} B → ${asciiClose?.code ?? asciiClose}; 140000 "é" (280000 B) → ${multiClose?.code ?? multiClose}; 1000 "é" (2000 B) ${smallState === 'timeout' ? 'segue aberto' : JSON.stringify(smallState)}`,
    );

    const flooder = client(`${base}/r/${textRoom}?role=guest`, APP_ORIGIN);
    await flooder.opened;
    const burst = 3 * MAX_MESSAGES_PER_SECOND;
    for (let i = 0; i < burst; i++) flooder.ws.send(envelope(0, [i & 0xff]));
    const floodClose = await within(flooder.closed, 10_000);
    record('rajada de mensagens', floodClose?.code === 1008, `${burst} frames de uma vez → close ${floodClose?.code ?? floodClose}`);
    textHost.ws.close(1000);
  } else {
    record('TEXT grande recusado', false, `host: status ${textHost.status}`);
  }
}

if (takeover) {
  // Host antigo (sem ping) que perdeu a rede: passado o limite, o novo host assume.
  const idleRoom = room();
  const oldHost = client(`${base}/r/${idleRoom}?role=host`);
  // Sala com um guest calado: cheia, o próximo guest o despeja.
  const fullRoom = room();
  const fullHost = client(`${base}/r/${fullRoom}?role=host`);
  await Promise.all([oldHost.opened, fullHost.opened]);
  const quiet = client(`${base}/r/${fullRoom}?role=guest`, APP_ORIGIN);
  await quiet.opened;
  const hostPinger = setInterval(() => fullHost.ws.send('{"t":"ping"}'), 20_000);
  console.log(`.... ${Math.round((IDLE_TAKEOVER_MS + 2_000) / 1000)} s calados (host antigo e um guest)`);
  await new Promise((resolve) => setTimeout(resolve, IDLE_TAKEOVER_MS + 2_000));
  clearInterval(hostPinger);

  const newHost = client(`${base}/r/${idleRoom}?role=host`);
  await newHost.opened;
  const oldClose = await within(oldHost.closed, 8_000);
  const newState = await within(newHost.closed, 1_000);
  record(
    'host antigo ocioso substituído',
    oldClose?.code === 4008 && newState === 'timeout',
    `antigo close ${oldClose?.code ?? oldClose} (${oldClose?.reason ?? ''}); novo ${newState === 'timeout' ? 'aberto' : JSON.stringify(newState)}`,
  );

  const others = [];
  for (let i = 0; i < 7; i++) others.push(client(`${base}/r/${fullRoom}?role=guest`, APP_ORIGIN));
  await Promise.all(others.map((other) => other.opened));
  const newcomer = client(`${base}/r/${fullRoom}?role=guest`, APP_ORIGIN);
  await newcomer.opened;
  const quietClose = await within(quiet.closed, 8_000);
  const leftQuiet = await waitFor(() => fullHost.texts.find((text) => text === '{"t":"peer-left","peer":1}'));
  const newcomerJoined = await waitFor(() => fullHost.texts.find((text) => text === '{"t":"peer-joined","peer":9}'));
  record(
    'guest ocioso despejado',
    quietClose?.code === 4008 && leftQuiet !== undefined && newcomerJoined !== undefined,
    `calado close ${quietClose?.code ?? quietClose}; host recebeu ${leftQuiet ? 'peer-left 1' : 'sem peer-left'} e ${newcomerJoined ? 'peer-joined 9' : 'sem peer-joined 9'}`,
  );
  const extra = client(`${base}/r/${fullRoom}?role=guest`, APP_ORIGIN);
  const extraClose = (await extra.opened) ? await within(extra.closed, 8_000) : null;
  record('sala cheia de guests ativos', extraClose?.code === 4029, `close ${extraClose?.code ?? extraClose}`);
  newHost.ws.close(1000);
  fullHost.ws.close(1000);
}

console.log(`\n${results.filter((result) => result.ok).length}/${results.length} ok`);
process.exit(failed ? 1 : 0);
