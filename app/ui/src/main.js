// Obelisk Menhir — Nostr text-channel client.
// Transport: raw NIP-01 websocket. Signing: nsec / NIP-07 / NIP-46 (signer.js).
// History is cached locally (store.js) so a dropped connection — or a cold Tor
// circuit — never leaves the user staring at an empty channel.

import * as nip19 from 'nostr-tools/nip19';
import { NsecSigner, Nip07Signer, RemoteSigner, restoreSigner } from './signer.js';
import { renderQR, startScanner } from './qr.js';
import * as store from './store.js';
import * as notify from './notify.js';
import { APP_VERSION } from './version.js';

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');
const setText = (el, t) => { el.textContent = t; };

const NOSTR_CONNECT_RELAYS = ['wss://relay.nsec.app', 'wss://relay.damus.io', 'wss://nos.lol'];

const KIND = {
  PROFILE: 0,
  CHAT: 9,
  PUT_USER: 9000,
  REMOVE_USER: 9001,
  EDIT_METADATA: 9002,
  CREATE_GROUP: 9007,
  DELETE_GROUP: 9008,
  AUTH: 22242,
  INVITE_REDEEM: 20284,
  META: 39000,
  ADMINS: 39001,
  MEMBERS: 39002,
};

function shortNpub(pkHex) {
  const npub = nip19.npubEncode(pkHex);
  return npub.slice(0, 10) + '…' + npub.slice(-4);
}

