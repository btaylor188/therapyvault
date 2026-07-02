import {
  createVaultMaterial,
  unlockVault,
  rotatePassword,
  encStr,
  decStr,
} from './crypto.js';

// ---------- state ----------
const state = {
  me: null,
  cfg: { compactTokenThreshold: 8000, compactKeepRecent: 8, provider: 'anthropic' },
  vaultRaw: null, // raw vault material from server (for rotation)
  dekKey: null, // in-memory only; cleared on lock
  convs: [],
  convId: null,
  msgs: [], // decrypted: {id, kind, role, content, token_est, archived}
  busy: false,
};

const $ = (id) => document.getElementById(id);
const estTokens = (s) => Math.ceil((s || '').length / 4);

// ---------- api ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('unauthenticated');
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

// ---------- init ----------
async function init() {
  state.me = await api('/api/me');
  state.cfg = await api('/api/config');
  $('who').textContent = state.me.email;
  const vault = await api('/api/vault');
  if (!vault.exists) showGate('create');
  else {
    state.vaultRaw = vault;
    showGate('unlock');
  }
}

// ---------- vault gate ----------
function showGate(mode) {
  $('main').classList.add('hidden');
  $('gate').classList.remove('hidden');
  const pw2 = $('vault-pw2');
  if (mode === 'create') {
    $('gate-desc').textContent =
      'Set a vault password. It encrypts everything you write here and is never sent to the server.';
    $('gate-btn').textContent = 'Create vault';
    pw2.classList.remove('hidden');
  } else {
    $('gate-desc').textContent = 'Enter your vault password to decrypt your sessions.';
    $('gate-btn').textContent = 'Unlock';
    pw2.classList.add('hidden');
  }
  $('gate-form').dataset.mode = mode;
  $('vault-pw').value = '';
  pw2.value = '';
  $('gate-err').textContent = '';
  $('vault-pw').focus();
}

$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = $('gate-form').dataset.mode;
  const pw = $('vault-pw').value;
  const errEl = $('gate-err');
  errEl.textContent = '';
  $('gate-btn').disabled = true;
  try {
    if (mode === 'create') {
      if (pw.length < 10) throw new Error('Use at least 10 characters.');
      if (pw !== $('vault-pw2').value) throw new Error('Passwords do not match.');
      const { material, dekKey } = await createVaultMaterial(pw);
      await api('/api/vault', { method: 'POST', body: JSON.stringify(material) });
      state.vaultRaw = { exists: true, ...material };
      state.dekKey = dekKey;
    } else {
      state.dekKey = await unlockVault(pw, state.vaultRaw);
    }
    await enterApp();
  } catch (err) {
    errEl.textContent =
      err.code === 'BAD_PASSWORD' ? 'Wrong vault password.' : err.message;
  } finally {
    $('gate-btn').disabled = false;
  }
});

async function enterApp() {
  $('gate').classList.add('hidden');
  $('main').classList.remove('hidden');
  await loadConversations();
}

function lockVault() {
  state.dekKey = null;
  state.convId = null;
  state.msgs = [];
  $('messages').innerHTML = '';
  $('conv-list').innerHTML = '';
  showGate('unlock');
}
$('lock').addEventListener('click', lockVault);

$('logout').addEventListener('click', async () => {
  const { redirect } = await api('/auth/logout', { method: 'POST' });
  location.href = redirect || '/';
});

$('rotate').addEventListener('click', async () => {
  const oldPw = prompt('Current vault password:');
  if (!oldPw) return;
  const newPw = prompt('New vault password (min 10 chars):');
  if (!newPw || newPw.length < 10) return alert('Password too short.');
  try {
    const material = await rotatePassword(oldPw, newPw, state.vaultRaw);
    await api('/api/vault', { method: 'PUT', body: JSON.stringify(material) });
    state.vaultRaw = { exists: true, ...material };
    alert('Vault password changed. Your history is unchanged.');
  } catch (err) {
    alert(err.code === 'BAD_PASSWORD' ? 'Wrong current password.' : err.message);
  }
});

