'use strict';

// Motor falso dos testes do agente: fala o protocolo de engine.cs sem cartão.
// "Assinar" acrescenta SIGNED ao arquivo; "conferir" exige esse final.
const fs = require('node:fs');
const readline = require('node:readline');

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const fromB64 = (text) => Buffer.from(text || '', 'base64').toString('utf8');
const log = (line) => {
  if (process.env.FAKE_ENGINE_LOG) fs.appendFileSync(process.env.FAKE_ENGINE_LOG, `${line}\n`);
};
const say = (line) => process.stdout.write(`${line}\n`);

if (process.env.FAKE_ENGINE_FATAL) {
  say(`FATAL ${b64(process.env.FAKE_ENGINE_FATAL)}`);
  process.exit(1);
}
say(`CERT ${process.env.FAKE_ENGINE_CERT} ${process.env.FAKE_ENGINE_HAS_KEY ?? '1'}`);

const lockAfter = process.env.FAKE_ENGINE_LOCK_AFTER ? Number(process.env.FAKE_ENGINE_LOCK_AFTER) : Infinity;
let unlocked = false;
let signs = 0;

readline.createInterface({ input: process.stdin })
  .on('line', (line) => {
    const [command, first, second] = line.split(' ');
    if (command === 'SIGN') log(`SIGN ${fromB64(first)} ${fromB64(second)}`);
    else if (command === 'VERIFY') log(`VERIFY ${fromB64(first)}`);
    else log(command);
    if (command === 'UNLOCK') {
      unlocked = true;
      say('UNLOCKED');
    } else if (command === 'PROBE') {
      say(unlocked && signs < lockAfter ? 'OK' : `LOCKED ${b64('the YubiKey PIN is no longer cached')}`);
    } else if (command === 'SIGN') {
      if (!unlocked || signs >= lockAfter) {
        say(`LOCKED ${b64('the YubiKey PIN is no longer cached')}`);
        return;
      }
      signs += 1;
      fs.appendFileSync(fromB64(first), 'SIGNED');
      say('OK');
    } else if (command === 'VERIFY') {
      say(fs.readFileSync(fromB64(first), 'utf8').endsWith('SIGNED') ? 'OK' : `ERR ${b64('not signed')}`);
    } else {
      say(`ERR ${b64('unknown command')}`);
    }
  })
  .on('close', () => process.exit(0));
