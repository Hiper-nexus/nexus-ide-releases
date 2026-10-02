import test from 'node:test';
import assert from 'node:assert/strict';
import { randomToken, hashToken, pkceChallenge, safeEqual, parseBearer } from '../src/crypto.js';
test('tokens are opaque, unique and hashes are deterministic',async()=>{const a=randomToken(),b=randomToken();assert.notEqual(a,b);assert.match(a,/^[A-Za-z0-9_-]{43}$/);assert.equal((await hashToken(a)).length,64);assert.equal(await hashToken(a),await hashToken(a));});
test('PKCE matches RFC7636 S256 example',async()=>{assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');});
test('comparison rejects unequal proof and bearer parsing rejects malformed headers',()=>{assert.equal(safeEqual('abc','abd'),false);assert.equal(safeEqual('abc','abc'),true);assert.equal(parseBearer('Basic abc'),null);assert.equal(parseBearer('Bearer token'),'token');});