// ---------- conversations ----------
async function loadConversations() {
  state.convs = await api('/api/conversations');
  const ul = $('conv-list');
  ul.innerHTML = '';
  for (const c of state.convs) {
    const li = document.createElement('li');
    li.className = 'conv-item' + (c.id === state.convId ? ' active' : '');
    li.textContent = c.title_enc ? await safeDec(c.title_enc, '(untitled)') : 'New session';
    li.addEventListener('click', () => openConversation(c.id));
    ul.appendChild(li);
  }
}

async function safeDec(blob, fallback) {
  try {
    return await decStr(state.dekKey, blob);
  } catch {
    return fallback;
  }
}

$('new-conv').addEventListener('click', async () => {
  const c = await api('/api/conversations', { method: 'POST', body: JSON.stringify({}) });
  state.convs.unshift(c);
  await openConversation(c.id);
  await loadConversations();
});

async function openConversation(id) {
  state.convId = id;
  const rows = await api(`/api/conversations/${id}/messages`);
  state.msgs = [];
  for (const r of rows) {
    state.msgs.push({
      id: r.id,
      kind: r.kind,
      role: r.role,
      token_est: r.token_est,
      archived: r.archived,
      content: await safeDec(r.body_enc, '[unreadable]'),
    });
  }
  renderMessages();
  updateMeter();
  const c = state.convs.find((x) => x.id === id);
  $('conv-title').textContent = c?.title_enc ? await safeDec(c.title_enc, 'Session') : 'Session';
  document.querySelectorAll('.conv-item').forEach((el) => el.classList.remove('active'));
}

// ---------- rendering ----------
function renderMessages() {
  const box = $('messages');
  box.innerHTML = '';
  for (const m of state.msgs) {
    if (m.archived) continue;
    if (m.kind === 'summary') {
      const d = document.createElement('div');
      d.className = 'summary';
      d.textContent = '⤺ Earlier in this session was summarized to save space.';
      box.appendChild(d);
      continue;
    }
    box.appendChild(bubble(m.role, m.content));
  }
  box.scrollTop = box.scrollHeight;
}

function bubble(role, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  d.textContent = text;
  return d;
}

function updateMeter() {
  const total = state.msgs
    .filter((m) => !m.archived)
    .reduce((s, m) => s + (m.token_est || estTokens(m.content)), 0);
  $('ctx-meter').textContent = `~${total} tok`;
}

// ---------- send / stream ----------
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || state.busy) return;
  if (!state.convId) {
    const c = await api('/api/conversations', { method: 'POST', body: JSON.stringify({}) });
    state.convs.unshift(c);
    state.convId = c.id;
    await loadConversations();
  }
  state.busy = true;
  input.value = '';
  setStatus('');

  // 1) persist + show user turn
  const userMsg = { role: 'user', kind: 'message', content: text, token_est: estTokens(text) };
  await persistMessage(userMsg);
  state.msgs.push(userMsg);
  $('messages').appendChild(bubble('user', text));

  // 2) auto-title from first user message
  const c = state.convs.find((x) => x.id === state.convId);
  if (c && !c.title_enc) {
    const title = text.slice(0, 40);
    const title_enc = await encStr(state.dekKey, title);
    await api(`/api/conversations/${state.convId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title_enc }),
    });
    c.title_enc = title_enc;
    loadConversations();
  }

  // 3) stream assistant reply
  const liveEl = bubble('assistant', '');
  liveEl.classList.add('streaming');
  $('messages').appendChild(liveEl);
  $('messages').scrollTop = $('messages').scrollHeight;

  let reply = '';
  try {
    await streamAssistant((delta) => {
      reply += delta;
      liveEl.textContent = reply;
      $('messages').scrollTop = $('messages').scrollHeight;
    });
  } catch (err) {
    setStatus('Error: ' + err.message);
    liveEl.classList.remove('streaming');
    state.busy = false;
    return;
  }
  liveEl.classList.remove('streaming');

  // 4) persist assistant turn
  const aMsg = { role: 'assistant', kind: 'message', content: reply, token_est: estTokens(reply) };
  await persistMessage(aMsg);
  state.msgs.push(aMsg);
  updateMeter();

  // 5) compact if needed
  await maybeCompact();
  state.busy = false;
}

async function persistMessage(m) {
  const body_enc = await encStr(state.dekKey, m.content);
  const saved = await api(`/api/conversations/${state.convId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role: m.role, kind: m.kind, body_enc, token_est: m.token_est }),
  });
  m.id = saved.id;
}

