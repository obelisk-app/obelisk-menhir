// Obelisk Menhir — vanilla JS Nostr text-channel client.
// Identity: nsec in localStorage (MVP). Transport: raw NIP-01 websocket.
// Under Tauri, hosting + .onion bridging are provided by Rust commands.

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';

// ---------- small helpers ----------

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function shortNpub(pkHex) {
  const npub = nip19.npubEncode(pkHex);
  return npub.slice(0, 12) + '…' + npub.slice(-4);
}
function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const tauriInvoke = window.__TAURI__?.core?.invoke ?? null;

// ---------- relay connection ----------

class RelayConn {
  constructor(displayUrl, wsUrl) {
    this.displayUrl = displayUrl;
    this.wsUrl = wsUrl;
    this.subs = new Map();
    this.okWaiters = new Map();
    this.subCounter = 0;
    this.dead = false;
    this.onauthchallenge = null; // (challenge) => {}
    this.onstatus = null; // (text) => {}
    this.onclose = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const failTimer = setTimeout(() => { ws.close(); reject(new Error('connection timed out')); }, 15000);
      ws.onopen = () => { clearTimeout(failTimer); resolve(); };
      ws.onerror = () => { clearTimeout(failTimer); reject(new Error('websocket error')); };
      ws.onclose = () => { if (!this.dead) { this.dead = true; this.onclose?.(); } };
      ws.onmessage = (e) => this.handleMessage(e.data);
    });
  }

  handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const [type, a, b, c] = msg;
    if (type === 'AUTH') this.onauthchallenge?.(a);
    else if (type === 'EVENT') this.subs.get(a)?.onevent?.(b);
    else if (type === 'EOSE') this.subs.get(a)?.oneose?.();
    else if (type === 'CLOSED') this.subs.get(a)?.onclosed?.(b);
    else if (type === 'OK') {
      const waiter = this.okWaiters.get(a);
      if (waiter) { this.okWaiters.delete(a); waiter({ ok: b, msg: c || '' }); }
    } else if (type === 'NOTICE') console.warn('[relay notice]', a);
  }

  send(arr) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(arr));
  }

  publish(event, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.okWaiters.delete(event.id);
        resolve({ ok: false, msg: 'timed out waiting for the relay' });
      }, timeoutMs);
      this.okWaiters.set(event.id, (r) => { clearTimeout(timer); resolve(r); });
      this.send(['EVENT', event]);
    });
  }

  req(filters, handlers) {
    const id = 's' + ++this.subCounter;
    this.subs.set(id, handlers);
    this.send(['REQ', id, ...filters]);
    return id;
  }

  closeSub(id) {
    this.subs.delete(id);
    this.send(['CLOSE', id]);
  }

  destroy() {
    this.dead = true;
    this.onclose = null;
    try { this.ws?.close(); } catch {}
  }
}

// ---------- state ----------

let sk = null; // Uint8Array
let pkHex = null;
let servers = JSON.parse(localStorage.getItem('menhir-servers') || '[]');
let activeServer = null; // entry of servers
let conn = null;
let channels = new Map(); // id -> {id, name, about}
let activeChannel = null;
let msgSubId = null;
let profiles = new Map(); // pubkey -> display name
let reconnectTimer = null;

function saveServers() {
  localStorage.setItem('menhir-servers', JSON.stringify(servers));
}

// ---------- login ----------

function tryRestoreIdentity() {
  const stored = localStorage.getItem('menhir-sk-hex');
  if (!stored) return false;
  try {
    sk = hexToBytes(stored);
    pkHex = getPublicKey(sk);
    return true;
  } catch { return false; }
}

function loginWith(input) {
  const trimmed = input.trim();
  let bytes;
  if (trimmed.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'nsec') throw new Error('that is not an nsec key');
    bytes = decoded.data;
  } else if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    bytes = hexToBytes(trimmed.toLowerCase());
  } else {
    throw new Error('paste an nsec1… key or 64 hex characters');
  }
  sk = bytes;
  pkHex = getPublicKey(sk);
  localStorage.setItem('menhir-sk-hex', bytesToHex(sk));
}

