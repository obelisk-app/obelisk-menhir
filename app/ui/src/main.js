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
import { openModal, closeModal, onModalClose, wireModals, confirmAsk, toast, showError } from './ui.js';
import { createEmojiPicker } from './emoji.js';
import { OBELISK_SVG, CHAT_SVG, PUBLICATION_SVG } from './icons.js';

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

/** Channel types, as carried by the `t` tag on relay-signed metadata. */
const CHAT_CHANNEL = 'chat';
const PUBLICATION_CHANNEL = 'publication';

function shortNpub(pkHex) {
  const npub = nip19.npubEncode(pkHex);
  return npub.slice(0, 10) + '…' + npub.slice(-4);
}

const fmtTime = (ts) =>
  new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const fmtDateTime = (ts) =>
  new Date(ts * 1000).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

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
/** True once the relay has let us in — writes are pointless before that. */
let serverReady = false;
let channels = new Map();
let activeChannel = null;
let msgSubId = null;
let profiles = new Map();
let myProfile = { name: '', about: '' };
let ncSession = null;
let stopScanner = null;
let emojiPicker = null;

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
/** The message being replied to, or null. */
let replyTo = null;
/** Unread totals for servers we are not connected to, read from the cache. */
let cachedUnread = new Map();
/** Last host_status seen, so the UI can answer "is my own server up?". */
let hostStatus = null;

let reconnectTimer = null;
let reconnectAttempt = 0;
let countdownTimer = null;

const saveServers = () => localStorage.setItem('menhir-servers', JSON.stringify(servers));

function persistSigner() {
  const blob = signer?.persist?.();
  if (blob) localStorage.setItem('menhir-signer', JSON.stringify(blob));
  else localStorage.removeItem('menhir-signer');
}

// ---------- addresses ----------

const isLoopback = (url) =>
  /^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);

