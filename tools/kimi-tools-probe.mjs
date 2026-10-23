// Probe (2026-10-23): does Kimi, behind the studio's route, do streamed tool calling for the chat pane?
// Reads KIMI_BASE_URL, KIMI_MODEL_ID, KIMI_API_KEY from the environment (never printed). Run: node tools/kimi-tools-probe.mjs
// Round 1 asks for a tool call; round 2 sends the tool result back, first WITHOUT the assistant's reasoning_content
// (a 400 means it must be echoed), then with it if that was refused.

const { KIMI_BASE_URL, KIMI_MODEL_ID, KIMI_API_KEY } = process.env;
if (!KIMI_BASE_URL || !KIMI_MODEL_ID || !KIMI_API_KEY) {
  console.error('set KIMI_BASE_URL, KIMI_MODEL_ID and KIMI_API_KEY');
  process.exit(2);
}

const tools = [{
  type: 'function',
  function: {
    name: 'add_step',
    description: 'Add a step to the workflow',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
}];

/** One streamed round: prints each data line's delta keys, returns the assembled assistant message and usage. */
async function round(messages, label) {
  const r = await fetch(`${KIMI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KIMI_API_KEY}` },
    // the wand's body shape (src/WorkflowStudio/src/ai/drawing.ts requestDrawing), plus tools and usage
    body: JSON.stringify({ model: KIMI_MODEL_ID, reasoning_effort: 'low', stream: true, stream_options: { include_usage: true }, tools, messages }),
  });
  console.log(`\n== ${label}: HTTP ${r.status}`);
  if (!r.ok) { console.log((await r.text()).slice(0, 600)); return { status: r.status }; }
  const msg = { role: 'assistant', content: '', reasoning_content: '', tool_calls: [] };
  let usage = null, n = 0;
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  const line = (l) => {
    const t = l.trim();
    if (!t.startsWith('data:')) return;
    const data = t.slice(5).trim();
    if (data === '[DONE]') { console.log('data: [DONE]'); return; }
    const v = JSON.parse(data);
    const c = v.choices?.[0];
    const d = c?.delta ?? {};
    if (v.usage) usage = v.usage;
    if (n++ < 40 || d.tool_calls || v.usage || c?.finish_reason) {
      console.log(`delta keys=[${Object.keys(d)}] finish=${c?.finish_reason ?? '-'} top=[${Object.keys(v)}]${d.tool_calls ? ' tool_calls=' + JSON.stringify(d.tool_calls) : ''}${v.usage ? ' usage=' + JSON.stringify(v.usage) : ''}`);
    }
    if (typeof d.content === 'string') msg.content += d.content;
    if (typeof d.reasoning_content === 'string') msg.reasoning_content += d.reasoning_content;
    for (const tc of d.tool_calls ?? []) {
      const at = (msg.tool_calls[tc.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) at.id = tc.id;
      if (tc.function?.name) at.function.name += tc.function.name;
      if (tc.function?.arguments) at.function.arguments += tc.function.arguments;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = done ? '' : lines.pop();
    lines.forEach(line);
    if (done) break;
  }
  if (!msg.reasoning_content) delete msg.reasoning_content;
  if (msg.tool_calls.length === 0) delete msg.tool_calls;
  console.log(`assembled: content=${JSON.stringify(msg.content.slice(0, 300))} reasoning_chars=${msg.reasoning_content?.length ?? 0} tool_calls=${JSON.stringify(msg.tool_calls)}`);
  console.log(`usage: ${JSON.stringify(usage)}`);
  return { status: r.status, msg, usage };
}

const first = [{ role: 'user', content: 'add a step named fetch' }];
const one = await round(first, 'round 1');
if (!one.msg?.tool_calls?.length) { console.log('\nRESULT: no tool call came back'); process.exit(1); }
const call = one.msg.tool_calls[0];
const result = { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, stepId: 'step-1' }) };

const { reasoning_content, ...bare } = one.msg;
const without = await round([...first, bare, result], 'round 2 WITHOUT reasoning_content');
if (without.status === 200) {
  console.log('\nRESULT: round 2 works without echoing reasoning_content');
} else {
  const withIt = await round([...first, one.msg, result], 'round 2 WITH reasoning_content');
  console.log(withIt.status === 200 ? '\nRESULT: reasoning_content must be echoed back' : '\nRESULT: round 2 failed both ways');
}
