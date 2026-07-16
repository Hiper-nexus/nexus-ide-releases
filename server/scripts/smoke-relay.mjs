import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const port = 18_787;
const roomId = 'relayartifactsmoketestroom000001';
const entrypoint = fileURLToPath(new URL('../dist-relay/index.js', import.meta.url));

function connect(url) {
  const socket = new WebSocket(url);
  return once(socket, 'open').then(() => socket);
}

function nextMessage(socket) {
  return once(socket, 'message').then(([data]) => data.toString());
}

const child = spawn(process.execPath, [entrypoint], {
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    RELAY_ALLOWED_ORIGINS: 'https://app.nexuside.test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  const started = await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => Promise.reject(new Error(`relay exited early (${code})`))),
  ]);
  if (!String(started[0]).includes('[relay] listening')) {
    throw new Error('relay did not confirm startup');
  }

  const host = await connect(`ws://127.0.0.1:${port}/r/${roomId}?role=host`);
  const guest = await connect(`ws://127.0.0.1:${port}/r/${roomId}?role=guest`);
  const joined = await nextMessage(host);
  if (joined !== '{"t":"peer-joined","peer":1}') {
    throw new Error(`unexpected relay control frame: ${joined}`);
  }
  host.close();
  guest.close();
  process.stdout.write('[relay-smoke] ok\n');
} finally {
  child.kill('SIGTERM');
  await once(child, 'exit');
}