function signEvent(kind, tags, content) {
  return finalizeEvent({ kind, tags, content, created_at: Math.floor(Date.now() / 1000) }, sk);
}

// ---------- server connection flow ----------

async function resolveWsUrl(url) {
  if (!url.includes('.onion')) return url;
  if (!tauriInvoke) throw new Error('.onion servers need the Menhir desktop app (it runs Tor for you)');
  return await tauriInvoke('bridge_open', { onionUrl: url });
}

async function selectServer(entry) {
  clearTimeout(reconnectTimer);
  conn?.destroy();
  conn = null;
  activeServer = entry;
  channels = new Map();
  activeChannel = null;
  msgSubId = null;
  renderRail();
  renderChannels();
  clearChat('Connecting…');
  $('server-name').textContent = entry.label || entry.url;
  setServerStatus('connecting…');

  let wsUrl;
  try {
    wsUrl = await resolveWsUrl(entry.url);
  } catch (e) {
    setServerStatus(String(e.message || e), true);
    return;
  }

  const c = new RelayConn(entry.url, wsUrl);
  conn = c;
  let authed = false;
  let authTimer = null;

  const onReady = () => {
    if (authed || conn !== c) return;
    authed = true;
    setServerStatus(isUnprotectedCleartext(entry.url) ? 'online — unencrypted (ws://)' : 'online');
    openMetaSubscriptions(c);
  };

  c.onauthchallenge = async (challenge) => {
    clearTimeout(authTimer);
    if (conn !== c) return;
    setServerStatus('authenticating…');
    const authEvent = signEvent(22242, [['relay', entry.url], ['challenge', challenge]], '');
    c.send(['AUTH', authEvent]);
    const result = await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, msg: 'auth timed out' }), 10000);
      c.okWaiters.set(authEvent.id, (r) => { clearTimeout(t); resolve(r); });
    });
    if (result.ok) return onReady();
    if (entry.invite) {
      setServerStatus('redeeming invite…');
      const redeem = signEvent(20284, [], entry.invite);
      const r = await c.publish(redeem);
      if (r.ok) {
        entry.invite = null; // consumed — whitelisting persists on the relay
        saveServers();
        return onReady();
      }
      setServerStatus('invite rejected: ' + r.msg, true);
      return;
    }
    setServerStatus('access denied: ' + result.msg, true);
  };

  c.onclose = () => {
    if (conn !== c) return;
    setServerStatus('disconnected — retrying in 4s', true);
    reconnectTimer = setTimeout(() => { if (activeServer === entry) selectServer(entry); }, 4000);
  };

  try {
    await c.connect();
  } catch (e) {
    if (conn === c) {
      setServerStatus('unreachable: ' + (e.message || e), true);
      reconnectTimer = setTimeout(() => { if (activeServer === entry) selectServer(entry); }, 6000);
    }
    return;
  }
  // Open relays send no AUTH challenge — proceed after a short grace period.
  authTimer = setTimeout(onReady, 1200);
}

function openMetaSubscriptions(c) {
  c.req([{ kinds: [39000], limit: 500 }], {
    onevent: (ev) => {
      const id = ev.tags.find((t) => t[0] === 'd')?.[1];
      if (!id) return;
      const name = ev.tags.find((t) => t[0] === 'name')?.[1] || id;
      const about = ev.tags.find((t) => t[0] === 'about')?.[1] || '';
      channels.set(id, { id, name, about });
      renderChannels();
    },
    oneose: () => {
      renderChannels();
      if (!activeChannel && channels.size > 0) selectChannel([...channels.keys()][0]);
    },
  });
  c.req([{ kinds: [0], limit: 500 }], {
    onevent: (ev) => {
      try {
        const meta = JSON.parse(ev.content);
        const name = meta.display_name || meta.name;
        if (name) profiles.set(ev.pubkey, name);
        renderMessagesAuthors();
      } catch {}
    },
  });
}

// ---------- channels & messages ----------

