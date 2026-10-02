import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedBody, safeReturnPath, isAllowedWebOrigin } from '../src/http.js';
test('oversized request is rejected before JSON parsing',async()=>{await assert.rejects(readBoundedBody(new Request('https://api.test',{method:'POST',body:'x'.repeat(20)}),10),/grande/);});
test('return path cannot redirect users to a foreign origin',()=>{for(const value of ['https://evil.test','//evil.test','/\\evil.test','/conta?next=https://evil.test'])assert.equal(safeReturnPath(value),'/conta');assert.equal(safeReturnPath('/conta'),'/conta');});
test('web mutations require the exact configured origin',()=>{assert.equal(isAllowedWebOrigin('https://nexuside.app','https://nexuside.app'),true);assert.equal(isAllowedWebOrigin(null,'https://nexuside.app'),false);assert.equal(isAllowedWebOrigin('https://nexuside.app.evil.test','https://nexuside.app'),false);});