/** True for a host that is only meaningful on this machine or LAN. */
function isPrivateHost(host) {
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

/**
 * Turn whatever someone pasted into a relay URL.
 *
 * People paste all sorts of things: an onion, a LAN address with a port, a
 * domain their friend gave them, a browser URL with https on the front. The
 * only judgement call is the scheme when there is none — a public name gets
 * `wss://` because a clearnet relay without TLS is readable by every hop in
 * between, while a LAN address or an onion gets `ws://` because there is no
 * certificate to be had for either (Tor encrypts the onion end to end).
 */
function normalizeRelayUrl(raw) {
  let input = (raw || '').trim();
  const nope = () =>
    new Error(`"${input}" is not an address I can dial — try wss://relay.example.com, ws://…onion, or an obelisk://join link`);
  if (!input) throw new Error('paste an address, or an obelisk://join link');
  if (/\s/.test(input)) throw nope();
  if (/^https?:\/\//i.test(input)) input = 'ws' + input.slice(4); // http→ws, https→wss
  if (!/^wss?:\/\//i.test(input)) {
    const host = input.split('/')[0].split(':')[0].toLowerCase();
    const secure = !(isPrivateHost(host) || host.endsWith('.onion'));
    input = (secure ? 'wss://' : 'ws://') + input;
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw nope();
  }
  if (!looksLikeHost(url.hostname)) throw nope();
  // Trailing slashes matter: they change the cache key and the NIP-42 relay
  // tag, so two spellings of one relay would look like two servers.
  return url.toString().replace(/\/$/, '');
}

/** A sanity check on a host, so a sentence typed by mistake is not "a server". */
function looksLikeHost(host) {
  if (!host) return false;
  if (host === 'localhost') return true;
  if (/^\[[0-9a-f:]+\]$/i.test(host)) return true; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // Anything else must be a dotted name: `relay.example.com`, `box.local`,
  // `abc…xyz.onion`. A single bare word is far more likely to be a typo.
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host);
}

function parseServerInput(raw) {
  const input = (raw || '').trim();
  if (input.startsWith('obelisk://join') || input.includes('/join?')) {
    const params = new URLSearchParams(input.split('?')[1] || '');
    const relay = params.get('relay');
    if (!relay) throw new Error('that link has no relay in it');
    return { url: normalizeRelayUrl(relay), invite: params.get('invite') || null };
  }
  return { url: normalizeRelayUrl(input), invite: null };
}

function isUnprotectedCleartext(url) {
  if (!url.startsWith('ws://')) return false;
  const host = url.slice(5).split('/')[0].split(':')[0];
  if (host.endsWith('.onion')) return false; // Tor encrypts end to end
  return !['127.0.0.1', 'localhost', '::1'].includes(host);
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

function setServerStatus(text, isError) {
  const el = $('server-status');
  el.textContent = text;
  el.style.color = isError ? 'var(--lc-red)' : '';
}

/** Ask the node manager what it is running, without ever throwing. */
async function readHostStatus() {
  if (!tauriInvoke) return null;
  try {
    hostStatus = await tauriInvoke('host_status');
    tagLocalServers();
    return hostStatus;
  } catch {
    return null;
  }
}

/**
 * Mark the server entry that is this computer's own relay.
 *
 * Knowing which entry is "mine" is what lets the client refuse to dial a
 * loopback port when hosting is switched off, instead of retrying forever
 * against a server that was never started.
 */
function tagLocalServers() {
  if (!hostStatus?.relay_url) return;
  const entry = servers.find((s) => s.url === hostStatus.relay_url);
  if (entry && !entry.local) {
    entry.local = true;
    saveServers();
  }
}

/** Back off after repeated failures instead of hammering a server that is down. */
function scheduleReconnect(entry) {
  clearTimeout(reconnectTimer);
  clearInterval(countdownTimer);
  reconnectAttempt += 1;
  // A loopback port either has something listening or it does not, and no
  // amount of waiting changes that — so stop, and say what to do instead.
  if (isLoopback(entry.url) && reconnectAttempt >= 3) {
    setServerStatus('nothing is listening there', true);
    renderPlaceholder(
      `Nothing is answering at ${entry.url}.\n\nStart hosting, or run "menhir-relay serve" in a terminal.`,
      [
        tauriInvoke && { label: 'Host a server', primary: true, run: openHostPanel },
        { label: 'Try again', run: () => connectTo(entry, false) },
      ].filter(Boolean),
    );
    return;
  }
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

function stopReconnect() {
  clearTimeout(reconnectTimer);
  clearInterval(countdownTimer);
  reconnectTimer = null;
  countdownTimer = null;
}

/**
 * Connect (or reconnect) to a server.
 *
 * On a reconnect the UI is deliberately left alone: channels and messages stay
 * on screen from the cache, and subscriptions resume from the newest event we
 * already hold rather than refetching everything.
 */
async function connectTo(entry, isReconnect = false) {
  stopReconnect();
  conn?.destroy();
  conn = null;
  serverReady = false;

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
    clearReply();
    renderRail();
    renderChannels();
    setText($('server-name'), entry.label || entry.url);
    show($('server-qr-btn'));
    show($('server-settings-btn'));
    hide($('composer'));
    clearChat(channels.size ? 'Pick a channel.' : 'Connecting…');
    if (isMobile()) showPane('channels');
  }
  setServerStatus(isReconnect ? 'reconnecting…' : 'connecting…');

  // A server this computer hosts: ask the node manager before dialling. Its
  // relay is not something the network can bring back — if hosting is off,
  // retrying is noise, and the useful thing to show is the button that starts
  // it. The relay's port can also have moved since last time.
  if (entry.local && tauriInvoke) {
    const st = await readHostStatus();
    if (st?.starting) {
      // Resuming after a restart: the relay is coming, Tor just takes its time.
      setServerStatus('your server is starting…');
      clearChat('Starting your server… Tor can take a minute to build its first circuit.');
      reconnectTimer = setTimeout(() => {
        if (activeServer === entry) connectTo(entry, false);
      }, 3000);
      return;
    }
    if (st?.supported && !st.running) {
      setServerStatus('your server is not running', true);
      renderPlaceholder(
        'This is the server you host on this computer, and it is not running.',
        [
          { label: 'Start hosting', primary: true, run: openHostPanel },
          { label: 'Try again', run: () => connectTo(entry, false) },
        ],
      );
      return;
    }
    if (st?.running && st.relay_url && st.relay_url !== entry.url) {
      migrateServerUrl(entry, st.relay_url);
    }
  }

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
    serverReady = true;
    reconnectAttempt = 0;
    setServerStatus(isUnprotectedCleartext(entry.url) ? 'online — unencrypted (ws://)' : 'online');
    openMetaSubscriptions(c, entry);
    if (activeChannel) subscribeChannel(activeChannel);
    renderChannels();
    updateComposerState();
    maybeAdoptRelayName(entry, wsUrl);
    // Asked here rather than at launch: a permission prompt before you have
    // even joined a server is a prompt with no context, and gets denied.
    notify.ensurePermission();
  };

  c.onauthchallenge = async (challenge) => {
    clearTimeout(graceTimer);
    if (conn !== c) return;
    try {
      if (!ready) setServerStatus('authenticating…');
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
        renderPlaceholder('This invite was rejected: ' + r.msg);
        return;
      }
      setServerStatus('access denied: ' + result.msg, true);
      renderPlaceholder(
        'This server did not let you in: ' + result.msg +
        '\n\nAsk the operator for an invite link, or send them your npub.',
        [{ label: 'Copy my npub', run: async () => {
          await copyText(nip19.npubEncode(signer.pubkey));
          toast('npub copied');
        } }],
      );
    } catch (e) {
      setServerStatus('sign failed: ' + (e.message || e), true);
    }
  };

  c.onclose = () => {
    if (conn !== c) return;
    serverReady = false;
    renderChannels();
    updateComposerState();
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
  if (activeServer && activeServer !== entry) {
    // Leaving: freeze its unread count so the rail badge survives the switch.
    cachedUnread.set(activeServer.url, unreadForServer());
  }
  activeServer = entry;
  localStorage.setItem('menhir-last-server', entry.url);
  connectTo(entry, false);
};

/** Follow a self-hosted relay to a new port, cache and all. */
function migrateServerUrl(entry, newUrl) {
  store.renameServer(entry.url, newUrl);
  const old = entry.url;
  entry.url = newUrl;
  saveServers();
  if (localStorage.getItem('menhir-last-server') === old) {
    localStorage.setItem('menhir-last-server', newUrl);
  }
  renderRail();
}

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

function openMetaSubscriptions(c, entry) {
  c.req([{ kinds: [KIND.META], limit: 500 }], {
    onevent: (ev) => {
      const id = ev.tags.find((t) => t[0] === 'd')?.[1];
      if (!id) return;
      channels.set(id, {
        id,
        name: ev.tags.find((t) => t[0] === 'name')?.[1] || id,
        about: ev.tags.find((t) => t[0] === 'about')?.[1] || '',
        // No `t` tag means an ordinary chat channel: relays that predate
        // channel types publish metadata without one.
        type: ev.tags.find((t) => t[0] === 't')?.[1] === PUBLICATION_CHANNEL
          ? PUBLICATION_CHANNEL
          : CHAT_CHANNEL,
      });
      renderChannels();
      if (id === activeChannel) {
        renderChatHeader();
        renderMessages(id);
        updateComposerState();
      }
    },
    oneose: () => {
      store.saveChannels(entry.url, [...channels.values()]);
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

  // Who may administer what — drives the channel settings button, and who is
  // allowed to post in a publication channel.
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
      if (id === activeChannel) {
        refreshAdminAffordance();
        updateComposerState();
      }
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
    oneose: () => store.saveProfiles(entry.url, Object.fromEntries(profiles)),
  });
}

// ---------- channels & messages ----------

const channelType = (id) => channels.get(id)?.type || CHAT_CHANNEL;

/** Unread count for a channel, from the local read mark. */
function unreadCount(id) {
  return store.unreadIn(messages.get(id) || [], readState[id] || 0, signer?.pubkey);
}

/** Total unread across the connected server, for the rail badge. */
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
  if (!activeServer) return;
  activeChannel = id;
  clearReply();
  renderChannels();
  renderChatHeader();
  show($('composer'));
  refreshAdminAffordance();
  if (isMobile()) showPane('chat');

  // Cache first: the channel is readable before the relay says anything.
  if (!messages.has(id)) messages.set(id, store.loadMessages(activeServer.url, id));
  renderMessages(id);
  updateComposerState();
  markRead(id);

  if (conn && serverReady) subscribeChannel(id);
}

function renderChatHeader() {
  const ch = channels.get(activeChannel);
  const publication = channelType(activeChannel) === PUBLICATION_CHANNEL;
  setText($('chat-title'), (publication ? '▤ ' : '#') + (ch?.name || activeChannel || ''));
  setText($('chat-about'), ch?.about || '');
}

/** (Re)subscribe to a channel, resuming from the newest event already held. */
function subscribeChannel(id) {
  if (msgSubId) conn.closeSub(msgSubId);
  const cached = messages.get(id) || [];
  const since = store.resumeSince(cached);
  const filter = { kinds: [KIND.CHAT], '#h': [id], limit: 200 };
  if (since !== undefined) filter.since = since;

  let batch = [];
  // Captured rather than read from `msgSubId` later: switching channels
  // quickly used to let one channel's EOSE rewire the *next* channel's
  // subscription, filing its messages under the wrong id.
  const subId = conn.req([filter], {
    onevent: (ev) => batch.push(ev),
    oneose: () => {
      ingest(id, batch);
      batch = [];
      if (msgSubId !== subId) return; // superseded while the backfill ran
      // Everything after EOSE is live: render as it lands, and only from here
      // is a message worth a notification — backfilled history is not news.
      liveChannels.add(id);
      const handlers = conn.subs.get(subId);
      if (handlers) handlers.onevent = (ev) => ingest(id, [ev]);
    },
    onclosed: (msg) => setServerStatus('subscription closed: ' + msg, true),
  });
  msgSubId = subId;
}

/** Merge events into a channel, persist, and repaint if it is on screen. */
function ingest(channelId, incoming) {
  if (!incoming.length || !activeServer) return;
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

/**
 * A placeholder with something to press.
 *
 * Used wherever the app would otherwise state a dead end — "your server is not
 * running", "this server did not let you in" — because the useful next step is
 * always one button away and hiding it in prose helps nobody.
 */
function renderPlaceholder(text, actions = []) {
  clearChat(text);
  if (!actions.length) return;
  const row = document.createElement('div');
  row.className = 'placeholder-actions';
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.className = 'pill' + (action.primary ? ' primary' : '');
    btn.textContent = action.label;
    btn.onclick = action.run;
    row.appendChild(btn);
  }
  $('messages').appendChild(row);
}

// ---------- message rendering ----------

/** The event a message replies to, per NIP-10's marked form. */
function replyParentId(ev) {
  return ev.tags?.find((t) => t[0] === 'e' && t[3] === 'reply')?.[1] || null;
}

const authorName = (pubkey) => profiles.get(pubkey) || shortNpub(pubkey);

function renderMessages(channelId) {
  const box = $('messages');
  const list = messages.get(channelId) || [];
  // Only auto-scroll when already near the bottom, so reading history is not
  // yanked away every time a message arrives.
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;

  box.innerHTML = '';
  if (!list.length) {
    clearChat(
      channelType(channelId) === PUBLICATION_CHANNEL
        ? 'Nothing published here yet.'
        : 'No messages yet — say something.',
    );
    return;
  }

  const byId = new Map(list.map((ev) => [ev.id, ev]));
  if (channelType(channelId) === PUBLICATION_CHANNEL) {
    renderPublication(box, list, byId);
  } else {
    for (const ev of list) box.appendChild(renderMessage(ev, byId));
  }
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

/**
 * Publication layout: each post is a card, with its replies underneath.
 *
 * A reply whose post is not in the loaded window (or which points at
 * something that was deleted) is shown on its own rather than dropped —
 * losing someone's message because its parent scrolled out of the cache
 * would be worse than showing it out of context.
 */
function renderPublication(box, list, byId) {
  // Everything under a post is shown flat beneath it, however deep the reply
  // chain goes — an answer to an answer belongs to the same post, and nesting
  // it a level further would only make a narrow column narrower.
  const rootOf = (ev) => {
    let cur = ev;
    const seen = new Set([ev.id]);
    for (;;) {
      const parentId = replyParentId(cur);
      const parent = parentId ? byId.get(parentId) : null;
      if (!parent || seen.has(parent.id)) return cur;
      seen.add(parent.id);
      cur = parent;
    }
  };

  const repliesByParent = new Map();
  const roots = [];
  for (const ev of list) {
    const root = rootOf(ev);
    if (root === ev) {
      roots.push(ev);
    } else {
      if (!repliesByParent.has(root.id)) repliesByParent.set(root.id, []);
      repliesByParent.get(root.id).push(ev);
    }
  }
  for (const post of roots) {
    const card = document.createElement('article');
    card.className = 'post';
    card.appendChild(renderMessage(post, byId, { post: true }));
    const replies = repliesByParent.get(post.id) || [];
    if (replies.length) {
      const wrap = document.createElement('div');
      wrap.className = 'post-replies';
      for (const r of replies) wrap.appendChild(renderMessage(r, byId));
      card.appendChild(wrap);
    }
    box.appendChild(card);
  }
}

function renderMessage(ev, byId, { post = false } = {}) {
  const div = document.createElement('div');
  div.className = 'msg' + (ev.pubkey === signer?.pubkey ? ' mine' : '') + (post ? ' post-body' : '');
  div.dataset.pubkey = ev.pubkey;
  div.dataset.id = ev.id;

  const parentId = replyParentId(ev);
  const parent = parentId ? byId.get(parentId) : null;
  if (parent) {
    // A quoted line rather than the whole parent: enough to know what this
    // answers, and clicking it jumps to the original.
    const quote = document.createElement('button');
    quote.className = 'reply-quote';
    const who = document.createElement('span');
    who.className = 'reply-quote-who';
    who.textContent = authorName(parent.pubkey);
    const what = document.createElement('span');
    what.className = 'reply-quote-text';
    what.textContent = parent.content.replace(/\s+/g, ' ').slice(0, 120);
    quote.append(who, what);
    quote.onclick = () => jumpToMessage(parent.id);
    div.appendChild(quote);
  } else if (parentId) {
    const missing = document.createElement('div');
    missing.className = 'reply-quote missing';
    missing.textContent = 'in reply to a message that is not loaded';
    div.appendChild(missing);
  }

  const head = document.createElement('div');
  head.className = 'msg-head';
  const author = document.createElement('span');
  author.className = 'author';
  author.textContent = authorName(ev.pubkey);
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = post ? fmtDateTime(ev.created_at) : fmtTime(ev.created_at);
  time.title = new Date(ev.created_at * 1000).toLocaleString();
  const replyBtn = document.createElement('button');
  replyBtn.className = 'msg-reply-btn';
  replyBtn.textContent = '↩ reply';
  replyBtn.title = 'Reply to this message';
  replyBtn.onclick = () => startReply(ev);
  head.append(author, time, replyBtn);

  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = ev.content; // plain text only — never innerHTML

  div.append(head, body);
  return div;
}

function jumpToMessage(id) {
  const el = document.querySelector(`#messages .msg[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1200);
}

function renderMessageAuthors() {
  for (const div of document.querySelectorAll('#messages .msg[data-pubkey]')) {
    const name = profiles.get(div.dataset.pubkey);
    if (name) setText(div.querySelector('.author'), name);
  }
}

// ---------- composing ----------

function startReply(ev) {
  replyTo = ev;
  setText($('reply-strip-who'), authorName(ev.pubkey));
  setText($('reply-strip-text'), ev.content.replace(/\s+/g, ' ').slice(0, 120));
  show($('reply-strip'));
  updateComposerState();
  $('composer-input').focus();
}

function clearReply() {
  replyTo = null;
  hide($('reply-strip'));
  updateComposerState();
}

/**
 * Decide whether the composer can be used, and say why when it cannot.
 *
 * The only real restriction is a publication channel, where the relay refuses
 * a top-level post from anyone but an admin. Rather than let someone type a
 * message and have it bounce, the box says up front that a reply is the way in.
 */
function updateComposerState() {
  const input = $('composer-input');
  const send = $('send-btn');
  const note = $('composer-note');
  if (!activeChannel) {
    hide($('composer'));
    return;
  }
  const publication = channelType(activeChannel) === PUBLICATION_CHANNEL;
  const admin = isAdminOf(activeChannel);
  let reason = '';
  if (!conn || !serverReady) reason = 'Not connected to this server yet.';
  else if (publication && !admin && !replyTo) {
    reason = 'Only admins publish here. Press ↩ reply on a post to join the discussion.';
  }
  const blocked = !!reason;
  input.disabled = blocked;
  send.disabled = blocked;
  input.placeholder = publication && admin && !replyTo
    ? 'Publish a post… (plain text)'
    : 'Message… (plain text)';
  setText(note, reason);
  note.classList.toggle('hidden', !blocked);
  $('emoji-btn').disabled = blocked;
}

async function sendMessage() {
  const input = $('composer-input');
  const text = input.value.trim();
  if (!text || !activeChannel) return;
  if (!conn || conn.dead || !serverReady) {
    setServerStatus('not connected — message kept in the box', true);
    return;
  }
  const parent = replyTo;
  input.value = '';
  input.style.height = 'auto';
  try {
    const tags = [['h', activeChannel]];
    if (parent) {
      // NIP-10 marked reply, the shape obelisk publishes and the relay checks.
      tags.push(['e', parent.id, '', 'reply'], ['p', parent.pubkey]);
    }
    const ev = await signer.sign({ kind: KIND.CHAT, tags, content: text });
    const { ok, msg } = await conn.publish(ev);
    if (!ok) {
      setServerStatus('send failed: ' + msg, true);
      toast(msg || 'the server refused that message', 'error');
      input.value = text;
      return;
    }
    clearReply();
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
    const label = (entry.label || entry.url.replace(/^wss?:\/\//, '') || '?').trim() || '?';
    if (entry.local) {
      // The server you host is the one you look for first — give it the mark
      // rather than an initial.
      btn.innerHTML = OBELISK_SVG;
      btn.classList.add('is-local');
    } else {
      btn.textContent = label[0].toUpperCase();
    }
    btn.title = `${label}\n${entry.url}`;
    const unread = entry === activeServer ? unreadForServer() : (cachedUnread.get(entry.url) || 0);
    if (unread > 0) btn.classList.add('has-unread');
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
    const mark = document.createElement('span');
    mark.className = 'channel-mark';
    mark.innerHTML = ch.type === PUBLICATION_CHANNEL ? PUBLICATION_SVG : CHAT_SVG;
    const label = document.createElement('span');
    label.className = 'channel-label';
    label.textContent = ch.name;
    div.append(mark, label);
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
  // Anyone the server admits may open a channel — but only once it has
  // actually admitted us, or the button offers something that will bounce.
  $('create-channel-btn').classList.toggle('hidden', !serverReady);
}

// ---------- mobile panes ----------

const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
const showPane = (which) => document.body.classList.toggle('show-chat', which === 'chat');

// ---------- servers ----------

function defaultLabel(url) {
  const host = url.replace(/^wss?:\/\//, '').split('/')[0].split(':')[0];
  // An onion address makes a meaningless label; say so rather than showing
  // sixteen random characters, until the relay tells us its real name.
  if (host.endsWith('.onion')) return 'Onion server';
  if (!host) return 'Server';
  return host.length > 18 ? host.slice(0, 16) + '…' : host;
}

function addServer(url, invite, name, { local = false } = {}) {
  let entry = servers.find((s) => s.url === url);
  if (!entry) {
    entry = {
      url,
      label: (name || '').trim() || defaultLabel(url),
      invite,
      custom: !!(name || '').trim(),
      local,
    };
    servers.push(entry);
  } else {
    if (invite) entry.invite = invite;
    if (local) entry.local = true;
    if ((name || '').trim()) {
      entry.label = name.trim();
      entry.custom = true;
    }
  }
  saveServers();
  renderRail();
  selectServer(entry);
  return entry;
}

function openServerSettings(entry) {
  const target = entry || activeServer;
  if (!target) return;
  hide($('server-settings-error'));
  $('server-rename').value = target.custom ? target.label : '';
  $('server-rename').placeholder = target.label || 'Server name';
  setText($('server-address'), target.url);
  $('server-settings-modal').dataset.url = target.url;
  openModal('server-settings-modal', { focus: 'server-rename' });
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
  closeModal('server-settings-modal');
}

async function removeServer() {
  const url = $('server-settings-modal').dataset.url;
  const entry = servers.find((s) => s.url === url);
  if (!entry) return;
  const yes = await confirmAsk({
    title: `Remove ${entry.label}?`,
    body: 'It disappears from your list and its cached messages are deleted from this device. Nothing on the server itself changes — an invite (or your whitelisting) gets you back in.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!yes) return;
  servers = servers.filter((s) => s !== entry);
  saveServers();
  store.forgetServer(entry.url);
  cachedUnread.delete(entry.url);
  closeModal('server-settings-modal');
  if (activeServer === entry) {
    stopReconnect();
    conn?.destroy();
    conn = null;
    serverReady = false;
    activeServer = null;
    channels = new Map();
    messages = new Map();
    activeChannel = null;
    localStorage.removeItem('menhir-last-server');
    renderChannels();
    hide($('composer'));
    clearChat('Pick a server, or add one with +.');
    setText($('server-name'), '—');
    setServerStatus('not connected');
    hide($('server-qr-btn'));
    hide($('server-settings-btn'));
    if (servers.length) selectServer(servers[0]);
  }
  renderRail();
  toast('Server removed');
}

// ---------- QR ----------

let currentQrText = '';

async function showQR(title, text) {
  currentQrText = text;
  hide($('qr-note'));
  setText($('qr-title'), title);
  setText($('qr-text'), text);
  openModal('qr-modal');
  try {
    await renderQR($('share-qr'), text, 240);
  } catch (e) {
    setText($('qr-text'), 'Could not render a QR: ' + (e.message || e));
  }
}

/**
 * Share the active server as a QR.
 *
 * A loopback address is meaningless to anyone else, so when this is our own
 * hosted relay we substitute the address it is published under — the onion
 * first, then the LAN. If there is neither, say plainly that the link goes
 * nowhere rather than handing over a QR for 127.0.0.1.
 */
async function shareActiveServer() {
  if (!activeServer) return;
  let url = activeServer.url;

  if (isLoopback(url) && tauriInvoke) {
    const st = await readHostStatus();
    if (st?.onion) url = 'ws://' + st.onion;
    else if (st?.lan_url) url = st.lan_url;
  }

  if (isLoopback(url)) {
    setText($('qr-title'), 'This server is local only');
    setText($('qr-text'), url);
    currentQrText = url;
    setText(
      $('qr-note'),
      'This address only works on this computer, so a QR of it is no use to anyone else. Publish it through Tor, or tick "also listen on my network", to get a shareable address.',
    );
    show($('qr-note'));
    openModal('qr-modal');
    try { await renderQR($('share-qr'), url, 240); } catch {}
    return;
  }
  hide($('qr-note'));
  await showQR('Share this server', `obelisk://join?relay=${url}`);
}

async function openScanner() {
  hide($('add-server-error'));
  hide($('scan-error'));
  openModal('scan-modal');
  try {
    stopScanner = await startScanner(
      $('scan-video'),
      $('scan-canvas'),
      (text) => {
        stopScanner = null;
        closeModal('scan-modal');
        try {
          const { url, invite } = parseServerInput(text);
          closeModal('add-server-modal');
          addServer(url, invite, $('add-server-name').value);
          $('add-server-name').value = '';
        } catch (e) {
          $('add-server-input').value = text;
          showError('add-server-error', e);
        }
      },
      (e) => showError('scan-error', e),
    );
  } catch (e) {
    showError('scan-error', e);
  }
}

function closeScanner() {
  stopScanner?.();
  stopScanner = null;
}

// ---------- channel administration ----------

function openChannelAdmin() {
  if (!activeChannel || !isAdminOf(activeChannel)) return;
  const ch = channels.get(activeChannel);
  hide($('ca-error'));
  $('ca-name').value = ch?.name || '';
  $('ca-about').value = ch?.about || '';
  const type = ch?.type === PUBLICATION_CHANNEL ? PUBLICATION_CHANNEL : CHAT_CHANNEL;
  for (const radio of document.querySelectorAll('input[name="ca-type"]')) {
    radio.checked = radio.value === type;
  }
  renderChannelMembers();
  openModal('channel-admin-modal', { focus: 'ca-name' });
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
    if (!conn || !serverReady) throw new Error('not connected to this server');
    const ev = await signer.sign({ kind, tags, content: '' });
    const { ok, msg } = await conn.publish(ev);
    if (!ok) throw new Error(msg);
    return true;
  } catch (e) {
    showError(errEl, e);
    return false;
  }
}

async function setRole(pubkey, role) {
  const ok = await adminPublish(KIND.PUT_USER, [
    ['h', activeChannel],
    ['p', pubkey, role],
  ]);
  if (ok) {
    toast(role === 'admin' ? 'Now an admin' : 'No longer an admin');
    setTimeout(renderChannelMembers, 400);
  }
}

async function removeMember(pubkey) {
  const yes = await confirmAsk({
    title: 'Remove this member?',
    body: `${authorName(pubkey)} leaves this channel's member list. They can rejoin if the server still admits them.`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!yes) return;
  const ok = await adminPublish(KIND.REMOVE_USER, [
    ['h', activeChannel],
    ['p', pubkey],
  ]);
  if (ok) setTimeout(renderChannelMembers, 400);
}

// ---------- hosting (desktop only) ----------

let hostPollTimer = null;
let lastInvite = null;

function openHostPanel() {
  if (!tauriInvoke) return;
  hide($('host-error'));
  openModal('host-modal');
  refreshHostPanel();
  clearInterval(hostPollTimer);
  hostPollTimer = setInterval(refreshHostPanel, 3000);
  // However the panel is dismissed — button, backdrop, Escape — stop polling.
  onModalClose('host-modal', () => clearInterval(hostPollTimer));
}

/** Why hosting cannot start with the boxes as they are ticked, if it cannot. */
function hostBlockReason(st) {
  const useTor = $('host-use-tor').checked;
  const clearnet = $('host-clearnet').checked;
  if (!useTor && !clearnet) {
    return 'Pick at least one way to be reachable — otherwise the server can only talk to this computer.';
  }
  if (useTor && !clearnet && !st.tor_available) {
    return 'Tor is not installed, so an onion address is not available. Install it, or tick "also listen on my network".';
  }
  return '';
}

async function refreshHostPanel() {
  if (!tauriInvoke) return;
  try {
    const st = await tauriInvoke('host_status');
    hostStatus = st;
    tagLocalServers();

    // A start in flight is neither state: showing the form would offer a
    // button that cannot do anything, and showing the running panel would
    // claim an address that does not exist yet.
    $('host-starting').classList.toggle('hidden', !st.starting);
    if (st.starting) {
      hide($('host-stopped'));
      hide($('host-running'));
      return;
    }

    // The warning explains; it never hides the form. Hiding it used to trap
    // people whose only fix was to untick the very box that had vanished.
    const useTor = $('host-use-tor').checked;
    $('host-tor-warning').classList.toggle('hidden', st.tor_available || !useTor);
    const blocked = hostBlockReason(st);
    setText($('host-start-note'), blocked);
    $('host-start-note').classList.toggle('hidden', !blocked);
    $('host-start-btn').disabled = !!blocked;

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

      renderInviteList(st.invites || []);

      renderWhitelist(st.whitelist);
    } else {
      show($('host-stopped'));
      hide($('host-running'));
    }
  } catch (e) {
    hostError(e);
  }
}

/**
 * Rebuild a list only when it changed.
 *
 * This panel polls every three seconds, and a list that throws away its DOM
 * that often is a list you cannot scroll or hover — it jumps back to the top
 * under your cursor.
 */
function listChanged(box, signature) {
  if (box.dataset.signature === signature) return false;
  box.dataset.signature = signature;
  box.innerHTML = '';
  return true;
}

function renderWhitelist(whitelist) {
  const wl = $('host-wl-list');
  if (!listChanged(wl, whitelist.join(','))) return;
  for (const npub of whitelist) {
    const row = document.createElement('div');
    row.className = 'wl-item';
    const code = document.createElement('code');
    code.textContent = npub.slice(0, 16) + '…' + npub.slice(-6);
    code.title = npub;
    const del = document.createElement('button');
    del.textContent = 'remove';
    del.onclick = async () => {
      const yes = await confirmAsk({
        title: 'Remove from the whitelist?',
        body: `${npub.slice(0, 16)}… loses access immediately. They need a new invite to come back.`,
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!yes) return;
      try {
        await tauriInvoke('host_whitelist_remove', { pubkey: npub });
        toast('Removed from the whitelist');
        refreshHostPanel();
      } catch (e) { hostError(e); }
    };
    row.append(code, del);
    wl.appendChild(row);
  }
}

function renderInviteList(invites) {
  const box = $('host-invite-list');
  $('host-revoke-all').classList.toggle('hidden', !invites.length);
  const signature = invites.map((i) => `${i.code}:${i.uses}/${i.max_uses}`).join(',');
  if (!listChanged(box, signature)) return;
  for (const inv of invites) {
    const row = document.createElement('div');
    row.className = 'wl-item';
    const code = document.createElement('code');
    const left = inv.max_uses - inv.uses;
    const expiry = inv.expires_at
      ? ` · until ${new Date(inv.expires_at * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      : '';
    code.textContent = `${inv.code}  ${left} of ${inv.max_uses} left${expiry}`;
    const actions = document.createElement('div');
    actions.className = 'row gap';
    const qr = document.createElement('button');
    qr.className = 'link-btn';
    qr.textContent = 'QR';
    qr.onclick = () => showQR('Invite — scan to join', inviteLink(inv.code));
    const revoke = document.createElement('button');
    revoke.textContent = 'revoke';
    revoke.onclick = async () => {
      try {
        await tauriInvoke('host_invite_revoke', { code: inv.code });
        toast('Invite revoked');
        refreshHostPanel();
      } catch (e) { hostError(e); }
    };
    actions.append(qr, revoke);
    row.append(code, actions);
    box.appendChild(row);
  }
}

/** The share link for an invite code, against the best address we have. */
function inviteLink(code) {
  const relay = hostStatus?.onion
    ? 'ws://' + hostStatus.onion
    : hostStatus?.lan_url || hostStatus?.relay_url || '';
  return `obelisk://join?relay=${relay}&invite=${code}`;
}

function hostError(e) {
  const el = $('host-error');
  const text = String(e?.message || e || '');
  setText(el, text);
  el.classList.toggle('hidden', !text);
  // The panel is tall; an error pinned to its bottom is easy to miss.
  if (text) toast(text, 'error');
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

function showSettingsTab(name) {
  for (const tab of document.querySelectorAll('.settings-tab')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.settings-panel')) {
    panel.classList.toggle('hidden', panel.dataset.panel !== name);
  }
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
  showSettingsTab('profile');
  openModal('profile-modal', { focus: 'profile-name' });
}

async function saveProfile() {
  const name = $('profile-name').value.trim();
  const about = $('profile-about').value.trim();
  hide($('profile-saved'));
  if (!name) return showError('profile-error', 'pick a display name');
  if (!conn || !serverReady) {
    return showError('profile-error', 'connect to a server first — your profile is published to it');
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
    toast('Profile saved');
  } catch (e) {
    showError('profile-error', e);
  }
}

async function logOut() {
  const yes = await confirmAsk({
    title: 'Log out?',
    body: 'If you signed in with a secret key, make sure it is backed up — logging out removes it from this device, and it cannot be recovered.',
    confirmLabel: 'Log out',
    danger: true,
  });
  if (!yes) return;
  store.flushWrites();
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
  // Unread for every server we are not about to connect to, so the rail is
  // honest the moment the app opens.
  for (const s of servers) {
    cachedUnread.set(s.url, store.cachedUnreadForServer(s.url, signer.pubkey));
  }
  renderRail();
  renderChannels();
  showPane('channels');
  clearChat(servers.length ? 'Pick a server on the left.' : 'Add a server with +, or host your own.');
  if (tauriInvoke) {
    readHostStatus().then((st) => {
      if (st?.supported) show($('host-btn'));
      renderRail();
    });
  }
  if (servers.length) {
    const last = localStorage.getItem('menhir-last-server');
    selectServer(servers.find((s) => s.url === last) || servers[0]);
  }
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

  // Enter submits the pane you are in.
  $('login-nsec').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('login-nsec-go').click(); }
  });
  $('bunker-uri').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('bunker-go').click(); }
  });
}

