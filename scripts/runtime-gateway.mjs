import http from 'node:http';
import { randomUUID } from 'node:crypto';
const MAX_REQUESTS = 160, MAX_BYTES = 4 * 1024 * 1024;
function stream(res, model, content) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = (name, value) => res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  event('message_start', { type: 'message_start', message: { id: `msg_runtime_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  if (content.type === 'tool_use') {
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: content.id, name: content.name, input: {} } });
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } });
  } else {
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content.text } });
  }
  event('content_block_stop', { type: 'content_block_stop', index: 0 });
  event('message_delta', { type: 'message_delta', delta: { stop_reason: content.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  event('message_stop', { type: 'message_stop' }); res.end();
}
function objects(value, output = []) {
  if (typeof value === 'string') { try { objects(JSON.parse(value), output); } catch { /* prose */ } }
  else if (Array.isArray(value)) value.forEach(v => objects(v, output));
  else if (value && typeof value === 'object') { output.push(value); Object.values(value).forEach(v => objects(v, output)); }
  return output;
}
function toolResult(messages, call, kind = 'QUESTION') {
  const results = messages.filter(message => message.role === 'user' && Array.isArray(message.content))
    .flatMap(message => message.content).filter(block => block.type === 'tool_result' && block.tool_use_id === call.id);
  if (results.length !== 1 || (results[0].is_error !== undefined && results[0].is_error !== false)) throw new Error(`real ${kind} tool result absent, ambiguous or failed`);
  const content = results[0].content;
  const text = typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 && content[0].type === 'text' ? content[0].text : null;
  if (typeof text !== 'string') throw new Error(`real ${kind} tool result content invalid`);
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok === false || value.isError === true) throw new Error(`real ${kind} tool result invalid`);
  return value;
}
function writeReply(messages, step, tool, calls, nonce) {
  const dir = `runtime-visual-${nonce}`, file = `${dir}/index.html`;
  if (step === 0) return tool('nexus_file_write', { path: file,
    content: `<!doctype html><html><head><meta charset="utf-8"><title>Private runtime visual fixture</title></head><body style="background:#f4f4f4;color:#161616;padding:40px"><h1>Runtime visual fixture</h1><p>RT_VISUAL_${nonce}</p><p>This local page is the complete declared visual assignment.</p></body></html>` });
  if (toolResult(messages, calls[0], 'WRITE').path !== file) throw new Error('real visual file write result differs');
  if (step === 1) return tool('nexus_preview_start', { dir });
  const preview = toolResult(messages, calls[1], 'WRITE'), url = new URL(preview.url);
  if (!/^preview-[A-Za-z0-9-]+$/u.test(preview.id ?? '') || !Number.isInteger(preview.port) || preview.port < 1 || preview.port > 65535 ||
    url.href !== `http://127.0.0.1:${preview.port}/`) throw new Error('real preview result invalid');
  if (step === 2) return tool('nexus_browser_open', { url: preview.url });
  const opened = toolResult(messages, calls[2], 'WRITE');
  if (opened.ok !== true || typeof opened.paneId !== 'string' || !opened.paneId || opened.state?.url !== preview.url) throw new Error('real browser open result differs');
  if (step === 3) return tool('nexus_browser_screenshot', { paneId: opened.paneId });
  const capture = toolResult(messages, calls[3], 'WRITE');
  if (typeof capture.artifactId !== 'string' || !/^[a-f0-9]{64}$/u.test(capture.sha256 ?? '') || typeof capture.path !== 'string' ||
    capture.width <= 0 || capture.height <= 0 || capture.url !== preview.url) throw new Error('real native capture result differs');
  if (step === 4) return tool('nexus_file_write', { path: 'runtime-report.txt', content: `RT_REPORT_${nonce}\nPrivate acceptance report created by the real CLI through its authorized Nexus tool.\n` });
  if (toolResult(messages, calls[4], 'WRITE').path !== 'runtime-report.txt') throw new Error('real report write result differs');
  if (step === 5) return tool('nexus_handoff_submit', { status: 'success',
    summary: `RT_WRITE_${nonce}: Private runtime acceptance report was written through scoped Nexus tools. This durable full report preserves the actual result and deliberately contains no operator credentials or external data.`,
    fullText: `RT_WRITE_${nonce}\nThe real CLI wrote the nonce page in its execution workspace, started an ordinary Nexus preview, opened the exact returned URL ${preview.url}, captured its native PNG and wrote runtime-report.txt. Capture artifact: ${capture.artifactId}; SHA256: ${capture.sha256}; dimensions: ${capture.width}x${capture.height}. Pixel inspection remains pending with the external verifier; capture is not an assertion of image contents.\nNo operator credentials, external pages, login, or model inference service were used by this fixture. The handoff and its ACK still require their physical authenticated Nexus receipts and normal Main gates.`,
    filesModified: [file, 'runtime-report.txt'], artifacts: [{ kind: 'nexus.browser.screenshot', payload: capture }] });
  return undefined;
}
/** Only inference is simulated. Every Nexus tool result must come from the real installed CLI. */
export async function startRuntimeGateway(nonce) {
  if (!/^[a-f0-9-]{36}$/u.test(nonce)) throw new Error('runtime gateway nonce invalid');
  let requests = 0, stopped = false, closeFlight = null, recovery = null;
  const sockets = new Set(), observations = [], questionCalls = [], writeCalls = [], recoveryCalls = [];
  const server = http.createServer((req, res) => {
    req.setTimeout(5000, () => req.destroy());
    if (stopped) { res.writeHead(503); res.end(); return; }
    if (req.url === '/runtime-hello' && req.method === 'GET') { res.end(JSON.stringify({ nonce, pid: process.pid })); return; }
    if (req.url === '/runtime-recovery' && req.method === 'GET') {
      if (req.headers['x-api-key'] !== `rt-${nonce}`) { res.writeHead(401); res.end('{}'); return; }
      res.end(JSON.stringify({ nonce, pid: process.pid, recovery })); return;
    }
    const requestPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(requestPath)) { res.writeHead(404); res.end('{}'); return; }
    if (req.headers['x-api-key'] !== `rt-${nonce}` && req.headers.authorization !== `Bearer rt-${nonce}`) { res.writeHead(401); res.end('{}'); return; }
    let raw = '', bytes = 0;
    req.on('data', part => { bytes += part.length; if (bytes > MAX_BYTES) req.destroy(); else raw += part; });
    req.on('end', () => {
      try {
        if (++requests > MAX_REQUESTS) throw new Error('runtime fixture request budget exceeded');
        const body = JSON.parse(raw);
        if (req.url.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 1 })); return; }
        const all = objects(body.messages), text = all.flatMap(v => typeof v.text === 'string' ? [v.text] : []).concat(
          (body.messages ?? []).flatMap(v => typeof v.content === 'string' ? [v.content] : [])).join('\n');
        const markers = [...text.matchAll(/RT_GATE (OPS|SPAWN|WRITE|REVIEW|ACK|QUESTION|RECOVER|RESUME|IDLE)/gu)];
        const kind = markers.at(-1)?.[1];
        const assistantBlocks = (body.messages ?? []).filter(message => message.role === 'assistant' && Array.isArray(message.content)).flatMap(message => message.content);
        const used = (['QUESTION', 'WRITE', 'RECOVER'].includes(kind) ? assistantBlocks : all).filter(v => v.type === 'tool_use' && typeof v.id === 'string' && v.id.startsWith(`toolu_rt_${kind}_`));
        const step = used.length;
        if (kind === 'QUESTION' && (!text.includes(`RT_GATE QUESTION ${nonce}`) || step > 2)) throw new Error('QUESTION instruction scope or step invalid');
        const tool = (suffix, input) => {
          const choices = (body.tools ?? []).filter(v => v.name === suffix || v.name?.endsWith(`__${suffix}`));
          if (choices.length !== 1) throw new Error(`real CLI did not advertise required tool: ${suffix}`);
          observations.push({ kind, step, tool: suffix });
          const call = { type: 'tool_use', id: `toolu_rt_${kind}_${step}`, name: choices[0].name, input };
          if (kind === 'QUESTION') questionCalls[step] = call;
          if (kind === 'WRITE') writeCalls[step] = call;
          if (kind === 'RECOVER') recoveryCalls[step] = call;
          return call;
        };
        let content = { type: 'text', text: 'Runtime fixture ready; waiting for scoped verifier instruction.' };
        if (kind === 'OPS' && step === 0) content = tool('nexus_terminal_run', { command: `printf RT_OPS_${nonce}` });
        else if (kind === 'SPAWN' && step < 2) content = tool('nexus_pane_spawn', { adapterId: 'claude', agentName: step ? 'Runtime reviewer' : 'Runtime writer',
          role: 'worker', task: step ? 'Review runtime report' : 'Fix the UI visual fixture inspection report',
          prompt: `RT_GATE IDLE ${nonce}. ${step ? 'Review the report when instructed.' : 'Fix the UI visual fixture inspection report: capture the local page with the Nexus browser and write runtime-report.txt when instructed.'} Wait for the scoped follow-up; use only Nexus tools within the approved private workspace.` });
        else if (kind === 'WRITE') {
          if (!text.includes(`RT_GATE WRITE ${nonce}`) || step > 6 || !used.every((call, index) => {
            const issued = writeCalls[index];
            return issued && call.id === issued.id && call.name === issued.name && call.input &&
              Object.keys(call.input).length === Object.keys(issued.input).length &&
              Object.keys(issued.input).every(key => JSON.stringify(call.input[key]) === JSON.stringify(issued.input[key]));
          })) throw new Error('real WRITE instruction or tool call binding invalid');
          content = writeReply(body.messages, step, tool, writeCalls, nonce) ?? content;
        }
        else if (kind === 'REVIEW' && step === 0) content = tool('nexus_file_read', { path: 'runtime-report.txt' });
        else if (kind === 'REVIEW' && step === 1) {
          if (!all.some(v => typeof v.content === 'string' && v.content.includes(`RT_REPORT_${nonce}`))) throw new Error('real file read result absent');
          content = tool('nexus_handoff_submit', { status: 'success',
          summary: `RT_${kind}_${nonce}: Private runtime acceptance report was ${kind === 'WRITE' ? 'written' : 'read and reviewed'} through scoped Nexus tools. This durable full report preserves the actual result and deliberately contains no operator credentials or external data.`,
          fullText: `RT_REVIEW_${nonce}\nThe real CLI executed the advertised scoped Nexus tools for the approved private runtime fixture. The reviewer read runtime-report.txt using the real file read tool and observed the RT_REPORT marker for this fixture.\nNo operator credentials, external pages, login, or model inference service were used by this fixture. The handoff and its ACK still require their physical authenticated Nexus receipts and normal Main gates.`,
          filesModified: [], artifacts: [] });
        }
        else if (kind === 'RECOVER') {
          const target = [...text.matchAll(/RT_GATE RECOVER ([a-f0-9-]{36}) ([A-Za-z0-9][A-Za-z0-9._:-]{0,255}) ([A-Za-z0-9][A-Za-z0-9._:-]{0,255})(?=\s|$)/gu)].at(-1);
          if (!target || target[1] !== nonce || step > 1) throw new Error('real recovery instruction scope invalid');
          if (step === 0) content = tool('nexus_pane_spawn', { resume: target[2], agentName: 'Runtime writer', role: 'worker', autoCloseOnHandoff: false,
            prompt: `RT_GATE IDLE ${nonce}. Continue the same approved private visual assignment; wait for the scoped WRITE follow-up.` });
          else {
            const call = used[0], issued = recoveryCalls[0];
            if (!issued || call.id !== issued.id || call.name !== issued.name || JSON.stringify(call.input) !== JSON.stringify(issued.input)) throw new Error('real recovery tool call binding invalid');
            const result = toolResult(body.messages, issued, 'RECOVER');
            const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
            if (result.ok !== true || !identifier(result.paneId) || !identifier(result.sessionId) || !identifier(result.requestId) ||
              result.paneId === target[2] || result.sessionId === target[3]) throw new Error('real recovery result identity invalid');
            recovery = { fromPaneId: target[2], fromSessionId: target[3], paneId: result.paneId, sessionId: result.sessionId, requestId: result.requestId };
          }
        }
        else if (kind === 'QUESTION' && step === 0) content = tool('nexus_clarify', { question: `RT_QUESTION_${nonce}: select the private fixture route.`, options: ['Proceed', 'Wait'], allowFreeform: false });
        else if (kind === 'QUESTION') {
          if (!used.every((call, index) => {
            const issued = questionCalls[index];
            return issued && call.id === issued.id && call.name === issued.name && call.input &&
              Object.keys(call.input).length === Object.keys(issued.input).length &&
              Object.keys(issued.input).every(key => JSON.stringify(call.input[key]) === JSON.stringify(issued.input[key]));
          })) throw new Error('real QUESTION tool call binding invalid');
          const result = toolResult(body.messages, questionCalls[0]);
          const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
          if (!identifier(result.missionId) || !identifier(result.questionId) || result.question !== questionCalls[0].input.question || result.allowFreeform !== false ||
            !Array.isArray(result.chips) || result.chips.length !== 2 || result.chips.some((chip, index) => !chip || !identifier(chip.id) || chip.label !== questionCalls[0].input.options[index]) ||
            new Set(result.chips.map(chip => chip.id)).size !== 2) throw new Error('real clarify result invalid or foreign');
          if (step === 1) content = tool('nexus_mission_set_status', { missionId: result.missionId, status: 'blocked',
            note: `RT_QUESTION_${nonce}: awaiting the operator's registered private fixture route answer.` });
          else {
            const status = toolResult(body.messages, questionCalls[1]);
            if (status.id !== result.missionId || status.status !== 'blocked' || status.intentState !== 'blocked_user' ||
              typeof status.learnings !== 'string' || !status.learnings.includes(questionCalls[1].input.note)) throw new Error('real QUESTION blocked status result invalid or foreign');
          }
        }
        else if (kind === 'ACK') {
          if (step === 0) content = tool('nexus_handoff_list', { full: true });
          else {
            const handoffs = all.filter(v => typeof v.id === 'string' && typeof v.summary === 'string' && v.summary.includes(nonce) && v.status === 'success');
            const unique = [...new Map(handoffs.map(v => [v.id, v])).values()];
            if (step <= unique.length) content = tool('nexus_handoff_ack', { handoffId: unique[step - 1].id });
          }
        } else if (kind === 'RESUME') {
          if (!text.includes(nonce) || !/RT_GATE (OPS|WRITE|REVIEW|QUESTION|IDLE)/u.test(text)) throw new Error('CLI resume did not preserve earlier conversation');
          content = { type: 'text', text: `RT_RESUME_OK_${nonce}` };
        }
        if (kind && content.type === 'text' && kind !== 'RESUME') content.text = `RT_DONE_${kind}_${nonce}`;
        stream(res, body.model ?? 'runtime-fixture', content);
      } catch (error) { res.writeHead(422); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: error.message } })); }
    });
  });
  server.maxConnections = 16;
  server.headersTimeout = 5000; server.requestTimeout = 10000; server.keepAliveTimeout = 1000;
  server.setTimeout(5000, socket => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, nonce, observations,
    close() { if (closeFlight) return closeFlight; stopped = true;
      closeFlight = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy(); return closeFlight; } };
}
