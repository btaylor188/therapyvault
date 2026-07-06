import {
  createVaultMaterial,
  unlockVault,
  rotatePassword,
  encStr,
  decStr,
} from './crypto.js';
import { streamAnthropic, completeAnthropic } from './llm.js';

// ---------- state ----------
const state = {
  me: null,
  cfg: { compactTokenThreshold: 8000, compactKeepRecent: 8 },
  vaultRaw: null, // raw vault material from server (for rotation)
  dekKey: null, // in-memory only; cleared on lock
  convs: [],
  convId: null,
  msgs: [], // decrypted: {id, kind, role, content, token_est, archived}
  busy: false,
  memory: '', // long-term case file (decrypted); '' = none
  turnsSinceMemory: 0, // messages since the case file was last refreshed
  apiKey: null, // user's Anthropic key, in-memory only (like the DEK)
  prefs: { style: 'integrative', custom: '' }, // therapy style + custom instructions (decrypted)
};

// Refresh the long-term case file after this many new messages (user+assistant).
const MEMORY_UPDATE_TURNS = 8;

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
  state.apiKey = state.vaultRaw.api_key_enc
    ? await safeDec(state.vaultRaw.api_key_enc, null)
    : null;
  await Promise.all([loadConversations(), loadMemory(), loadPrefs()]);
  armIdleLock();
  if (!state.apiKey) openKeyModal();
}

// ---------- long-term memory (case file) ----------
async function loadMemory() {
  try {
    const m = await api('/api/memory');
    state.memory = m.exists ? await safeDec(m.body_enc, '') : '';
  } catch {
    state.memory = ''; // non-fatal; chat still works without memory
  }
}

async function saveMemory(text) {
  state.memory = text;
  if (!text) return api('/api/memory', { method: 'DELETE' });
  const body_enc = await encStr(state.dekKey, text);
  return api('/api/memory', { method: 'PUT', body: JSON.stringify({ body_enc }) });
}

// Fold recent turns into the case file (browser -> Anthropic on the utility
// model), then store encrypted. Non-fatal on failure — worst case the memory
// is a bit stale.
// Returns true if the case file was actually refreshed.
async function updateMemory(force = false) {
  if (!state.dekKey) return false;
  if (!force && state.turnsSinceMemory < MEMORY_UPDATE_TURNS) return false;
  const recent = state.msgs
    .filter((m) => !m.archived && m.kind === 'message' && (m.role === 'user' || m.role === 'assistant'))
    .slice(-2 * MEMORY_UPDATE_TURNS)
    .map((m) => ({ role: m.role, content: m.content }));
  if (recent.length < 2) return false;
  try {
    const updated = await completeAnthropic({
      apiKey: state.apiKey,
      model: state.cfg.utilityModel || state.cfg.model,
      system: state.cfg.prompts.memorize,
      messages: [
        ...(state.memory
          ? [{ role: 'user', content: `[Existing case file]\n${state.memory}` }]
          : []),
        ...recent,
        { role: 'user', content: 'Produce the updated case file now.' },
      ],
    });
    await saveMemory(updated);
    state.turnsSinceMemory = 0;
    return true;
  } catch (err) {
    setStatus('Memory update skipped: ' + err.message);
    return false;
  }
}

function lockVault() {
  clearTimeout(idleTimer);
  state.dekKey = null;
  state.apiKey = null;
  state.convId = null;
  state.msgs = [];
  state.memory = '';
  state.turnsSinceMemory = 0;
  state.prefs = { style: 'integrative', custom: '' };
  $('messages').innerHTML = '';
  $('conv-list').innerHTML = '';
  showGate('unlock');
}
$('lock').addEventListener('click', lockVault);

// Auto-lock: wipe the DEK + API key from memory after this long without user
// activity, so an unattended unlocked tab doesn't stay a target indefinitely.
const IDLE_LOCK_MS = 15 * 60 * 1000;
let idleTimer = null;
function armIdleLock() {
  if (!state.dekKey) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (state.busy) return armIdleLock(); // never lock mid-reply
    lockVault();
    $('gate-desc').textContent =
      'Locked after 15 minutes of inactivity. Enter your vault password to continue.';
  }, IDLE_LOCK_MS);
}
document.addEventListener('pointerdown', armIdleLock, { passive: true });
document.addEventListener('keydown', armIdleLock, { passive: true });

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