// Build the model context from active (non-archived) turns + a memo from summaries.
function buildContext() {
  const active = state.msgs.filter((m) => !m.archived);
  const memo = active
    .filter((m) => m.kind === 'summary')
    .map((m) => m.content)
    .join('\n\n');
  const turns = active
    .filter((m) => m.kind === 'message' && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: m.content }));
  return { memo: memo || undefined, messages: turns };
}

async function streamAssistant(onDelta) {
  const { memo, messages } = buildContext();
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, memo }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!line.startsWith('data:')) continue;
      const evt = JSON.parse(line.slice(5).trim());
      if (evt.error) throw new Error(evt.error);
      if (evt.delta) onDelta(evt.delta);
      if (evt.done) return;
    }
  }
}

// ---------- compaction ----------
async function maybeCompact() {
  const active = state.msgs.filter((m) => !m.archived);
  const total = active.reduce((s, m) => s + (m.token_est || estTokens(m.content)), 0);
  if (total <= state.cfg.compactTokenThreshold) return;

  setStatus('Compacting older messages…');

  // Keep the most recent N verbatim turns; fold everything older (incl. old summary).
  const keep = state.cfg.compactKeepRecent;
  const turns = active.filter((m) => m.kind === 'message');
  const foldTurns = turns.slice(0, Math.max(0, turns.length - keep));
  const oldSummaries = active.filter((m) => m.kind === 'summary');
  const foldable = [...oldSummaries, ...foldTurns];
  if (foldTurns.length < 2) {
    setStatus('');
    return; // nothing meaningful to fold yet
  }

  // Ask the model to summarize prior summary + folded turns.
  const summarizeMsgs = [
    ...oldSummaries.map((m) => ({ role: 'user', content: `[Prior summary]\n${m.content}` })),
    ...foldTurns.map((m) => ({ role: m.role, content: m.content })),
  ];
  let summaryText;
  try {
    const r = await api('/api/summarize', {
      method: 'POST',
      body: JSON.stringify({ messages: summarizeMsgs }),
    });
    summaryText = r.summary;
  } catch (err) {
    setStatus('Compaction skipped: ' + err.message);
    return;
  }

  const body_enc = await encStr(state.dekKey, summaryText);
  const archive_ids = foldable.map((m) => m.id).filter(Boolean);
  const { summary } = await api(`/api/conversations/${state.convId}/compact`, {
    method: 'POST',
    body: JSON.stringify({
      summary: { role: 'system', body_enc, token_est: estTokens(summaryText) },
      archive_ids,
    }),
  });

  // Update in-memory: mark folded archived, insert new summary.
  const foldSet = new Set(archive_ids);
  for (const m of state.msgs) if (foldSet.has(m.id)) m.archived = true;
  state.msgs.push({
    id: summary.id,
    kind: 'summary',
    role: 'system',
    content: summaryText,
    token_est: summary.token_est,
    archived: false,
  });
  renderMessages();
  updateMeter();
  setStatus('Compacted. Older turns are still stored (encrypted) but no longer sent to the model.');
}

function setStatus(s) {
  $('status').textContent = s;
}

// ---------- go ----------
init().catch((e) => {
  document.body.innerHTML = `<pre style="padding:2rem">Startup error: ${e.message}</pre>`;
});
