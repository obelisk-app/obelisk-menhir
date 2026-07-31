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
  clearTimeout(pendingWrites.get(key));
  pendingWrites.set(
    key,
    setTimeout(() => {
      pendingWrites.delete(key);
      // Keep the newest slice: old history is re-fetchable, recent context isn't.
      write(key, messages.slice(-MAX_MESSAGES));
    }, WRITE_DEBOUNCE_MS),
  );
}

/** Flush any debounced writes immediately (on hide/unload). */
export function flushWrites() {
  for (const [, timer] of pendingWrites) clearTimeout(timer);
  pendingWrites.clear();
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
    else if (k === `${PREFIX}chans/${key}` || k === `${PREFIX}profiles/${key}`) doomed.push(k);
  }
  for (const k of doomed) localStorage.removeItem(k);
}