function wireApp() {
  // Escape and backdrop clicks close panels; the scanner has to release the
  // camera on its way out, whichever way it is dismissed.
  wireModals((id) => {
    if (id === 'scan-modal') closeScanner();
    return true;
  });

  $('logout-btn').onclick = logOut;
  $('logout-btn-settings').onclick = logOut;

  // servers
  $('add-server-btn').onclick = () => {
    hide($('add-server-error'));
    openModal('add-server-modal', { focus: 'add-server-input' });
  };
  $('add-server-confirm').onclick = () => {
    try {
      const { url, invite } = parseServerInput($('add-server-input').value);
      closeModal('add-server-modal');
      const name = $('add-server-name').value;
      $('add-server-input').value = '';
      $('add-server-name').value = '';
      addServer(url, invite, name);
    } catch (e) {
      showError('add-server-error', e);
    }
  };
  $('add-server-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('add-server-confirm').click(); }
  });
  $('scan-qr-btn').onclick = openScanner;
  $('qr-copy').onclick = async () => { await copyText(currentQrText); flash($('qr-copy')); };
  $('server-qr-btn').onclick = () => shareActiveServer();
  $('server-settings-btn').onclick = () => openServerSettings(activeServer);
  $('server-rename-save').onclick = saveServerName;
  $('server-remove').onclick = removeServer;
  $('server-rename').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveServerName(); }
  });

  // settings
  $('me-box').onclick = openSettings;
  for (const tab of document.querySelectorAll('.settings-tab')) {
    tab.onclick = () => showSettingsTab(tab.dataset.tab);
  }
  $('profile-save').onclick = saveProfile;
  $('copy-npub').onclick = async () => {
    await copyText(nip19.npubEncode(signer.pubkey));
    flash($('copy-npub'));
  };
  $('reveal-nsec').onclick = async () => {
    if (signer.kind !== 'nsec') return;
    const yes = await confirmAsk({
      title: 'Show your secret key?',
      body: 'It will appear on screen. Anyone who reads it — over your shoulder, in a screenshot — becomes you.',
      confirmLabel: 'Show it',
      danger: true,
    });
    if (!yes) return;
    setText($('nsec-value'), signer.nsec());
    show($('nsec-box'));
  };
  $('copy-nsec').onclick = async () => {
    await copyText($('nsec-value').textContent);
    flash($('copy-nsec'));
  };
  $('clear-cache').onclick = async () => {
    const yes = await confirmAsk({
      title: 'Delete cached messages?',
      body: 'Only on this device. Channels re-fetch their recent history from each server the next time you open them.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!yes) return;
    for (const s of servers) store.forgetServer(s.url);
    messages = new Map();
    cachedUnread.clear();
    setText($('cache-size'), approximateCacheSize());
    if (activeChannel) renderMessages(activeChannel);
    renderRail();
    toast('Cached messages deleted');
  };

  // channels
  $('create-channel-btn').onclick = () => {
    hide($('cc-error'));
    openModal('create-channel-modal', { focus: 'cc-id' });
  };
  $('cc-confirm').onclick = async () => {
    const id = $('cc-id').value.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,64}$/.test(id)) {
      return showError('cc-error', 'id must be 1-64 characters of a-z 0-9 - _');
    }
    const tags = [['h', id]];
    if ($('cc-name').value.trim()) tags.push(['name', $('cc-name').value.trim()]);
    if ($('cc-about').value.trim()) tags.push(['about', $('cc-about').value.trim()]);
    tags.push(['t', document.querySelector('input[name="cc-type"]:checked')?.value || CHAT_CHANNEL]);
    if (await adminPublish(KIND.CREATE_GROUP, tags, 'cc-error')) {
      closeModal('create-channel-modal');
      $('cc-id').value = $('cc-name').value = $('cc-about').value = '';
      document.querySelector('input[name="cc-type"][value="chat"]').checked = true;
      toast('Channel created');
      setTimeout(() => selectChannel(id), 400);
    }
  };

  // channel administration
  $('channel-admin-btn').onclick = openChannelAdmin;
  $('ca-save').onclick = async () => {
    const tags = [['h', activeChannel], ['name', $('ca-name').value.trim() || activeChannel]];
    if ($('ca-about').value.trim()) tags.push(['about', $('ca-about').value.trim()]);
    tags.push(['t', document.querySelector('input[name="ca-type"]:checked')?.value || CHAT_CHANNEL]);
    if (await adminPublish(KIND.EDIT_METADATA, tags)) {
      closeModal('channel-admin-modal');
      toast('Channel updated');
    }
  };
  $('ca-delete').onclick = async () => {
    const id = activeChannel;
    const yes = await confirmAsk({
      title: `Delete #${id}?`,
      body: 'Every message in it is erased from the server, and the id is retired — it can never be created again here.',
      confirmLabel: 'Delete channel',
      danger: true,
    });
    if (!yes) return;
    if (await adminPublish(KIND.DELETE_GROUP, [['h', id]])) {
      channels.delete(id);
      messages.delete(id);
      store.saveChannels(activeServer.url, [...channels.values()]);
      closeModal('channel-admin-modal');
      activeChannel = null;
      renderChannels();
      clearChat('Channel deleted.');
      hide($('composer'));
      refreshAdminAffordance();
      toast('Channel deleted');
    }
  };

  // composer
  $('send-btn').onclick = sendMessage;
  $('reply-cancel').onclick = clearReply;
  const input = $('composer-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile()) { e.preventDefault(); sendMessage(); }
    if (e.key === 'Escape' && replyTo) { e.preventDefault(); clearReply(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  wireEmojiPicker();

  $('back-btn').onclick = () => showPane('channels');

  // hosting
  $('host-btn').onclick = openHostPanel;
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
      toast('Your server is running');
      // If the local server was the one selected, it is reachable now.
      if (activeServer?.local) connectTo(activeServer, false);
    } catch (e) {
      hostError(e);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Start hosting';
    }
  };
  $('host-stop-btn').onclick = async () => {
    const yes = await confirmAsk({
      title: 'Stop hosting?',
      body: 'Your server goes offline for everyone until you start it again. The onion address, the messages and the whitelist all stay on this computer.',
      confirmLabel: 'Stop hosting',
      danger: true,
    });
    if (!yes) return;
    try {
      await tauriInvoke('host_stop');
      await refreshHostPanel();
      toast('Hosting stopped');
    } catch (e) { hostError(e); }
  };
  $('host-invite-btn').onclick = async () => {
    try {
      const hours = $('host-invite-expiry').value;
      const inv = await tauriInvoke('host_invite_create', {
        maxUses: Number($('host-invite-uses').value) || 1,
        expiresHours: hours ? Number(hours) : null,
      });
      lastInvite = inv.share_link || inv.code;
      setText($('host-invite-out'), lastInvite);
      show($('host-invite-out'));
      show($('host-invite-qr'));
      show($('host-invite-copy'));
      toast('Invite created');
      refreshHostPanel();
    } catch (e) { hostError(e); }
  };
  $('host-invite-qr').onclick = () => { if (lastInvite) showQR('Invite — scan to join', lastInvite); };
  $('host-invite-copy').onclick = async () => {
    if (!lastInvite) return;
    await copyText(lastInvite);
    flash($('host-invite-copy'));
  };
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
      const st = await readHostStatus();
      // Loopback, deliberately: dialling our own onion would send the traffic
      // out through a Tor circuit and back, which is slow and needs Tor up
      // just to talk to a relay running on this very machine.
      const url = st?.relay_url;
      if (!url) return hostError('the relay is not running');
      closeModal('host-modal');
      addServer(url, null, $('host-name').value.trim() || st.name, { local: true });
    } catch (e) { hostError(e); }
  };
  $('host-locked').onchange = async (e) => {
    try { await tauriInvoke('host_set_locked', { locked: e.target.checked }); await refreshHostPanel(); }
    catch (err) { hostError(err); refreshHostPanel(); }
  };
  $('host-revoke-all').onclick = async () => {
    const yes = await confirmAsk({
      title: 'Revoke every invite?',
      body: 'Every code you have handed out stops working, including links already sent. Nobody already admitted is affected.',
      confirmLabel: 'Revoke all',
      danger: true,
    });
    if (!yes) return;
    try {
      // `code: null` is the revoke-everything form of this command.
      await tauriInvoke('host_invite_revoke', { code: null });
      lastInvite = null;
      hide($('host-invite-out'));
      hide($('host-invite-qr'));
      hide($('host-invite-copy'));
      await refreshHostPanel();
      toast('All invites revoked');
    } catch (e) { hostError(e); }
  };
  $('host-wl-add').onclick = async () => {
    const value = $('host-wl-input').value.trim();
    if (!value) return hostError('paste an npub first');
    try {
      await tauriInvoke('host_whitelist_add', { pubkey: value });
      $('host-wl-input').value = '';
      toast('Added to the whitelist');
      refreshHostPanel();
    } catch (e) { hostError(e); }
  };
  $('host-wl-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('host-wl-add').click(); }
  });

  trackKeyboard();

  // Mobile browsers kill pages without warning; flush pending cache writes.
  // Coming back to the app catches up the read mark for whatever is on screen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') store.flushWrites();
    else if (activeChannel) { renderMessages(activeChannel); markRead(activeChannel); }
  });
  window.addEventListener('focus', () => { if (activeChannel) markRead(activeChannel); });
  window.addEventListener('pagehide', () => store.flushWrites());
}

/** The emoji panel, anchored above the composer. */
function wireEmojiPicker() {
  const input = $('composer-input');
  emojiPicker = createEmojiPicker({
    onPick: (char) => {
      // Insert at the caret rather than appending: people reach for an emoji
      // mid-sentence as often as at the end.
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + char + input.value.slice(end);
      const caret = start + char.length;
      input.setSelectionRange(caret, caret);
      input.focus();
      input.dispatchEvent(new Event('input'));
    },
  });
  $('composer').appendChild(emojiPicker.element);
  $('emoji-btn').onclick = (e) => {
    e.stopPropagation();
    emojiPicker.toggle();
  };
  document.addEventListener('click', (e) => {
    if (!emojiPicker.isOpen()) return;
    if (emojiPicker.element.contains(e.target) || e.target === $('emoji-btn')) return;
    emojiPicker.close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && emojiPicker.isOpen()) {
      e.stopPropagation();
      emojiPicker.close();
    }
  }, true);
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
