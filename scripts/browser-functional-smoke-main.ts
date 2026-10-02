import { app, BrowserWindow } from 'electron';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { registerBrowserAutomationResponseHandler, rejectPendingBrowserAutomation, runBrowserAutomation } from '../src/main/browser/browser-automation-runtime';

const out = process.env.NEXUS_BROWSER_SMOKE_OUTPUT!;
const report: Record<string, unknown> = { status: 'running', electron: process.versions.electron, chromium: process.versions.chrome,
  isolatedFixture: true, noSandboxLaunch: process.argv.includes('--no-sandbox'),
  tested: ['real browser-preload', 'real browser-automation', 'real browser-automation-runtime', 'native capturePage', 'native device emulation'],
  limits: 'This fixture does not boot the full Nexus application or prove design quality, personal profiles, provider authentication, or Wayland compatibility.' };
const consoleMessages: Array<{ level: unknown; message: string }> = [];
const loadFailures: unknown[] = [];
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-browser-smoke-user-')));

async function main() {
  await app.whenReady();
  registerBrowserAutomationResponseHandler();
  const win = new BrowserWindow({ width: 840, height: 660, show: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: `nexus-regression-${randomUUID()}` } });
  const wc = win.webContents;
  wc.on('console-message', (event, details, ...legacy) => {
    const detail = details && typeof details === 'object' ? details : typeof details === 'number' ? { level: details, message: legacy[0] } : event;
    consoleMessages.push({ level: detail.level, message: String(detail.message ?? '') });
  });
  wc.on('did-fail-load', (_event, code, description, url) => { if (code !== -3) loadFailures.push({ code, description, url }); });
  wc.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (!inPlace && mainFrame) rejectPendingBrowserAutomation(wc.id, 'fixture document changed'); });
  const command = (name: Parameters<typeof runBrowserAutomation>[2], args: Record<string, unknown>) => runBrowserAutomation('fixture', wc, name, args);
  const frame = () => wc.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const game = () => wc.executeJavaScript('JSON.parse(JSON.stringify(window.__fixture))');
  const ref = async (text: string) => {
    const found = await command('find', { text }) as { matches: Array<{ ref: string }> };
    assert.ok(found.matches.length > 0, `Missing fixture element: ${text}`); return found.matches[0].ref;
  };
  const click = async (text: string) => command('click', { ref: await ref(text) });
  const shot = async (name: string) => {
    await frame();
    const image = await wc.capturePage(); const png = image.toPNG(); const size = image.getSize();
    assert.ok(size.width > 0 && size.height > 0 && png.length > 100, `Empty screenshot: ${name}`);
    fs.writeFileSync(path.join(out, `${name}.png`), png);
    return { name, ...size, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') };
  };
  await win.loadFile(path.join(__dirname, 'fixture.html'));
  report.desktopBefore = await shot('desktop-before');
  report.read = await command('read', { maxChars: 3000 });
  await command('fill', { ref: await ref('Name'), text: 'Ada' });
  await click('Save profile');
  await command('wait', { condition: 'text', value: 'Saved Ada', timeoutMs: 1000 });
  assert.equal((await game()).saved, true);
  await click('Open menu');
  await command('wait', { condition: 'text', value: 'Menu is open', timeoutMs: 1000 });
  assert.equal(await wc.executeJavaScript('document.querySelector("#menu").hidden'), false);
  report.frontendAfter = await shot('frontend-after');
  await click('Start game');
  await command('press', { key: 'w' });
  await command('press', { key: 'ArrowRight', holdMs: 120 });
  const progress = await game();
  assert.equal(progress.moves, 2, 'code-based controls must register both keys');
  assert.ok(progress.heldFrames > 0 && progress.x > 80, 'held key must move across animation frames');
  assert.deepEqual(progress.events.map((event: { code: string; type: string }) => [event.type, event.code]), [['keydown', 'KeyW'], ['keyup', 'KeyW'], ['keydown', 'ArrowRight'], ['keyup', 'ArrowRight']]);
  report.gameProgress = progress;
  report.gameProgressScreenshot = await shot('game-progress');
  await click('Restart game');
  assert.deepEqual(Object.fromEntries(Object.entries(await game()).filter(([key]) => ['moves', 'heldFrames', 'x'].includes(key))), { moves: 0, x: 40, heldFrames: 0 });
  await command('press', { key: 'ArrowRight', holdMs: 80 });
  const restarted = await game(); assert.equal(restarted.moves, 1); assert.ok(restarted.heldFrames > 0);
  report.gameRestarted = restarted;
  report.gameRestartedScreenshot = await shot('game-restarted');
  report.layoutDesktop = await command('layout_audit', {});
  win.setSize(410, 900);
  wc.enableDeviceEmulation({ screenPosition: 'mobile', screenSize: { width: 390, height: 844 }, deviceScaleFactor: 1, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, scale: 1 });
  await frame();
  report.layoutMobile = await command('layout_audit', {});
  const mobile = await wc.executeJavaScript('({innerWidth,scrollWidth:document.documentElement.scrollWidth,columns:getComputedStyle(document.querySelector(".grid")).gridTemplateColumns.split(" ").length})');
  assert.equal(mobile.innerWidth, 390); assert.equal(mobile.columns, 1); assert.ok(mobile.scrollWidth <= 391);
  report.mobileGeometry = mobile; report.mobileScreenshot = await shot('mobile-after');
  assert.equal(loadFailures.length, 0, 'fixture must load without failures');
  assert.ok(consoleMessages.some(item => item.message.includes('fixture expected console capture')), 'console capture must observe the fixture');
  const unexpectedErrors = consoleMessages.filter(item => (item.level === 'error' || item.level === 3) && !item.message.includes('fixture expected console capture'));
  assert.equal(unexpectedErrors.length, 0, 'unexpected renderer or preload error');
  report.consoleMessages = consoleMessages; report.loadFailures = loadFailures; report.status = 'passed';
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Browser functional smoke passed: ${out}`);
  win.destroy(); app.quit();
}
main().catch(error => { report.status = 'failed'; report.error = String(error.stack ?? error); report.consoleMessages = consoleMessages; report.loadFailures = loadFailures; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.error(error); app.exit(1); });