const fmtTime = (ts) =>
  new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function flash(btn, label = 'Copied') {
  const original = btn.textContent;
  btn.textContent = label;
  setTimeout(() => { btn.textContent = original; }, 1200);
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
    this.onauthchallenge = null;
    this.onclose = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      // The socket to the bridge opens instantly, but the bridge then builds a
      // Tor circuit to the onion behind it — a cold one can take the better
      // part of a minute. Timing out at 20s there just restarts the wait.
      const budget = this.displayUrl.includes('.onion') ? 120000 : 20000;
      const failTimer = setTimeout(() => {
        ws.close();
        reject(new Error('connection timed out'));
      }, budget);
      ws.onopen = () => { clearTimeout(failTimer); resolve(); };
      ws.onerror = () => { clearTimeout(failTimer); reject(new Error('could not reach the relay')); };
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
    } else if (type === 'NOTICE') console.warn('[relay]', a);
  }

  send(arr) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(arr));
  }

  waitForOk(eventId, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.okWaiters.delete(eventId);
        resolve({ ok: false, msg: 'timed out waiting for the relay' });
      }, timeoutMs);
      this.okWaiters.set(eventId, (r) => { clearTimeout(timer); resolve(r); });
    });
  }

  publish(event, timeoutMs = 20000) {
    const waiter = this.waitForOk(event.id, timeoutMs);
    this.send(['EVENT', event]);
    return waiter;
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

let signer = null;
let servers = JSON.parse(localStorage.getItem('menhir-servers') || '[]');
let activeServer = null;
let conn = null;
let channels = new Map();
let activeChannel = null;
let msgSubId = null;
let profiles = new Map();
let myProfile = { name: '', about: '' };
let ncSession = null;
let stopScanner = null;

/** channelId -> array of events, newest last. Seeded from the local cache. */
let messages = new Map();
/** channelId -> Set(pubkey) of admins, from the relay-signed 39001. */
let channelAdmins = new Map();
/** channelId -> [{pubkey, role}], from 39002 + 39001. */
let channelMembers = new Map();
/** channelId -> unix seconds of the newest message the reader has seen. */
let readState = {};
/** True once a channel's backfill has finished, so history is not "new". */
let liveChannels = new Set();

let reconnectTimer = null;
let reconnectAttempt = 0;
let countdownTimer = null;

const saveServers = () => localStorage.setItem('menhir-servers', JSON.stringify(servers));

function persistSigner() {
  const blob = signer?.persist?.();
  if (blob) localStorage.setItem('menhir-signer', JSON.stringify(blob));
  else localStorage.removeItem('menhir-signer');
}

// ---------- connection ----------

async function resolveWsUrl(url) {
  if (!url.includes('.onion')) return url;
  if (!tauriInvoke) {
    throw new Error('.onion servers need the Menhir app — a browser cannot reach Tor on its own');
  }
  // The Rust side bridges onion → loopback: a managed Tor on desktop, an
  // embedded arti on mobile. Either way the first connect builds a circuit,
  // which is slow enough to be worth saying out loud.
  setServerStatus('connecting through Tor — the first time takes a minute…');
  return await tauriInvoke('bridge_open', { onionUrl: url });
}

function isUnprotectedCleartext(url) {
  if (!url.startsWith('ws://')) return false;
  const host = url.slice(5).split('/')[0].split(':')[0];
  if (host.endsWith('.onion')) return false; // Tor encrypts end to end
  return !['127.0.0.1', 'localhost', '::1'].includes(host);
}

function setServerStatus(text, isError) {
  const el = $('server-status');
  el.textContent = text;
  el.style.color = isError ? 'var(--lc-red)' : '';
}

/** Back off after repeated failures instead of hammering a server that is down. */
function scheduleReconnect(entry) {
  clearTimeout(reconnectTimer);
  clearInterval(countdownTimer);
  reconnectAttempt += 1;
  const base = Math.min(30000, 1500 * 2 ** (reconnectAttempt - 1));
  const delay = Math.round(base * (0.75 + Math.random() * 0.5)); // jitter
  let left = Math.ceil(delay / 1000);
  const tick = () => {
    setServerStatus(`offline — reconnecting in ${left}s`, true);
    left -= 1;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
  reconnectTimer = setTimeout(() => {
    clearInterval(countdownTimer);
    if (activeServer === entry) connectTo(entry, true);
  }, delay);
}

/**
 * Connect (or reconnect) to a server.
 *
 * On a reconnect the UI is deliberately left alone: channels and messages stay
 * on screen from the cache, and subscriptions resume from the newest event we
 * already hold rather than refetching everything.
 */
async function connectTo(entry, isReconnect = false) {
  clearTimeout(reconnectTimer);
  clearInterval(countdownTimer);
  conn?.destroy();
  conn = null;

  if (!isReconnect) {
    reconnectAttempt = 0;
    // Paint from cache first so there is something to look at immediately.
    channels = new Map(store.loadChannels(entry.url).map((c) => [c.id, c]));
    profiles = new Map(Object.entries(store.loadProfiles(entry.url)));
    readState = store.loadReadState(entry.url);
    liveChannels = new Set();
    messages = new Map();
    channelAdmins = new Map();
    channelMembers = new Map();
    activeChannel = null;
    msgSubId = null;
    renderRail();
    renderChannels();
    setText($('server-name'), entry.label || entry.url);
    show($('server-qr-btn'));
    show($('server-settings-btn'));
    clearChat(channels.size ? 'Pick a channel.' : 'Connecting…');
    if (isMobile()) showPane('channels');
  }
  setServerStatus(isReconnect ? 'reconnecting…' : 'connecting…');

  let wsUrl;
  try {
    wsUrl = await resolveWsUrl(entry.url);
  } catch (e) {
    setServerStatus(String(e.message || e), true);
    scheduleReconnect(entry);
    return;
  }

  const c = new RelayConn(entry.url, wsUrl);
  conn = c;
  let ready = false;
  let graceTimer = null;

  const onReady = () => {
    if (ready || conn !== c) return;
    ready = true;
    reconnectAttempt = 0;
    setServerStatus(isUnprotectedCleartext(entry.url) ? 'online — unencrypted (ws://)' : 'online');
    openMetaSubscriptions(c);
    if (activeChannel) subscribeChannel(activeChannel);
    maybeAdoptRelayName(entry, wsUrl);
    // Asked here rather than at launch: a permission prompt before you have
    // even joined a server is a prompt with no context, and gets denied.
    notify.ensurePermission();
  };

  c.onauthchallenge = async (challenge) => {
    clearTimeout(graceTimer);
    if (conn !== c) return;
    try {
      setServerStatus('authenticating…');
      // The relay tag must name the endpoint actually dialled: the relay
      // compares it against the connection's Host header so a signed auth
      // event cannot be replayed against a different relay.
      const authEvent = await signer.sign({
        kind: KIND.AUTH,
        tags: [['relay', wsUrl], ['challenge', challenge]],
        content: '',
      });
      const waiter = c.waitForOk(authEvent.id);
      c.send(['AUTH', authEvent]);
      const result = await waiter;
      if (result.ok) return onReady();

      if (entry.invite) {
        setServerStatus('redeeming invite…');
        const redeem = await signer.sign({
          kind: KIND.INVITE_REDEEM,
          tags: [],
          content: entry.invite,
        });
        const r = await c.publish(redeem);
        if (r.ok) {
          entry.invite = null; // consumed — the whitelisting persists on the relay
          saveServers();
          return onReady();
        }
        setServerStatus('invite rejected: ' + r.msg, true);
        clearChat('This invite was rejected: ' + r.msg);
        return;
      }
      setServerStatus('access denied: ' + result.msg, true);
      clearChat('This server did not let you in: ' + result.msg + '\n\nAsk the operator for an invite link.');
    } catch (e) {
      setServerStatus('sign failed: ' + (e.message || e), true);
    }
  };

  c.onclose = () => {
    if (conn !== c) return;
    scheduleReconnect(entry);
  };

  try {
    await c.connect();
  } catch (e) {
    if (conn === c) {
      setServerStatus('unreachable: ' + (e.message || e), true);
      scheduleReconnect(entry);
    }
    return;
  }
  // Open relays send no AUTH challenge — proceed after a short grace period.
  graceTimer = setTimeout(onReady, 1500);
}

const selectServer = (entry) => {
  activeServer = entry;
  connectTo(entry, false);
};

/**
 * Ask the relay what it calls itself (NIP-11) and adopt that name, unless the
 * user has set their own. Best-effort: a relay that does not answer just keeps
 * whatever label it already had.
 */
async function maybeAdoptRelayName(entry, wsUrl) {
  if (entry.custom) return;
  try {
    const httpUrl = wsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    const res = await fetch(httpUrl, {
      headers: { Accept: 'application/nostr+json' },
      signal: AbortSignal.timeout(15000),
    });
    const info = await res.json();
    const name = (info?.name || '').trim();
    if (name && name !== entry.label) {
      entry.label = name.slice(0, 40);
      saveServers();
      renderRail();
      if (activeServer === entry) setText($('server-name'), entry.label);
    }
  } catch {
    // NIP-11 is a nicety, not a requirement.
  }
}

function openMetaSubscriptions(c) {
  c.req([{ kinds: [KIND.META], limit: 500 }], {
    onevent: (ev) => {
      const id = ev.tags.find((t) => t[0] === 'd')?.[1];
      if (!id) return;
      channels.set(id, {
        id,
        name: ev.tags.find((t) => t[0] === 'name')?.[1] || id,
        about: ev.tags.find((t) => t[0] === 'about')?.[1] || '',
      });
      renderChannels();
    },
    oneose: () => {
      store.saveChannels(activeServer.url, [...channels.values()]);
      renderChannels();
      if (channels.size === 0) {
        clearChat('No channels here yet.\n\nCreate the first one with “+ new channel”.');
      } else if (!activeChannel && !isMobile()) {
        selectChannel([...channels.keys()][0]);
      } else if (!activeChannel) {
        clearChat('Pick a channel.');
      }
    },
  });

  // Who may administer what — drives the channel settings button.
  c.req([{ kinds: [KIND.ADMINS, KIND.MEMBERS], limit: 500 }], {
    onevent: (ev) => {
      const id = ev.tags.find((t) => t[0] === 'd')?.[1];
      if (!id) return;
      const people = ev.tags.filter((t) => t[0] === 'p');
      if (ev.kind === KIND.ADMINS) {
        channelAdmins.set(id, new Set(people.map((t) => t[1])));
      } else {
        channelMembers.set(id, people.map((t) => ({ pubkey: t[1], role: t[2] || 'member' })));
      }
      if (id === activeChannel) refreshAdminAffordance();
    },
  });

  c.req([{ kinds: [KIND.PROFILE], limit: 500 }], {
    onevent: (ev) => {
      try {
        const meta = JSON.parse(ev.content);
        const name = meta.display_name || meta.name;
        if (!name) return;
        profiles.set(ev.pubkey, name);
        if (ev.pubkey === signer.pubkey) {
          myProfile = { name, about: meta.about || '' };
          setText($('me-name'), name);
        }
        renderMessageAuthors();
      } catch {}
    },
    oneose: () => store.saveProfiles(activeServer.url, Object.fromEntries(profiles)),
  });
}

// ---------- channels & messages ----------

/** Unread count for a channel, from the local read mark. */
function unreadCount(id) {
  return store.unreadIn(messages.get(id) || [], readState[id] || 0, signer?.pubkey);
}

/** Total unread across a server, for the rail badge. */
function unreadForServer() {
  let n = 0;
  for (const id of channels.keys()) n += unreadCount(id);
  return n;
}

/**
 * Mark a channel read up to its newest message.
 *
 * Only counts when the window is actually focused — marking read while the
 * app sits in the background behind another window would quietly swallow
 * everything that arrived.
 */
function markRead(id, force = false) {
  if (!id || !activeServer) return;
  if (!force && document.visibilityState !== 'visible') return;
  const list = messages.get(id) || [];
  if (!list.length) return;
  const newest = list[list.length - 1].created_at;
  if ((readState[id] || 0) >= newest) return;
  readState[id] = newest;
  store.saveReadState(activeServer.url, readState);
  renderChannels();
  renderRail();
}

function isAdminOf(channelId) {
  return !!signer && !!channelAdmins.get(channelId)?.has(signer.pubkey);
}

function refreshAdminAffordance() {
  $('channel-admin-btn').classList.toggle('hidden', !activeChannel || !isAdminOf(activeChannel));
}

function selectChannel(id) {
  activeChannel = id;
  renderChannels();
  setText($('chat-title'), '#' + (channels.get(id)?.name || id));
  show($('composer'));
  refreshAdminAffordance();
  if (isMobile()) showPane('chat');

  // Cache first: the channel is readable before the relay says anything.
  if (!messages.has(id)) messages.set(id, store.loadMessages(activeServer.url, id));
  renderMessages(id);
  markRead(id);

  if (conn) subscribeChannel(id);
}

/** (Re)subscribe to a channel, resuming from the newest event already held. */
function subscribeChannel(id) {
  if (msgSubId) conn.closeSub(msgSubId);
  const cached = messages.get(id) || [];
  const since = store.resumeSince(cached);
  const filter = { kinds: [KIND.CHAT], '#h': [id], limit: 200 };
  if (since !== undefined) filter.since = since;

  let batch = [];
  msgSubId = conn.req([filter], {
    onevent: (ev) => batch.push(ev),
    oneose: () => {
      ingest(id, batch);
      batch = [];
      // Everything after EOSE is live: render as it lands, and only from here
      // is a message worth a notification — backfilled history is not news.
      liveChannels.add(id);
      conn.subs.get(msgSubId).onevent = (ev) => ingest(id, [ev]);
    },
    onclosed: (msg) => setServerStatus('subscription closed: ' + msg, true),
  });
}

/** Merge events into a channel, persist, and repaint if it is on screen. */
function ingest(channelId, incoming) {
  if (!incoming.length) return;
  const before = messages.get(channelId) || [];
  const merged = store.mergeMessages(before, incoming);
  if (merged.length === before.length) return; // nothing new
  messages.set(channelId, merged);
  store.saveMessages(activeServer.url, channelId, merged);

  const focused = document.visibilityState === 'visible';
  const looking = channelId === activeChannel && focused;
  if (looking) {
    renderMessages(channelId);
    markRead(channelId);
  } else if (liveChannels.has(channelId)) {
    announce(channelId, incoming);
  }
  renderChannels();
  renderRail();
}

/** Tell the reader about messages they are not currently looking at. */
function announce(channelId, incoming) {
  if (!notify.canNotify()) return;
  const fresh = incoming.filter(
    (ev) => ev.pubkey !== signer?.pubkey && ev.created_at > (readState[channelId] || 0),
  );
  if (!fresh.length) return;
  const ev = fresh[fresh.length - 1];
  const who = profiles.get(ev.pubkey) || shortNpub(ev.pubkey);
  const where = channels.get(channelId)?.name || channelId;
  const server = activeServer?.label ? ` · ${activeServer.label}` : '';
  const title = fresh.length > 1
    ? `${fresh.length} new in #${where}${server}`
    : `${who} in #${where}${server}`;
  notify.notify(title, ev.content.slice(0, 180));
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

function renderMessages(channelId) {
  const box = $('messages');
  const list = messages.get(channelId) || [];
  // Only auto-scroll when already near the bottom, so reading history is not
  // yanked away every time a message arrives.
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;

  box.innerHTML = '';
  if (!list.length) {
    clearChat('No messages yet — say something.');
    return;
  }
  for (const ev of list) box.appendChild(renderMessage(ev));
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function renderMessage(ev) {
  const div = document.createElement('div');
  div.className = 'msg' + (ev.pubkey === signer?.pubkey ? ' mine' : '');
  div.dataset.pubkey = ev.pubkey;

  const head = document.createElement('div');
  head.className = 'msg-head';
  const author = document.createElement('span');
  author.className = 'author';
  author.textContent = profiles.get(ev.pubkey) || shortNpub(ev.pubkey);
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtTime(ev.created_at);
  head.append(author, time);

  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = ev.content; // plain text only — never innerHTML

  div.append(head, body);
  return div;
}

function renderMessageAuthors() {
  for (const div of document.querySelectorAll('#messages .msg[data-pubkey]')) {
    const name = profiles.get(div.dataset.pubkey);
    if (name) setText(div.querySelector('.author'), name);
  }
}

async function sendMessage() {
  const input = $('composer-input');
  const text = input.value.trim();
  if (!text || !activeChannel) return;
  if (!conn || conn.dead) {
    setServerStatus('not connected — message kept in the box', true);
    return;
  }
  input.value = '';
  input.style.height = 'auto';
  try {
    const ev = await signer.sign({ kind: KIND.CHAT, tags: [['h', activeChannel]], content: text });
    const { ok, msg } = await conn.publish(ev);
    if (!ok) {
      setServerStatus('send failed: ' + msg, true);
      input.value = text;
      return;
    }
    // Show it immediately rather than waiting for the echo.
    ingest(activeChannel, [ev]);
  } catch (e) {
    setServerStatus('could not sign: ' + (e.message || e), true);
    input.value = text;
  }
}

// ---------- rendering ----------

function renderRail() {
  const list = $('server-list');
  list.innerHTML = '';
  for (const entry of servers) {
    const btn = document.createElement('button');
    btn.className = 'server-icon' + (entry === activeServer ? ' active' : '');
    const label = entry.label || entry.url.replace(/^wss?:\/\//, '');
    btn.textContent = label[0].toUpperCase();
    btn.title = `${label}\n${entry.url}`;
    if (entry === activeServer && unreadForServer() > 0) btn.classList.add('has-unread');
    btn.onclick = () => selectServer(entry);
    btn.oncontextmenu = (e) => { e.preventDefault(); openServerSettings(entry); };
    list.appendChild(btn);
  }
}

function renderChannels() {
  const list = $('channel-list');
  list.innerHTML = '';
  for (const ch of [...channels.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const div = document.createElement('div');
    const n = unreadCount(ch.id);
    div.className =
      'channel-item' + (ch.id === activeChannel ? ' active' : '') + (n ? ' unread' : '');
    const label = document.createElement('span');
    label.className = 'channel-label';
    label.textContent = '#' + ch.name;
    div.appendChild(label);
    if (n) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = n > 99 ? '99+' : String(n);
      div.appendChild(badge);
    }
    div.title = ch.about || ch.id;
    div.onclick = () => selectChannel(ch.id);
    list.appendChild(div);
  }
  // Anyone the server admits may open a channel — not just the operator.
  $('create-channel-btn').classList.toggle('hidden', !conn);
}

// ---------- mobile panes ----------

const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
const showPane = (which) => document.body.classList.toggle('show-chat', which === 'chat');

// ---------- servers ----------

function parseServerInput(raw) {
  const input = (raw || '').trim();
  if (input.startsWith('obelisk://join') || input.includes('/join?')) {
    const params = new URLSearchParams(input.split('?')[1] || '');
    const relay = params.get('relay');
    if (!relay) throw new Error('that link has no relay in it');
    return { url: relay, invite: params.get('invite') || null };
  }
  if (input.startsWith('ws://') || input.startsWith('wss://')) return { url: input, invite: null };
  throw new Error('paste a ws:// or wss:// URL, or an obelisk://join link');
}

function defaultLabel(url) {
  const host = url.replace(/^wss?:\/\//, '').split('/')[0].split(':')[0];
  // An onion address makes a meaningless label; say so rather than showing
  // sixteen random characters, until the relay tells us its real name.
  if (host.endsWith('.onion')) return 'Onion server';
  return host.length > 18 ? host.slice(0, 16) + '…' : host;
}

function addServer(url, invite, name) {
  let entry = servers.find((s) => s.url === url);
  if (!entry) {
    entry = {
      url,
      label: (name || '').trim() || defaultLabel(url),
      invite,
      custom: !!(name || '').trim(),
    };
    servers.push(entry);
    saveServers();
  } else {
    if (invite) entry.invite = invite;
    if ((name || '').trim()) {
      entry.label = name.trim();
      entry.custom = true;
    }
    saveServers();
  }
  renderRail();
  selectServer(entry);
}

function openServerSettings(entry) {
  const target = entry || activeServer;
  if (!target) return;
  hide($('server-settings-error'));
  $('server-rename').value = target.custom ? target.label : '';
  $('server-rename').placeholder = target.label || 'Server name';
  setText($('server-address'), target.url);
  $('server-settings-modal').dataset.url = target.url;
  show($('server-settings-modal'));
  $('server-rename').focus();
}

function saveServerName() {
  const url = $('server-settings-modal').dataset.url;
  const entry = servers.find((s) => s.url === url);
  if (!entry) return;
  const name = $('server-rename').value.trim();
  if (name) {
    entry.label = name.slice(0, 40);
    entry.custom = true;
  } else {
    // Cleared: fall back to whatever the relay calls itself.
    entry.custom = false;
    entry.label = defaultLabel(entry.url);
    if (conn && activeServer === entry) maybeAdoptRelayName(entry, conn.wsUrl);
  }
  saveServers();
  renderRail();
  if (activeServer === entry) setText($('server-name'), entry.label);
  hide($('server-settings-modal'));
}

function removeServer() {
  const url = $('server-settings-modal').dataset.url;
  const entry = servers.find((s) => s.url === url);
  if (!entry) return;
  if (!confirm(`Remove ${entry.label}? Cached messages for it are deleted too.`)) return;
  servers = servers.filter((s) => s !== entry);
  saveServers();
  store.forgetServer(entry.url);
  hide($('server-settings-modal'));
  if (activeServer === entry) {
    clearTimeout(reconnectTimer);
    clearInterval(countdownTimer);
    conn?.destroy();
    conn = null;
    activeServer = null;
    channels = new Map();
    messages = new Map();
    activeChannel = null;
    renderChannels();
    clearChat('Pick a server, or add one with +.');
    setText($('server-name'), '—');
    setServerStatus('not connected');
    hide($('server-qr-btn'));
    hide($('server-settings-btn'));
  }
  renderRail();
}

// ---------- QR ----------

let currentQrText = '';

async function showQR(title, text) {
  currentQrText = text;
  hide($('qr-note'));
  setText($('qr-title'), title);
  setText($('qr-text'), text);
  show($('qr-modal'));
  try {
    await renderQR($('share-qr'), text, 240);
  } catch (e) {
    setText($('qr-text'), 'Could not render a QR: ' + (e.message || e));
  }
}

const isLoopback = (url) =>
  /^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);

/**
 * Share the active server as a QR.
 *
 * A loopback address is meaningless to anyone else, so when this is our own
 * hosted relay we substitute the onion address it is published under. If there
 * is no onion, say plainly that the link goes nowhere rather than handing over
 * a QR for 127.0.0.1.
 */
async function shareActiveServer() {
  if (!activeServer) return;
  let url = activeServer.url;

  if (isLoopback(url) && tauriInvoke) {
    try {
      const st = await tauriInvoke('host_status');
      if (st.onion) url = 'ws://' + st.onion;
    } catch {}
  }

  if (isLoopback(url)) {
    setText($('qr-title'), 'This server is local only');
    setText($('qr-text'), url);
    show($('qr-modal'));
    currentQrText = url;
    setText(
      $('qr-note'),
      'This address only works on this computer, so a QR of it is no use to anyone else. Start hosting with Tor to get a shareable onion address.',
    );
    show($('qr-note'));
    try { await renderQR($('share-qr'), url, 240); } catch {}
    return;
  }
  hide($('qr-note'));
  await showQR('Share this server', `obelisk://join?relay=${url}`);
}

async function openScanner() {
  hide($('add-server-error'));
  hide($('scan-error'));
  show($('scan-modal'));
  try {
    stopScanner = await startScanner(
      $('scan-video'),
      $('scan-canvas'),
      (text) => {
        hide($('scan-modal'));
        stopScanner = null;
        try {
          const { url, invite } = parseServerInput(text);
          hide($('add-server-modal'));
          addServer(url, invite, $('add-server-name').value);
          $('add-server-name').value = '';
        } catch (e) {
          $('add-server-input').value = text;
          setText($('add-server-error'), String(e.message || e));
          show($('add-server-error'));
        }
      },
      (e) => {
        setText($('scan-error'), String(e.message || e));
        show($('scan-error'));
      },
    );
  } catch (e) {
    setText($('scan-error'), String(e.message || e));
    show($('scan-error'));
  }
}

function closeScanner() {
  stopScanner?.();
  stopScanner = null;
  hide($('scan-modal'));
}

// ---------- channel administration ----------

function openChannelAdmin() {
  if (!activeChannel || !isAdminOf(activeChannel)) return;
  const ch = channels.get(activeChannel);
  hide($('ca-error'));
  $('ca-name').value = ch?.name || '';
  $('ca-about').value = ch?.about || '';
  renderChannelMembers();
  show($('channel-admin-modal'));
}

function renderChannelMembers() {
  const box = $('ca-members');
  box.innerHTML = '';
  const list = channelMembers.get(activeChannel) || [];
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = 'No members listed yet.';
    box.appendChild(p);
    return;
  }
  const admins = channelAdmins.get(activeChannel) || new Set();
  for (const m of list) {
    const row = document.createElement('div');
    row.className = 'wl-item';

    const who = document.createElement('code');
    const name = profiles.get(m.pubkey);
    who.textContent = (name ? name + ' · ' : '') + shortNpub(m.pubkey) + (admins.has(m.pubkey) ? ' · admin' : '');
    who.title = nip19.npubEncode(m.pubkey);

    const actions = document.createElement('div');
    actions.className = 'row gap';
    if (m.pubkey !== signer.pubkey) {
      const promote = document.createElement('button');
      promote.textContent = admins.has(m.pubkey) ? 'demote' : 'make admin';
      promote.className = 'link-btn';
      promote.onclick = () => setRole(m.pubkey, admins.has(m.pubkey) ? 'member' : 'admin');
      const kick = document.createElement('button');
      kick.textContent = 'remove';
      kick.onclick = () => removeMember(m.pubkey);
      actions.append(promote, kick);
    }
    row.append(who, actions);
    box.appendChild(row);
  }
}

async function adminPublish(kind, tags, errEl = 'ca-error') {
  try {
    const ev = await signer.sign({ kind, tags, content: '' });
    const { ok, msg } = await conn.publish(ev);
    if (!ok) throw new Error(msg);
    return true;
  } catch (e) {
    setText($(errEl), String(e.message || e));
    show($(errEl));
    return false;
  }
}

async function setRole(pubkey, role) {
  const ok = await adminPublish(KIND.PUT_USER, [
    ['h', activeChannel],
    ['p', pubkey, role],
  ]);
  if (ok) setTimeout(renderChannelMembers, 400);
}

async function removeMember(pubkey) {
  if (!confirm('Remove this member from the channel?')) return;
  const ok = await adminPublish(KIND.REMOVE_USER, [
    ['h', activeChannel],
    ['p', pubkey],
  ]);
  if (ok) setTimeout(renderChannelMembers, 400);
}

// ---------- hosting (desktop only) ----------

let hostPollTimer = null;
let lastInvite = null;

async function refreshHostPanel() {
  if (!tauriInvoke) return;
  try {
    const st = await tauriInvoke('host_status');
    // Tor missing is a blocker, not a footnote: without it the server exists
    // only on this machine. Say so before the start button, not after.
    // Tor missing only blocks when Tor is the only route chosen — a LAN
    // server is a legitimate thing to run without it.
    const needsTor = $('host-use-tor').checked && !$('host-clearnet').checked;
    $('host-tor-warning').classList.toggle('hidden', st.tor_available || !needsTor);
    $('host-form').classList.toggle('hidden', !st.tor_available && needsTor);

    if (st.running) {
      hide($('host-stopped'));
      show($('host-running'));
      setText($('host-state'), st.tor_state);
      setText($('host-onion'), st.onion ? 'ws://' + st.onion : '(not published through Tor)');
      $('host-lan-row').classList.toggle('hidden', !st.lan_url);
      if (st.lan_url) setText($('host-lan'), st.lan_url);
      setText($('host-share'), st.share_link || st.relay_url || '—');

      $('host-locked').checked = !!st.locked;
      setText(
        $('host-locked-label'),
        st.locked ? 'Closed — nobody new can join' : 'Open — invite codes work',
      );

      const invites = $('host-invite-list');
      invites.innerHTML = '';
      for (const inv of st.invites || []) {
        const row = document.createElement('div');
        row.className = 'wl-item';
        const code = document.createElement('code');
        code.textContent = `${inv.code}  ${inv.uses}/${inv.max_uses}`;
        const revoke = document.createElement('button');
        revoke.textContent = 'revoke';
        revoke.onclick = async () => {
          try { await tauriInvoke('host_invite_revoke', { code: inv.code }); refreshHostPanel(); }
          catch (e) { hostError(e); }
        };
        row.append(code, revoke);
        invites.appendChild(row);
      }
      $('host-revoke-all').classList.toggle('hidden', !(st.invites || []).length);

      const wl = $('host-wl-list');
      wl.innerHTML = '';
      for (const npub of st.whitelist) {
        const row = document.createElement('div');
        row.className = 'wl-item';
        const code = document.createElement('code');
        code.textContent = npub.slice(0, 16) + '…' + npub.slice(-6);
        code.title = npub;
        const del = document.createElement('button');
        del.textContent = 'remove';
        del.onclick = async () => {
          try { await tauriInvoke('host_whitelist_remove', { pubkey: npub }); refreshHostPanel(); }
          catch (e) { hostError(e); }
        };
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
  setText(el, String(e?.message || e || ''));
  el.classList.toggle('hidden', !e);
}

// ---------- settings ----------

function approximateCacheSize() {
  let bytes = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('menhir-cache/')) bytes += k.length + (localStorage.getItem(k)?.length || 0);
  }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function openSettings() {
  hide($('profile-error'));
  hide($('nsec-box'));
  hide($('profile-saved'));
  $('profile-name').value = myProfile.name || '';
  $('profile-about').value = myProfile.about || '';
  setText($('profile-npub'), nip19.npubEncode(signer.pubkey));
  setText($('profile-signer'), {
    nsec: 'a secret key on this device',
    nip07: 'a browser extension',
    bunker: 'a remote signer (NIP-46)',
  }[signer.kind] || signer.kind);
  $('reveal-nsec').classList.toggle('hidden', signer.kind !== 'nsec');
  setText($('cache-size'), approximateCacheSize());
  setText($('app-version'), APP_VERSION);
  show($('profile-modal'));
}

async function saveProfile() {
  const name = $('profile-name').value.trim();
  const about = $('profile-about').value.trim();
  hide($('profile-saved'));
  if (!name) {
    setText($('profile-error'), 'pick a display name');
    show($('profile-error'));
    return;
  }
  if (!conn) {
    setText($('profile-error'), 'connect to a server first — your profile is published to it');
    show($('profile-error'));
    return;
  }
  try {
    const content = JSON.stringify(
      about ? { name, display_name: name, about } : { name, display_name: name },
    );
    const ev = await signer.sign({ kind: KIND.PROFILE, tags: [], content });
    const { ok, msg } = await conn.publish(ev);
    if (!ok) throw new Error(msg);
    myProfile = { name, about };
    profiles.set(signer.pubkey, name);
    store.saveProfiles(activeServer.url, Object.fromEntries(profiles));
    setText($('me-name'), name);
    renderMessageAuthors();
    hide($('profile-error'));
    show($('profile-saved'));
  } catch (e) {
    setText($('profile-error'), String(e.message || e));
    show($('profile-error'));
  }
}

function logOut() {
  if (!confirm('Log out? If you signed in with a secret key, make sure it is backed up — it is removed from this device.')) return;
  localStorage.removeItem('menhir-signer');
  location.reload();
}

// ---------- login ----------

function loginError(e) {
  const el = $('login-error');
  setText(el, String(e?.message || e || ''));
  el.classList.toggle('hidden', !e);
}

const loginBusy = (on) => $('login-busy').classList.toggle('hidden', !on);

function showLoginPane(name) {
  loginError(null);
  for (const p of ['nsec', 'new', 'bunker']) {
    $('pane-' + p).classList.toggle('hidden', p !== name);
  }
  document.querySelector('.login-methods').classList.toggle('hidden', !!name);
  if (name !== 'bunker') {
    ncSession?.cancel();
    ncSession = null;
  }
}

async function adopt(newSigner) {
  signer = newSigner;
  persistSigner();
  enterApp();
}

function enterApp() {
  hide($('login-screen'));
  show($('app-screen'));
  setText($('me-name'), myProfile.name || 'set your name');
  setText($('me-npub'), shortNpub(signer.pubkey));
  renderRail();
  renderChannels();
  showPane('channels');
  clearChat(servers.length ? 'Pick a server on the left.' : 'Add a server with +, or host your own.');
  if (tauriInvoke) {
    tauriInvoke('host_status')
      .then((st) => { if (st.supported) show($('host-btn')); })
      .catch(() => {});
  }
  if (servers.length) selectServer(servers[0]);
}

// ---------- boot ----------

function wireLogin() {
  if (Nip07Signer.available()) show($('m-nip07'));

  $('m-nip07').onclick = async () => {
    loginError(null);
    loginBusy(true);
    try { await adopt(await Nip07Signer.connect()); }
    catch (e) { loginError(e); }
    finally { loginBusy(false); }
  };

  $('m-nsec').onclick = () => showLoginPane('nsec');

  $('m-new').onclick = () => {
    const s = NsecSigner.generate();
    $('generated-nsec').textContent = s.nsec();
    $('generated-nsec').dataset.hex = s.persist().sk;
    showLoginPane('new');
  };

  $('m-bunker').onclick = async () => {
    showLoginPane('bunker');
    loginBusy(true);
    try {
      ncSession = RemoteSigner.startNostrConnect({
        relays: NOSTR_CONNECT_RELAYS,
        name: 'Obelisk Menhir',
        onConnected: (s) => { ncSession = null; adopt(s); },
        onError: (e) => { loginError(e); loginBusy(false); },
      });
      await renderQR($('nc-qr'), ncSession.uri, 220);
      $('nc-copy').onclick = async () => { await copyText(ncSession.uri); flash($('nc-copy')); };
    } catch (e) {
      loginError(e);
    } finally {
      loginBusy(false);
    }
  };

  $('bunker-go').onclick = async () => {
    loginError(null);
    loginBusy(true);
    try { await adopt(await RemoteSigner.fromBunkerUri($('bunker-uri').value)); }
    catch (e) { loginError(e); }
    finally { loginBusy(false); }
  };

  $('login-nsec-go').onclick = async () => {
    loginError(null);
    try { await adopt(NsecSigner.fromInput($('login-nsec').value)); }
    catch (e) { loginError(e); }
  };

  $('copy-generated').onclick = async () => {
    await copyText($('generated-nsec').textContent);
    flash($('copy-generated'));
  };

  $('use-generated-btn').onclick = async () => {
    try { await adopt(NsecSigner.fromInput($('generated-nsec').dataset.hex)); }
    catch (e) { loginError(e); }
  };

  for (const btn of document.querySelectorAll('[data-back]')) {
    btn.onclick = () => showLoginPane(null);
  }
}

function wireApp() {
  $('logout-btn').onclick = logOut;
  $('logout-btn-settings').onclick = logOut;

  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.onclick = () => {
      if (btn.dataset.close === 'scan-modal') closeScanner();
      else hide($(btn.dataset.close));
      if (btn.dataset.close === 'host-modal') clearInterval(hostPollTimer);
    };
  }

  // servers
  $('add-server-btn').onclick = () => {
    hide($('add-server-error'));
    show($('add-server-modal'));
    $('add-server-input').focus();
  };
  $('add-server-confirm').onclick = () => {
    try {
      const { url, invite } = parseServerInput($('add-server-input').value);
      hide($('add-server-modal'));
      const name = $('add-server-name').value;
      $('add-server-input').value = '';
      $('add-server-name').value = '';
      addServer(url, invite, name);
    } catch (e) {
      setText($('add-server-error'), String(e.message || e));
      show($('add-server-error'));
    }
  };
  $('scan-qr-btn').onclick = openScanner;
  $('qr-copy').onclick = async () => { await copyText(currentQrText); flash($('qr-copy')); };
  $('server-qr-btn').onclick = () => shareActiveServer();
  $('server-settings-btn').onclick = () => openServerSettings(activeServer);
  $('server-rename-save').onclick = saveServerName;
  $('server-remove').onclick = removeServer;

  // settings
  $('me-box').onclick = openSettings;
  $('profile-save').onclick = saveProfile;
  $('copy-npub').onclick = async () => {
    await copyText(nip19.npubEncode(signer.pubkey));
    flash($('copy-npub'));
  };
  $('reveal-nsec').onclick = () => {
    if (signer.kind !== 'nsec') return;
    if (!confirm('Show your secret key on screen?')) return;
    setText($('nsec-value'), signer.nsec());
    show($('nsec-box'));
  };
  $('copy-nsec').onclick = async () => {
    await copyText($('nsec-value').textContent);
    flash($('copy-nsec'));
  };
  $('clear-cache').onclick = () => {
    if (!confirm('Delete cached messages on this device? They will be re-fetched from each server.')) return;
    for (const s of servers) store.forgetServer(s.url);
    messages = new Map();
    setText($('cache-size'), approximateCacheSize());
    if (activeChannel) renderMessages(activeChannel);
  };

  // channels
  $('create-channel-btn').onclick = () => {
    hide($('cc-error'));
    show($('create-channel-modal'));
    $('cc-id').focus();
  };
  $('cc-confirm').onclick = async () => {
    const id = $('cc-id').value.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,64}$/.test(id)) {
      setText($('cc-error'), 'id must be 1-64 characters of a-z 0-9 - _');
      show($('cc-error'));
      return;
    }
    const tags = [['h', id]];
    if ($('cc-name').value.trim()) tags.push(['name', $('cc-name').value.trim()]);
    if ($('cc-about').value.trim()) tags.push(['about', $('cc-about').value.trim()]);
    if (await adminPublish(KIND.CREATE_GROUP, tags, 'cc-error')) {
      hide($('create-channel-modal'));
      $('cc-id').value = $('cc-name').value = $('cc-about').value = '';
      setTimeout(() => selectChannel(id), 400);
    }
  };

  // channel administration
  $('channel-admin-btn').onclick = openChannelAdmin;
  $('ca-save').onclick = async () => {
    const tags = [['h', activeChannel], ['name', $('ca-name').value.trim() || activeChannel]];
    if ($('ca-about').value.trim()) tags.push(['about', $('ca-about').value.trim()]);
    if (await adminPublish(KIND.EDIT_METADATA, tags)) hide($('channel-admin-modal'));
  };
  $('ca-delete').onclick = async () => {
    if (!confirm(`Delete #${activeChannel}? Its messages are erased and the id can never be reused on this server.`)) return;
    if (await adminPublish(KIND.DELETE_GROUP, [['h', activeChannel]])) {
      channels.delete(activeChannel);
      messages.delete(activeChannel);
      store.saveChannels(activeServer.url, [...channels.values()]);
      hide($('channel-admin-modal'));
      activeChannel = null;
      renderChannels();
      clearChat('Channel deleted.');
      hide($('composer'));
      refreshAdminAffordance();
    }
  };

  // composer
  $('send-btn').onclick = sendMessage;
  const input = $('composer-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile()) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  $('back-btn').onclick = () => showPane('channels');

  // hosting
  $('host-btn').onclick = () => {
    hostError(null);
    show($('host-modal'));
    refreshHostPanel();
    clearInterval(hostPollTimer);
    hostPollTimer = setInterval(refreshHostPanel, 3000);
  };
  $('host-recheck-btn').onclick = refreshHostPanel;
  $('host-use-tor').onchange = refreshHostPanel;
  $('host-clearnet').onchange = refreshHostPanel;
  $('host-start-btn').onclick = async () => {
    hostError(null);
    const btn = $('host-start-btn');
    btn.disabled = true;
    btn.textContent = 'Starting… Tor can take a minute';
    try {
      await tauriInvoke('host_start', {
        name: $('host-name').value.trim() || 'My Menhir',
        operatorNpub: nip19.npubEncode(signer.pubkey),
        useTor: $('host-use-tor').checked,
        clearnet: $('host-clearnet').checked,
      });
      await refreshHostPanel();
    } catch (e) {
      hostError(e);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Start hosting';
    }
  };
  $('host-stop-btn').onclick = async () => {
    try { await tauriInvoke('host_stop'); await refreshHostPanel(); } catch (e) { hostError(e); }
  };
  $('host-invite-btn').onclick = async () => {
    try {
      const inv = await tauriInvoke('host_invite_create', { maxUses: 1, expiresHours: null });
      lastInvite = inv.share_link || inv.code;
      setText($('host-invite-out'), lastInvite);
      show($('host-invite-out'));
      show($('host-invite-qr'));
    } catch (e) { hostError(e); }
  };
  $('host-invite-qr').onclick = () => { if (lastInvite) showQR('Invite — scan to join', lastInvite); };
  $('host-share-qr').onclick = () => {
    const text = $('host-share').textContent;
    if (text && text !== '—') showQR('Share this server', text);
  };
  $('host-copy-share').onclick = async () => {
    await copyText($('host-share').textContent);
    flash($('host-copy-share'));
  };
  $('host-open-local').onclick = async () => {
    try {
      const st = await tauriInvoke('host_status');
      const url = st.onion ? 'ws://' + st.onion : st.relay_url;
      if (url) {
        clearInterval(hostPollTimer);
        hide($('host-modal'));
        addServer(url, null, $('host-name').value.trim());
      }
    } catch (e) { hostError(e); }
  };
  $('host-locked').onchange = async (e) => {
    try { await tauriInvoke('host_set_locked', { locked: e.target.checked }); await refreshHostPanel(); }
    catch (err) { hostError(err); refreshHostPanel(); }
  };
  $('host-revoke-all').onclick = async () => {
    if (!confirm('Revoke every outstanding invite? Links already sent will stop working.')) return;
    try { await tauriInvoke('host_invite_revoke', { code: null }); await refreshHostPanel(); }
    catch (e) { hostError(e); }
  };
  $('host-wl-add').onclick = async () => {
    try {
      await tauriInvoke('host_whitelist_add', { pubkey: $('host-wl-input').value.trim() });
      $('host-wl-input').value = '';
      refreshHostPanel();
    } catch (e) { hostError(e); }
  };

  trackKeyboard();

  // Mobile browsers kill pages without warning; flush pending cache writes.
  // Coming back to the app catches up the read mark for whatever is on screen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') store.flushWrites();
    else if (activeChannel) { renderMessages(activeChannel); markRead(activeChannel); }
  });
  window.addEventListener('focus', () => { if (activeChannel) markRead(activeChannel); });
}

/**
 * Keep the app the size of the *visible* viewport.
 *
 * An Android WebView shifts the whole page up when the keyboard opens, which
 * drags the server rail and header off screen and leaves the composer floating
 * mid-screen. Sizing to visualViewport instead means the layout shrinks: the
 * header stays put, the message list gets shorter, and the composer sits
 * directly above the keyboard.
 */
function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
    // Opening the keyboard should not hide the message you are replying to.
    const box = $('messages');
    if (box) box.scrollTop = box.scrollHeight;
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}

async function boot() {
  wireLogin();
  wireApp();

  const stored = localStorage.getItem('menhir-signer');
  if (stored) {
    try {
      const restored = await restoreSigner(JSON.parse(stored));
      if (restored) {
        signer = restored;
        enterApp();
        return;
      }
    } catch {}
  }
  show($('login-screen'));
}

boot();
