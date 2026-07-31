// Local cache of relay-derived state, so the app has something to show the
// instant it opens and nothing to re-fetch after a dropped connection.
//
// This matters more here than in a typical chat client: a cold Tor circuit
// takes the better part of a minute, and mobile connections drop constantly.
// Without a cache every reconnect means staring at an empty channel.
//
// Keyed per server, so two relays never share history.

const PREFIX = 'menhir-cache/';
const MAX_MESSAGES = 300; // per channel
const WRITE_DEBOUNCE_MS = 400;

/** Stable, filesystem-safe-ish key for a relay URL. */
function serverKey(url) {
  return (url || '').replace(/^wss?:\/\//, '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (e) {
    // Quota exceeded: drop the oldest caches rather than breaking the app.
    if (e?.name === 'QuotaExceededError') {
      pruneOldest();
      try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch {}
    }
  }
}

/** Drop roughly the oldest half of cached channels when storage fills up. */
function pruneOldest() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(PREFIX + 'msgs/')) keys.push(k);
  }
  keys.sort();
  for (const k of keys.slice(0, Math.ceil(keys.length / 2))) {
    localStorage.removeItem(k);
  }
}

// ---------- messages ----------

/** key -> { timer, messages } for writes waiting out the debounce. */
const pendingWrites = new Map();

export function loadMessages(serverUrl, channelId) {
  const list = read(`msgs/${serverKey(serverUrl)}/${channelId}`, []);
  return Array.isArray(list) ? list : [];
}

/**
 * Persist a channel's messages. Debounced because a history backfill arrives
 * as a burst of individual events and each one would otherwise re-serialise
 * the whole list.
 */
export function saveMessages(serverUrl, channelId, messages) {
  const key = `msgs/${serverKey(serverUrl)}/${channelId}`;
  clearTimeout(pendingWrites.get(key)?.timer);
  // Keep the newest slice: old history is re-fetchable, recent context isn't.
  const payload = messages.slice(-MAX_MESSAGES);
  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    write(key, payload);
  }, WRITE_DEBOUNCE_MS);
  pendingWrites.set(key, { timer, payload });
}

/**
 * Write out anything still inside the debounce window, now.
 *
 * Called when the app is hidden — a mobile webview can be killed without
 * another chance to run, and cancelling the timers (as this once did) threw
 * away exactly the messages that had just arrived.
 */
export function flushWrites() {
  for (const [key, { timer, payload }] of pendingWrites) {
    clearTimeout(timer);
    write(key, payload);
  }
  pendingWrites.clear();
}

/**
 * Move a server's cache to a new URL.
 *
 * A relay you host yourself comes back on a different loopback port when its
 * usual one is taken, and the URL is the cache key — without this, every
 * restart that shifted the port looked like a server with no history.
 */
export function renameServer(oldUrl, newUrl) {
  const from = serverKey(oldUrl);
  const to = serverKey(newUrl);
  if (from === to) return;
  const moves = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(PREFIX)) continue;
    const rest = k.slice(PREFIX.length);
    // `msgs/<server>/<channel>` and `chans|profiles|read/<server>`.
    const parts = rest.split('/');
    if (parts[1] === from) {
      parts[1] = to;
      moves.push([k, PREFIX + parts.join('/')]);
    }
  }
  for (const [oldKey, newKey] of moves) {
    const value = localStorage.getItem(oldKey);
    if (value !== null) {
      try { localStorage.setItem(newKey, value); } catch {}
    }
    localStorage.removeItem(oldKey);
  }
}

/** Unread count for a server that is not connected, straight from the cache. */
export function cachedUnreadForServer(serverUrl, myPubkey) {
  const readState = loadReadState(serverUrl);
  let n = 0;
  for (const ch of loadChannels(serverUrl)) {
    n += unreadIn(loadMessages(serverUrl, ch.id), readState[ch.id] || 0, myPubkey);
  }
  return n;
}

/**
 * Merge relay events into a cached list: dedupe by id, sort by time.
 * Returns a new array; the inputs are not mutated.
 */
export function mergeMessages(cached, incoming) {
  const byId = new Map();
  for (const ev of cached) byId.set(ev.id, ev);
  for (const ev of incoming) byId.set(ev.id, ev);
  return [...byId.values()].sort(
    (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1),
  );
}

/**
 * Where to resume a subscription from: the newest cached timestamp, minus a
 * little overlap so events that shared that second are not missed. Returns
 * undefined when there is nothing cached, meaning "fetch recent history".
 */
export function resumeSince(messages) {
  if (!messages.length) return undefined;
  const newest = messages[messages.length - 1].created_at;
  return Math.max(0, newest - 60);
}

// ---------- channels ----------

export function loadChannels(serverUrl) {
  const list = read(`chans/${serverKey(serverUrl)}`, []);
  return Array.isArray(list) ? list : [];
}

export function saveChannels(serverUrl, channels) {
  write(`chans/${serverKey(serverUrl)}`, channels);
}

// ---------- read state ----------
//
// One timestamp per channel: everything at or before it has been seen. Kept
// per device deliberately — syncing read state across devices needs encrypted
// per-user storage on the relay, which is a bigger piece of work than this.

export function loadReadState(serverUrl) {
  const obj = read(`read/${serverKey(serverUrl)}`, {});
  return obj && typeof obj === 'object' ? obj : {};
}

export function saveReadState(serverUrl, readState) {
  write(`read/${serverKey(serverUrl)}`, readState);
}

/**
 * Messages the reader has not seen: newer than the mark, and not their own —
 * your own message arriving back from the relay is not news.
 */
export function unreadIn(messages, lastReadAt, myPubkey) {
  if (!messages?.length) return 0;
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const ev = messages[i];
    if (ev.created_at <= lastReadAt) break;
    if (ev.pubkey !== myPubkey) n++;
  }
  return n;
}

// ---------- profiles ----------

export function loadProfiles(serverUrl) {
  const obj = read(`profiles/${serverKey(serverUrl)}`, {});
  return obj && typeof obj === 'object' ? obj : {};
}

export function saveProfiles(serverUrl, profiles) {
  write(`profiles/${serverKey(serverUrl)}`, profiles);
}

/** Forget everything cached for one server (used when it is removed). */
export function forgetServer(serverUrl) {
  const key = serverKey(serverUrl);
  const doomed = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(PREFIX) && k.includes(`/${key}/`)) doomed.push(k);
    else if (
      k === `${PREFIX}chans/${key}` ||
      k === `${PREFIX}profiles/${key}` ||
      k === `${PREFIX}read/${key}`
    ) {
      doomed.push(k);
    }
  }
  for (const k of doomed) localStorage.removeItem(k);
}