// ---------- API key modal ----------
function openKeyModal() {
  $('key-input').value = '';
  $('key-err').textContent = state.apiKey ? '' : 'No key set — chat is disabled until you add one.';
  $('key-modal').classList.remove('hidden');
  $('key-input').focus();
}
$('key-btn').addEventListener('click', openKeyModal);
$('key-close').addEventListener('click', () => $('key-modal').classList.add('hidden'));
$('key-save').addEventListener('click', async () => {
  const key = $('key-input').value.trim();
  if (!key) return ($('key-err').textContent = 'Enter a key.');
  try {
    const api_key_enc = await encStr(state.dekKey, key);
    await api('/api/vault/api-key', { method: 'PUT', body: JSON.stringify({ api_key_enc }) });
    state.apiKey = key;
    state.vaultRaw.api_key_enc = api_key_enc;
    $('key-modal').classList.add('hidden');
  } catch (err) {
    $('key-err').textContent = err.message;
  }
});
$('key-clear').addEventListener('click', async () => {
  if (!confirm('Remove your stored API key? Chat will stop working until you add one.')) return;
  try {
    await api('/api/vault/api-key', { method: 'PUT', body: JSON.stringify({ api_key_enc: null }) });
    state.apiKey = null;
    state.vaultRaw.api_key_enc = null;
    $('key-modal').classList.add('hidden');
  } catch (err) {
    $('key-err').textContent = err.message;
  }
});

// ---------- memory modal ----------
$('memory-btn').addEventListener('click', () => {
  $('mem-text').value = state.memory;
  $('mem-err').textContent = '';
  $('mem-modal').classList.remove('hidden');
});
$('mem-close').addEventListener('click', () => $('mem-modal').classList.add('hidden'));
$('mem-save').addEventListener('click', async () => {
  try {
    await saveMemory($('mem-text').value.trim());
    $('mem-modal').classList.add('hidden');
  } catch (err) {
    $('mem-err').textContent = err.message;
  }
});
$('mem-forget').addEventListener('click', async () => {
  if (!confirm('Erase everything the AI remembers across sessions? This cannot be undone.')) return;
  try {
    await saveMemory('');
    $('mem-text').value = '';
    $('mem-modal').classList.add('hidden');
  } catch (err) {
    $('mem-err').textContent = err.message;
  }
});

// ---------- prefs (therapy style + custom instructions) ----------
// Stored server-side as one encrypted JSON blob, like the case file.
async function loadPrefs() {
  try {
    const p = await api('/api/prefs');
    if (!p.exists) return;
    const parsed = JSON.parse(await safeDec(p.body_enc, '{}'));
    state.prefs = {
      style: typeof parsed.style === 'string' ? parsed.style : 'integrative',
      custom: typeof parsed.custom === 'string' ? parsed.custom : '',
    };
  } catch {
    // non-fatal; defaults stand
  }
}

async function savePrefs() {
  const body_enc = await encStr(state.dekKey, JSON.stringify(state.prefs));
  return api('/api/prefs', { method: 'PUT', body: JSON.stringify({ body_enc }) });
}

const styleById = (id) => (state.cfg.styles || []).find((s) => s.id === id);

const MAX_CUSTOM_CHARS = 4000;

function openStyleModal() {
  const sel = $('style-select');
  sel.innerHTML = '';
  for (const s of state.cfg.styles || []) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label;
    sel.appendChild(opt);
  }
  sel.value = styleById(state.prefs.style) ? state.prefs.style : 'integrative';
  $('style-desc').textContent = styleById(sel.value)?.description || '';
  $('style-custom').value = state.prefs.custom;
  $('style-err').textContent = '';
  $('style-modal').classList.remove('hidden');
}
$('style-btn').addEventListener('click', openStyleModal);
$('style-close').addEventListener('click', () => $('style-modal').classList.add('hidden'));
$('style-select').addEventListener('change', () => {
  $('style-desc').textContent = styleById($('style-select').value)?.description || '';
});
$('style-save').addEventListener('click', async () => {
  const custom = $('style-custom').value.trim();
  if (custom.length > MAX_CUSTOM_CHARS) {
    $('style-err').textContent = `Custom instructions too long (max ${MAX_CUSTOM_CHARS} characters).`;
    return;
  }
  try {
    state.prefs = { style: $('style-select').value, custom };
    await savePrefs();
    $('style-modal').classList.add('hidden');
    setStatus('Therapy style saved. It applies from your next message.');
  } catch (err) {
    $('style-err').textContent = err.message;
  }
});
$('style-reset').addEventListener('click', async () => {
  try {
    state.prefs = { style: 'integrative', custom: '' };
    await api('/api/prefs', { method: 'DELETE' });
    $('style-modal').classList.add('hidden');
    setStatus('Therapy style reset to default.');
  } catch (err) {
    $('style-err').textContent = err.message;
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

    const title = document.createElement('span');
    title.className = 'conv-item-title';
    title.textContent = c.title_enc ? await safeDec(c.title_enc, '(untitled)') : 'New session';
    li.appendChild(title);

    const del = document.createElement('button');
    del.className = 'conv-del';
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Delete session';
    del.setAttribute('aria-label', 'Delete session');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(c.id);
    });
    li.appendChild(del);

    li.addEventListener('click', () => openConversation(c.id));
    ul.appendChild(li);
  }
}

