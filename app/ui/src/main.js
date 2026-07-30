// Obelisk Menhir — Nostr text-channel client.
// Transport: raw NIP-01 websocket. Signing: nsec / NIP-07 / NIP-46 (see signer.js).
// Under Tauri, hosting and .onion bridging come from Rust commands.

import * as nip19 from 'nostr-tools/nip19';
import { NsecSigner, Nip07Signer, RemoteSigner, restoreSigner } from './signer.js';
import { renderQR, startScanner } from './qr.js';

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');
const setText = (el, t) => { el.textContent = t; };

const NOSTR_CONNECT_RELAYS = ['wss://relay.nsec.app', 'wss://relay.damus.io', 'wss://nos.lol'];

function shortNpub(pkHex) {
  const npub = nip19.npubEncode(pkHex);
  return npub.slice(0, 10) + '…' + npub.slice(-4);
}

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

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
      const failTimer = setTimeout(() => { ws.close(); reject(new Error('connection timed out')); }, 20000);
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

  waitForOk(eventId, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.okWaiters.delete(eventId);
        resolve({ ok: false, msg: 'timed out waiting for the relay' });
      }, timeoutMs);
      this.okWaiters.set(eventId, (r) => { clearTimeout(timer); resolve(r); });
    });
  }

  publish(event, timeoutMs = 15000) {
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
let reconnectTimer = null;
let myProfile = { name: '', about: '' };
let ncSession = null;
let stopScanner = null;

const saveServers = () => localStorage.setItem('menhir-servers', JSON.stringify(servers));

function persistSigner() {
  const blob = signer?.persist?.();
  if (blob) localStorage.setItem('menhir-signer', JSON.stringify(blob));
  else localStorage.removeItem('menhir-signer');
}

// ---------- connection flow ----------

async function resolveWsUrl(url) {
  if (!url.includes('.onion')) return url;
  if (!tauriInvoke) {
    throw new Error('.onion servers need the Menhir app — a browser cannot reach Tor on its own');
  }
  // The Rust side bridges onion → loopback: a managed Tor on desktop, an
  // embedded arti on mobile. Either way the first connect builds a circuit,
  // which is slow enough to be worth saying out loud.
  setServerStatus('connecting through Tor…');
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
  setText($('server-name'), entry.label || entry.url);
  show($('server-qr-btn'));
  setServerStatus('connecting…');
  if (isMobile()) showPane('channels');

  let wsUrl;
  try {
    wsUrl = await resolveWsUrl(entry.url);
  } catch (e) {
    setServerStatus(String(e.message || e), true);
    clearChat(String(e.message || e));
    return;
  }

  const c = new RelayConn(entry.url, wsUrl);
  conn = c;
  let ready = false;
  let graceTimer = null;

  const onReady = () => {
    if (ready || conn !== c) return;
    ready = true;
    setServerStatus(isUnprotectedCleartext(entry.url) ? 'online — unencrypted (ws://)' : 'online');
    openMetaSubscriptions(c);
  };

  c.onauthchallenge = async (challenge) => {
    clearTimeout(graceTimer);
    if (conn !== c) return;
    try {
      setServerStatus('authenticating…');
      // The relay tag must name the endpoint actually dialled: the relay
      // compares it against the connection's Host header to stop a signed
      // auth event being replayed against a different relay.
      const authEvent = await signer.sign({
        kind: 22242,
        tags: [['relay', wsUrl], ['challenge', challenge]],
        content: '',
      });
      const waiter = c.waitForOk(authEvent.id);
      c.send(['AUTH', authEvent]);
      const result = await waiter;
      if (result.ok) return onReady();

      if (entry.invite) {
        setServerStatus('redeeming invite…');
        const redeem = await signer.sign({ kind: 20284, tags: [], content: entry.invite });
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
    setServerStatus('disconnected — retrying', true);
    reconnectTimer = setTimeout(() => { if (activeServer === entry) selectServer(entry); }, 4000);
  };

  try {
    await c.connect();
  } catch (e) {
    if (conn === c) {
      setServerStatus('unreachable: ' + (e.message || e), true);
      clearChat('Could not reach this server. Is the host online?');
      reconnectTimer = setTimeout(() => { if (activeServer === entry) selectServer(entry); }, 6000);
    }
    return;
  }
  // Open relays send no AUTH challenge — proceed after a short grace period.
  graceTimer = setTimeout(onReady, 1500);
}

function openMetaSubscriptions(c) {
  c.req([{ kinds: [39000], limit: 500 }], {
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
      renderChannels();
      if (channels.size === 0) {
        clearChat('No channels here yet.' + (conn ? '\n\nCreate the first one with “+ new channel”.' : ''));
      } else if (!activeChannel && !isMobile()) {
        selectChannel([...channels.keys()][0]);
      } else if (!activeChannel) {
        clearChat('Pick a channel.');
      }
    },
  });
  c.req([{ kinds: [0], limit: 500 }], {
    onevent: (ev) => {
      try {
        const meta = JSON.parse(ev.content);
        const name = meta.display_name || meta.name;
        if (name) {
          profiles.set(ev.pubkey, name);
          if (ev.pubkey === signer.pubkey) {
            myProfile = { name, about: meta.about || '' };
            setText($('me-name'), name);
          }
          renderMessageAuthors();
        }
      } catch {}
    },
  });
}

// ---------- channels & messages ----------

function selectChannel(id) {
  if (!conn) return;
  if (msgSubId) conn.closeSub(msgSubId);
  activeChannel = id;
  renderChannels();
  setText($('chat-title'), '#' + (channels.get(id)?.name || id));
  clearChat();
  show($('composer'));
  if (isMobile()) showPane('chat');

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
      if (buffer.length === 0) clearChat('No messages yet — say something.');
      else for (const ev of buffer) appendMessage(ev, false);
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
  const placeholder = box.querySelector('.msg.system');
  if (placeholder) placeholder.remove();

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
  box.appendChild(div);
  if (scroll) scrollChat();
}

function renderMessageAuthors() {
  for (const div of document.querySelectorAll('#messages .msg[data-pubkey]')) {
    const name = profiles.get(div.dataset.pubkey);
    if (name) setText(div.querySelector('.author'), name);
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
  input.value = '';
  input.style.height = 'auto';
  try {
    const ev = await signer.sign({ kind: 9, tags: [['h', activeChannel]], content: text });
    const { ok, msg } = await conn.publish(ev);
    if (!ok) {
      setServerStatus('send failed: ' + msg, true);
      input.value = text;
    }
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
    btn.onclick = () => selectServer(entry);
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      const name = prompt('Name this server (Cancel to remove it)', entry.label || '');
      if (name === null) {
        if (!confirm(`Remove ${label}?`)) return;
        servers = servers.filter((s) => s !== entry);
        saveServers();
        if (activeServer === entry) {
          conn?.destroy();
          conn = null;
          activeServer = null;
          channels = new Map();
          renderChannels();
          clearChat('Pick a server, or add one with +.');
          hide($('server-qr-btn'));
        }
      } else if (name.trim()) {
        entry.label = name.trim();
        saveServers();
        if (activeServer === entry) setText($('server-name'), entry.label);
      }
      renderRail();
    };
    list.appendChild(btn);
  }
}

function renderChannels() {
  const list = $('channel-list');
  list.innerHTML = '';
  for (const ch of [...channels.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const div = document.createElement('div');
    div.className = 'channel-item' + (ch.id === activeChannel ? ' active' : '');
    div.textContent = '#' + ch.name;
    div.title = ch.about || ch.id;
    div.onclick = () => selectChannel(ch.id);
    list.appendChild(div);
  }
  $('create-channel-btn').classList.toggle('hidden', !conn);
}

// ---------- mobile panes ----------

const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

/** 'channels' or 'chat' — only meaningful on phones. */
function showPane(which) {
  document.body.classList.toggle('show-chat', which === 'chat');
}

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

function addServer(url, invite) {
  let entry = servers.find((s) => s.url === url);
  if (!entry) {
    const host = url.replace(/^wss?:\/\//, '').split('/')[0].split(':')[0];
    entry = { url, label: host.length > 18 ? host.slice(0, 10) + '…' : host, invite };
    servers.push(entry);
    saveServers();
  } else if (invite) {
    entry.invite = invite;
    saveServers();
  }
  renderRail();
  selectServer(entry);
}

let currentQrText = '';

async function showQR(title, text) {
  currentQrText = text;
  setText($('qr-title'), title);
  setText($('qr-text'), text);
  show($('qr-modal'));
  try {
    await renderQR($('share-qr'), text, 240);
  } catch (e) {
    setText($('qr-text'), 'Could not render a QR: ' + (e.message || e));
  }
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
          addServer(url, invite);
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

// ---------- hosting (desktop only) ----------

let hostPollTimer = null;
let lastInvite = null;

async function refreshHostPanel() {
  if (!tauriInvoke) return;
  try {
    const st = await tauriInvoke('host_status');
    // Tor missing is a blocker, not a footnote: without it the server exists
    // only on this machine. Say so before the start button, not after.
    $('host-tor-warning').classList.toggle('hidden', st.tor_available);
    $('host-form').classList.toggle('hidden', !st.tor_available);

    if (st.running) {
      hide($('host-stopped'));
      show($('host-running'));
      setText($('host-state'), st.tor_state);
      setText($('host-onion'), st.onion ? 'ws://' + st.onion : '(no Tor — local only)');
      setText($('host-share'), st.share_link || st.relay_url || '—');
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

// ---------- login ----------

function loginError(e) {
  const el = $('login-error');
  setText(el, String(e?.message || e || ''));
  el.classList.toggle('hidden', !e);
}

function loginBusy(on) {
  $('login-busy').classList.toggle('hidden', !on);
}

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
  $('logout-btn').onclick = () => {
    if (!confirm('Log out? If you logged in with a secret key, make sure it is backed up — it is removed from this device.')) return;
    localStorage.removeItem('menhir-signer');
    location.reload();
  };

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
      $('add-server-input').value = '';
      addServer(url, invite);
    } catch (e) {
      setText($('add-server-error'), String(e.message || e));
      show($('add-server-error'));
    }
  };
  $('scan-qr-btn').onclick = openScanner;
  $('qr-copy').onclick = async () => { await copyText(currentQrText); flash($('qr-copy')); };
  $('server-qr-btn').onclick = () => {
    if (activeServer) showQR('Share this server', `obelisk://join?relay=${activeServer.url}`);
  };

  // profile
  $('me-box').onclick = () => {
    hide($('profile-error'));
    $('profile-name').value = myProfile.name || '';
    $('profile-about').value = myProfile.about || '';
    setText($('profile-npub'), nip19.npubEncode(signer.pubkey));
    setText($('profile-signer'), {
      nsec: 'a secret key on this device',
      nip07: 'a browser extension',
      bunker: 'a remote signer (NIP-46)',
    }[signer.kind] || signer.kind);
    show($('profile-modal'));
    $('profile-name').focus();
  };
  $('profile-save').onclick = async () => {
    const name = $('profile-name').value.trim();
    const about = $('profile-about').value.trim();
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
      const content = JSON.stringify(about ? { name, display_name: name, about } : { name, display_name: name });
      const ev = await signer.sign({ kind: 0, tags: [], content });
      const { ok, msg } = await conn.publish(ev);
      if (!ok) throw new Error(msg);
      myProfile = { name, about };
      profiles.set(signer.pubkey, name);
      setText($('me-name'), name);
      renderMessageAuthors();
      hide($('profile-modal'));
    } catch (e) {
      setText($('profile-error'), String(e.message || e));
      show($('profile-error'));
    }
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
    try {
      const ev = await signer.sign({ kind: 9007, tags, content: '' });
      const { ok, msg } = await conn.publish(ev);
      if (!ok) throw new Error(msg);
      hide($('create-channel-modal'));
      $('cc-id').value = $('cc-name').value = $('cc-about').value = '';
      setTimeout(() => selectChannel(id), 300);
    } catch (e) {
      setText($('cc-error'), String(e.message || e));
      show($('cc-error'));
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
        addServer(url, null);
      }
    } catch (e) { hostError(e); }
  };
  $('host-wl-add').onclick = async () => {
    try {
      await tauriInvoke('host_whitelist_add', { pubkey: $('host-wl-input').value.trim() });
      $('host-wl-input').value = '';
      refreshHostPanel();
    } catch (e) { hostError(e); }
  };
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