/// True for a plain-ws server that is neither loopback nor an onion address —
/// i.e. one whose traffic crosses a network in the clear.
function isUnprotectedCleartext(url) {
  if (!url.startsWith('ws://')) return false;
  const host = url.slice(5).split('/')[0].split(':')[0];
  if (host.endsWith('.onion')) return false; // Tor encrypts end to end
  return !['127.0.0.1', 'localhost', '::1'].includes(host);
}

function selectChannel(id) {
  if (!conn) return;
  if (msgSubId) conn.closeSub(msgSubId);
  activeChannel = id;
  renderChannels();
  const meta = channels.get(id);
  $('chat-title').textContent = '#' + (meta?.name || id);
  clearChat();
  show($('composer'));
  if (window.innerWidth <= 720) $('channel-pane').classList.add('collapsed');

  const seen = new Set();
  let eosed = false;
  const buffer = [];
  msgSubId = conn.req([{ kinds: [9], '#h': [id], limit: 100 }], {
    onevent: (ev) => {
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
      if (!eosed) buffer.push(ev);
      else appendMessage(ev, true);
    },
    oneose: () => {
      eosed = true;
      buffer.sort((a, b) => a.created_at - b.created_at);
      for (const ev of buffer) appendMessage(ev, false);
      scrollChat();
    },
    onclosed: (msg) => setServerStatus('subscription closed: ' + msg, true),
  });
}

function clearChat(placeholder) {
  const box = $('messages');
  box.innerHTML = '';
  if (placeholder) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.textContent = placeholder;
    box.appendChild(div);
  }
}

function appendMessage(ev, scroll) {
  const box = $('messages');
  const div = document.createElement('div');
  div.className = 'msg';
  div.dataset.pubkey = ev.pubkey;

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtTime(ev.created_at);

  const author = document.createElement('span');
  author.className = 'author';
  author.textContent = profiles.get(ev.pubkey) || shortNpub(ev.pubkey);

  const body = document.createElement('span');
  body.className = 'body';
  body.textContent = ev.content; // plain text only — no markup, no media

  div.append(time, author, body);
  box.appendChild(div);
  if (scroll) scrollChat();
}

function renderMessagesAuthors() {
  for (const div of document.querySelectorAll('#messages .msg[data-pubkey]')) {
    const name = profiles.get(div.dataset.pubkey);
    if (name) div.querySelector('.author').textContent = name;
  }
}

function scrollChat() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

async function sendMessage() {
  const input = $('composer-input');
  const text = input.value.trim();
  if (!text || !conn || !activeChannel) return;
  const ev = signEvent(9, [['h', activeChannel]], text);
  input.value = '';
  const { ok, msg } = await conn.publish(ev);
  if (!ok) {
    setServerStatus('send failed: ' + msg, true);
    input.value = text;
  }
}

// ---------- rendering ----------

function setServerStatus(text, isError) {
  const el = $('server-status');
  el.textContent = text;
  el.style.color = isError ? 'var(--lc-red)' : '';
}

