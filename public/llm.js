// Direct-mode LLM transport: browser -> api.anthropic.com, no server hop.
// In this mode plaintext exists only in this browser and at Anthropic; the
// app server never sees it. The API key is decrypted from the vault into
// memory only (like the DEK) and sent straight to Anthropic over TLS.
//
// The 'anthropic-dangerous-direct-browser-access' header opts into CORS.
// "Dangerous" refers to key exposure in public web apps; here the only users
// are the key's owners.

export async function streamAnthropic({ apiKey, model, system, messages }, onDelta) {
  if (!apiKey) {
    const e = new Error('No API key set. Add yours via "API key" in the sidebar.');
    e.code = 'NO_API_KEY';
    throw e;
  }
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      stream: true,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  if (!resp.ok) {
    let msg = `Anthropic error ${resp.status}`;
    try {
      msg = JSON.parse(await resp.text())?.error?.message || msg;
    } catch {}
    const e = new Error(msg);
    if (resp.status === 401) e.code = 'BAD_API_KEY';
    throw e;
  }
  await consumeSSE(resp, (evt) => {
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
      onDelta(evt.delta.text);
    }
  });
}

// Non-streaming completion (compaction summaries, memory updates).
export async function completeAnthropic(opts) {
  let out = '';
  await streamAnthropic(opts, (d) => (out += d));
  return out;
}

async function consumeSSE(resp, onEvent) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          onEvent(JSON.parse(data));
        } catch {
          /* ignore keep-alives / non-JSON */
        }
      }
    }
  }
}
