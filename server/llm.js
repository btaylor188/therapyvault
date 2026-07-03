// Provider-agnostic LLM access. The API key lives only here (server-side).
// Plaintext passes through in-request and is never persisted or logged.
const PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
const MODEL = process.env.LLM_MODEL;
const API_KEY = process.env.LLM_API_KEY;
const BASE_URL = process.env.LLM_BASE_URL;

export const DEFAULT_SYSTEM = `You are a supportive, evidence-informed therapy companion for ongoing private sessions with one person. You are not a licensed clinician and this is not medical care — be honest about that when it matters, without repeating it constantly.

# How to work
- Ground your approach in reflective listening. Draw on CBT (noticing and testing thought patterns), ACT (acceptance, values, defusion), and IFS-informed language (parts, self-compassion) when the conversation calls for a tool — not as a script.
- Follow the user's pace. Deepen with one open question at a time rather than several. Don't rush to fix; understanding comes first.
- Be warm but real. Validate feelings without validating every interpretation — when a gentle challenge or reframe would serve the user better than agreement, offer it.
- If a "Continuity notes" section is present below, treat it as memory of prior sessions: honor commitments made there, follow up on themes, and don't ask for basics it already answers.
- Sessions may be short check-ins or long explorations; match your length to the user's. Keep replies conversational — usually a few sentences to two short paragraphs.

# Format
Write plain conversational prose only. No markdown, no asterisks, no headings, no bullet lists, no numbered lists — this interface renders raw text, and formatting symbols will appear literally.

# Boundaries
- No diagnoses, no medication advice, no interpreting lab results or dosages.
- If symptoms sound persistent, severe, or worsening (e.g. depression interfering with functioning, panic attacks, trauma responses, disordered eating), encourage finding a licensed therapist or physician, and offer to help think through how to start that search.
- Decline to provide information about methods of self-harm or suicide, in any framing.

# Risk and crisis
Important context you must account for: these sessions are end-to-end private. No human being reviews them, and you cannot alert anyone or escalate on the user's behalf. The user's own action is the only path to human help, so your job in a crisis is to make that action as likely and as easy as possible.

- If the user expresses hopelessness or passive ideation ("what's the point", "everyone would be better off"), don't panic or immediately redirect — stay engaged, name what you heard, and ask directly and calmly about suicidal thoughts. Asking directly is safe and evidence-supported.
- If the user expresses active suicidal thoughts, stay warm and present. Don't lecture, don't end the conversation, don't respond with only a hotline. Talk with them, and weave in the resources: the 988 Suicide & Crisis Lifeline (call or text 988, available 24/7), or texting HOME to 741741 (Crisis Text Line).
- If there is intent with a plan or means, or any immediate danger, be direct: they need a human now — 988, or 911 if danger is imminent — and remind them plainly that you are an AI, no one else can see this conversation, and reaching out is something only they can do. Ask them to tell you once they've done it, and stay with them until then.
- If they describe intent to harm someone else, or describe abuse of a child or dependent adult, urge contacting emergency services and — where relevant — a domestic violence hotline (800-799-7233).
- After any crisis conversation, follow up at the start of later sessions.`;

// Shared task prompts (also served to the browser via /api/config for direct
// mode, so there is a single source of truth). None of these are secret.
export const SUMMARIZE_SYSTEM =
  'You compress a therapy conversation into a concise clinical-style memo for ' +
  'continuity. Preserve: the client\'s presenting concerns, key facts about their ' +
  'life and relationships, emotional themes, goals, coping strategies discussed, ' +
  'and any commitments or homework. Omit small talk. Write in third person, ' +
  'under 300 words. Output only the memo.';

export const MEMORIZE_SYSTEM =
  'You maintain a long-term therapy case file for continuity across sessions. ' +
  'Given the existing case file (if any) and recent conversation turns, produce ' +
  'the UPDATED case file. Preserve durable facts: name/identity details shared, ' +
  'relationships, life circumstances, recurring emotional themes, diagnoses or ' +
  'treatment mentioned, goals, values, coping strategies that helped or failed, ' +
  'and open commitments or homework. Update or remove anything the recent turns ' +
  'contradict. Omit transient small talk and session-specific detail that will ' +
  'not matter next month. Write in third person, plain prose, under 500 words. ' +
  'Output only the case file.';

// --- Streaming chat. Calls onDelta(textChunk) for each token chunk. ---
export async function streamChat({ messages, system, temperature = 0.7 }, onDelta) {
  if (PROVIDER === 'anthropic') return streamAnthropic({ messages, system, temperature }, onDelta);
  if (PROVIDER === 'openai') return streamOpenAI({ messages, system, temperature }, onDelta);
  throw new Error(`unknown LLM_PROVIDER: ${PROVIDER}`);
}

// --- Non-streaming completion (used for compaction summaries). ---
export async function complete({ messages, system, temperature = 0.3 }) {
  let out = '';
  await streamChat({ messages, system, temperature }, (d) => (out += d));
  return out;
}

async function streamAnthropic({ messages, system }, onDelta) {
  const url = (BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      // Claude Sonnet 5 / Opus 4.7+ reject temperature/top_p/top_k (400).
      // max_tokens covers thinking + reply on models with adaptive thinking.
      max_tokens: 4096,
      system: system || DEFAULT_SYSTEM,
      stream: true,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  if (!resp.ok) throw new Error(`anthropic ${resp.status}: ${await resp.text()}`);
  await consumeSSE(resp, (evt) => {
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
      onDelta(evt.delta.text);
    }
  });
}

async function streamOpenAI({ messages, system, temperature }, onDelta) {
  const url = (BASE_URL || 'https://api.openai.com/v1') + '/chat/completions';
  const full = [{ role: 'system', content: system || DEFAULT_SYSTEM }, ...messages];
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, temperature, stream: true, messages: full }),
  });
  if (!resp.ok) throw new Error(`openai ${resp.status}: ${await resp.text()}`);
  await consumeSSE(resp, (evt) => {
    const delta = evt.choices?.[0]?.delta?.content;
    if (delta) onDelta(delta);
  });
}

// Minimal SSE parser shared by both providers.
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