function renderRail() {
  const list = $('server-list');
  list.innerHTML = '';
  for (const entry of servers) {
    const btn = document.createElement('button');
    btn.className = 'server-icon' + (entry === activeServer ? ' active' : '');
    btn.textContent = (entry.label || entry.url.replace(/^wss?:\/\//, ''))[0].toUpperCase();
    btn.title = entry.label ? `${entry.label}\n${entry.url}` : entry.url;
    btn.onclick = () => selectServer(entry);
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      if (confirm(`Remove server ${entry.label || entry.url}?`)) {
        servers = servers.filter((s) => s !== entry);
        saveServers();
        if (activeServer === entry) { conn?.destroy(); conn = null; activeServer = null; clearChat(); }
        renderRail();
      }
    };
    list.appendChild(btn);
  }
}

function renderChannels() {
  const list = $('channel-list');
  list.innerHTML = '';
  const sorted = [...channels.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const ch of sorted) {
    const div = document.createElement('div');
    div.className = 'channel-item' + (ch.id === activeChannel ? ' active' : '');
    div.textContent = '#' + ch.name;
    div.title = ch.about || ch.id;
    div.onclick = () => selectChannel(ch.id);
    list.appendChild(div);
  }
  $('create-channel-btn').classList.toggle('hidden', !conn);
}

// ---------- add server ----------

function parseServerInput(raw) {
  const input = raw.trim();
  if (input.startsWith('obelisk://join') || input.includes('/join?')) {
    const query = input.split('?')[1] || '';
    const params = new URLSearchParams(query);
    const relay = params.get('relay');
    if (!relay) throw new Error('the link has no relay parameter');
    return { url: relay, invite: params.get('invite') || null };
  }
  if (input.startsWith('ws://') || input.startsWith('wss://')) return { url: input, invite: null };
  throw new Error('paste a ws:// or wss:// relay URL, or an obelisk://join link');
}

function addServer(url, invite) {
  let entry = servers.find((s) => s.url === url);
  if (!entry) {
    const label = url.replace(/^wss?:\/\//, '').split('/')[0].split(':')[0];
    entry = { url, label: label.length > 20 ? label.slice(0, 12) + '…' : label, invite };
    servers.push(entry);
    saveServers();
  } else if (invite) {
    entry.invite = invite;
    saveServers();
  }
  renderRail();
  selectServer(entry);
}

// ---------- hosting (desktop only) ----------

let hostPollTimer = null;

async function refreshHostPanel() {
  if (!tauriInvoke) return;
  try {
    const st = await tauriInvoke('host_status');
    $('host-tor-warning').classList.toggle('hidden', st.tor_available);
    if (st.running) {
      hide($('host-stopped'));
      show($('host-running'));
      $('host-state').textContent = st.tor_state;
      $('host-local-url').textContent = st.relay_url || '—';
      $('host-onion').textContent = st.onion ? 'ws://' + st.onion : '(no Tor — local only)';
      $('host-share').textContent = st.share_link || st.relay_url || '—';
      const wl = $('host-wl-list');
      wl.innerHTML = '';
      for (const npub of st.whitelist) {
        const row = document.createElement('div');
        row.className = 'wl-item';
        const code = document.createElement('code');
        code.textContent = npub;
        const del = document.createElement('button');
        del.textContent = 'remove';
        del.onclick = async () => { await tauriInvoke('host_whitelist_remove', { pubkey: npub }); refreshHostPanel(); };
        row.append(code, del);
        wl.appendChild(row);
      }
    } else {
      show($('host-stopped'));
      hide($('host-running'));
    }
  } catch (e) {
    hostError(e);
  }
}

function hostError(e) {
  const el = $('host-error');
  el.textContent = String(e?.message || e || '');
  el.classList.toggle('hidden', !e);
}

// ---------- boot ----------

function enterApp() {
  hide($('login-screen'));
  show($('app-screen'));
  $('me-name').textContent = 'me';
  $('me-npub').textContent = shortNpub(pkHex);
  renderRail();
  renderChannels();
  clearChat(servers.length ? 'Pick a server on the left.' : 'Add a server with the + button, or host your own.');
  if (tauriInvoke) {
    tauriInvoke('host_status')
      .then((st) => { if (st.supported) show($('host-btn')); })
      .catch(() => {});
  }
  if (servers.length) selectServer(servers[0]);
}

function boot() {
  // login screen
  $('login-btn').onclick = () => {
    try {
      loginWith($('login-nsec').value);
      enterApp();
    } catch (e) {
      $('login-error').textContent = String(e.message || e);
      show($('login-error'));
    }
  };
  $('generate-btn').onclick = () => {
    const secret = generateSecretKey();
    $('generated-nsec').textContent = nip19.nsecEncode(secret);
    $('generated-nsec').dataset.hex = bytesToHex(secret);
    show($('generated-box'));
  };
  $('use-generated-btn').onclick = () => {
    loginWith($('generated-nsec').dataset.hex);
    enterApp();
  };
  $('logout-btn').onclick = () => {
    if (!confirm('Log out? Make sure your nsec is backed up — it is removed from this device.')) return;
    localStorage.removeItem('menhir-sk-hex');
    location.reload();
  };

  // modals
  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.onclick = () => hide($(btn.dataset.close));
  }
  $('add-server-btn').onclick = () => { hide($('add-server-error')); show($('add-server-modal')); $('add-server-input').focus(); };
  $('add-server-confirm').onclick = () => {
    try {
      const { url, invite } = parseServerInput($('add-server-input').value);
      hide($('add-server-modal'));
      $('add-server-input').value = '';
      addServer(url, invite);
    } catch (e) {
      $('add-server-error').textContent = String(e.message || e);
      show($('add-server-error'));
    }
  };

  $('create-channel-btn').onclick = () => { hide($('cc-error')); show($('create-channel-modal')); $('cc-id').focus(); };
  $('cc-confirm').onclick = async () => {
    const id = $('cc-id').value.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,64}$/.test(id)) {
      $('cc-error').textContent = 'id must be 1-64 chars of a-z 0-9 - _';
      show($('cc-error'));
      return;
    }
    const tags = [['h', id]];
    if ($('cc-name').value.trim()) tags.push(['name', $('cc-name').value.trim()]);
    if ($('cc-about').value.trim()) tags.push(['about', $('cc-about').value.trim()]);
    const { ok, msg } = await conn.publish(signEvent(9007, tags, ''));
    if (!ok) {
      $('cc-error').textContent = msg;
      show($('cc-error'));
      return;
    }
    hide($('create-channel-modal'));
    $('cc-id').value = $('cc-name').value = $('cc-about').value = '';
    setTimeout(() => selectChannel(id), 300);
  };

  // composer
  $('send-btn').onclick = sendMessage;
  $('composer-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // phone back button
  const back = document.createElement('button');
  back.className = 'back-btn';
  back.textContent = '‹';
  back.onclick = () => $('channel-pane').classList.remove('collapsed');
  $('chat-header').prepend(back);

  // hosting
  $('host-btn').onclick = () => { hostError(null); show($('host-modal')); refreshHostPanel(); clearInterval(hostPollTimer); hostPollTimer = setInterval(refreshHostPanel, 3000); };
  document.querySelector('#host-modal [data-close]').addEventListener('click', () => clearInterval(hostPollTimer));
  $('host-start-btn').onclick = async () => {
    hostError(null);
    $('host-start-btn').disabled = true;
    $('host-start-btn').textContent = 'Starting… (Tor bootstrap can take a minute)';
    try {
      await tauriInvoke('host_start', {
        name: $('host-name').value.trim() || 'My Menhir',
        operatorNpub: nip19.npubEncode(pkHex),
        useTor: $('host-use-tor').checked,
      });
      await refreshHostPanel();
    } catch (e) {
      hostError(e);
    } finally {
      $('host-start-btn').disabled = false;
      $('host-start-btn').textContent = 'Start hosting';
    }
  };
  $('host-stop-btn').onclick = async () => {
    try { await tauriInvoke('host_stop'); await refreshHostPanel(); } catch (e) { hostError(e); }
  };
  $('host-open-local').onclick = async () => {
    try {
      const st = await tauriInvoke('host_status');
      if (st.relay_url) {
        clearInterval(hostPollTimer);
        hide($('host-modal'));
        addServer(st.relay_url, null);
      }
    } catch (e) { hostError(e); }
  };
  $('host-invite-btn').onclick = async () => {
    try {
      const inv = await tauriInvoke('host_invite_create', { maxUses: 1, expiresHours: null });
      $('host-invite-out').textContent = inv.share_link || inv.code;
    } catch (e) { hostError(e); }
  };
  $('host-copy-share').onclick = () => {
    const text = $('host-share').textContent;
    navigator.clipboard?.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    });
  };
  $('host-wl-add').onclick = async () => {
    try {
      await tauriInvoke('host_whitelist_add', { pubkey: $('host-wl-input').value.trim() });
      $('host-wl-input').value = '';
      refreshHostPanel();
    } catch (e) { hostError(e); }
  };

  // start
  if (tryRestoreIdentity()) enterApp();
  else show($('login-screen'));
}

boot();