async function deleteConversation(id) {
  const c = state.convs.find((x) => x.id === id);
  const label = c?.title_enc ? await safeDec(c.title_enc, 'this session') : 'this session';
  if (!confirm(`Delete "${label}"? This permanently erases the session and all its messages.`)) {
    return;
  }
  await api(`/api/conversations/${id}`, { method: 'DELETE' });
  state.convs = state.convs.filter((x) => x.id !== id);
  if (state.convId === id) {
    state.convId = null;
    state.msgs = [];
    $('messages').innerHTML = '';
    $('conv-title').textContent = 'Session';
    updateMeter();
  }
  await loadConversations();
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
  if (!state.apiKey) return openKeyModal();
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

  // 5) compact if needed, then refresh the long-term case file if due
  await maybeCompact();
  state.turnsSinceMemory += 2;
  await updateMemory();
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

// Build the model context: active (non-archived) turns + this session's
// compaction memo + the long-term case file (memory across all sessions).
function buildContext() {
  const active = state.msgs.filter((m) => !m.archived);
  const memo = active
    .filter((m) => m.kind === 'summary')
    .map((m) => m.content)
    .join('\n\n');
  const turns = active
    .filter((m) => m.kind === 'message' && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: m.content }));
  return { memo: memo || undefined, memory: state.memory || undefined, messages: turns };
}

// Browser -> Anthropic, system prompt assembled locally.
// Plaintext never touches our server.
async function streamAssistant(onDelta) {
  const { memo, memory, messages } = buildContext();
  let system = state.cfg.prompts.system;
  const stylePrompt = styleById(state.prefs.style)?.prompt;
  if (stylePrompt) system += `\n\n# Therapeutic approach chosen by the user\n${stylePrompt}`;
  if (state.prefs.custom) system += `\n\n# Custom instructions from the user\n${state.prefs.custom}`;
  if (memory) system += `\n\n# Continuity notes — long-term case file (all prior sessions)\n${memory}`;
  if (memo) system += `\n\n# Continuity notes — earlier in this session (summarized)\n${memo}`;
  return streamAnthropic(
    { apiKey: state.apiKey, model: state.cfg.model, system, messages },
    onDelta
  );
}

// ---------- compaction ----------
// force=true (the "Compact now" button) skips the token threshold but still
// keeps the most recent turns verbatim. Returns true if a summary was made.
async function maybeCompact(force = false) {
  const active = state.msgs.filter((m) => !m.archived);
  const total = active.reduce((s, m) => s + (m.token_est || estTokens(m.content)), 0);
  if (!force && total <= state.cfg.compactTokenThreshold) return false;

  setStatus('Compacting older messages…');

  // Keep the most recent N verbatim turns; fold everything older (incl. old summary).
  const keep = state.cfg.compactKeepRecent;
  const turns = active.filter((m) => m.kind === 'message');
  const foldTurns = turns.slice(0, Math.max(0, turns.length - keep));
  const oldSummaries = active.filter((m) => m.kind === 'summary');
  const foldable = [...oldSummaries, ...foldTurns];
  if (foldTurns.length < 2) {
    setStatus(
      force
        ? `Nothing to compact yet — the newest ${keep} turns always stay verbatim.`
        : ''
    );
    return false; // nothing meaningful to fold yet
  }

  // Ask the model to summarize prior summary + folded turns.
  const summarizeMsgs = [
    ...oldSummaries.map((m) => ({ role: 'user', content: `[Prior summary]\n${m.content}` })),
    ...foldTurns.map((m) => ({ role: m.role, content: m.content })),
  ];
  let summaryText;
  try {
    summaryText = await completeAnthropic({
      apiKey: state.apiKey,
      model: state.cfg.utilityModel || state.cfg.model,
      system: state.cfg.prompts.summarize,
      messages: [
        ...summarizeMsgs,
        { role: 'user', content: 'Produce the continuity memo now.' },
      ],
    });
  } catch (err) {
    setStatus('Compaction skipped: ' + err.message);
    return false;
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
  return true;
}

// Manual "Compact now": run compaction + a case-file refresh immediately,
// outside the automatic thresholds.
$('compact-btn').addEventListener('click', async () => {
  if (state.busy) return;
  if (!state.convId) return setStatus('Open a session first.');
  if (!state.apiKey) return setStatus('Add your API key first (sidebar → API key).');
  state.busy = true;
  $('compact-btn').disabled = true;
  try {
    const compacted = await maybeCompact(true);
    setStatus('Refreshing long-term memory…');
    const memorized = await updateMemory(true);
    if (compacted || memorized) {
      setStatus(
        [
          compacted ? 'Compacted this session' : 'Nothing to compact',
          memorized ? 'long-term memory refreshed.' : 'memory unchanged.',
        ].join('; ')
      );
    } else {
      setStatus('Nothing to do yet — have a bit more conversation first.');
    }
  } finally {
    state.busy = false;
    $('compact-btn').disabled = false;
  }
});

function setStatus(s) {
  $('status').textContent = s;
}

// ---------- go ----------
init().catch((e) => {
  document.body.innerHTML = `<pre style="padding:2rem">Startup error: ${e.message}</pre>`;
});
