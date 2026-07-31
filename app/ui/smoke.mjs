// Boot the built UI in a DOM and exercise the wiring, so a typo'd element id
// or a broken handler fails here instead of on someone's phone.
//
//   node smoke.mjs            (needs jsdom resolvable; see JSDOM_PATH)
//
// This is a smoke test, not a substitute for using the app: it asserts the
// app boots, the login methods render, panes switch, and the join-link and
// QR paths run without throwing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const JSDOM_PATH = process.env.JSDOM_PATH || '/root/obelisk-dex/node_modules/jsdom/lib/api.js';

const { JSDOM } = await import(JSDOM_PATH);

const html = fs.readFileSync(path.join(here, 'dist/index.html'), 'utf8');
const bundle = fs.readFileSync(path.join(here, 'dist/bundle.js'), 'utf8');

const failures = [];
const check = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      // Async checks are awaited by the caller via `pending`.
      pending.push(
        r.then(
          () => console.log(`  ok    ${name}`),
          (e) => { failures.push(`${name}: ${e.message}`); console.log(`  FAIL  ${name}: ${e.message}`); },
        ),
      );
      return;
    }
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
};
const pending = [];

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;

// Things jsdom does not implement that the app touches.
window.matchMedia = (q) => ({ matches: /max-width/.test(q) ? false : false, media: q, addEventListener() {}, removeEventListener() {} });
window.WebSocket = class {
  constructor() { this.readyState = 0; setTimeout(() => this.onerror?.(new Error('no relay in smoke test')), 0); }
  send() {} close() {}
};
window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
window.navigator.clipboard = { writeText: async () => {} };
window.crypto ??= (await import('node:crypto')).webcrypto;
window.HTMLCanvasElement.prototype.getContext = () => ({
  fillRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  clearRect() {}, fillText() {}, measureText: () => ({ width: 0 }),
});

const errors = [];
window.addEventListener('error', (e) => errors.push(e.error?.message || e.message));
window.onerror = (m) => errors.push(String(m));

window.eval(bundle);
await new Promise((r) => setTimeout(r, 300));

const $ = (id) => window.document.getElementById(id);

console.log('\nboot:');
check('no uncaught errors during boot', () => {
  if (errors.length) throw new Error(errors.join(' | '));
});
check('login screen is visible', () => {
  if ($('login-screen').classList.contains('hidden')) throw new Error('login screen hidden at boot');
});
check('app screen is hidden', () => {
  if (!$('app-screen').classList.contains('hidden')) throw new Error('app screen shown before login');
});

console.log('\nlogin methods:');
check('every login button is wired', () => {
  for (const id of ['m-nsec', 'm-new', 'm-bunker', 'm-nip07']) {
    if (typeof $(id).onclick !== 'function') throw new Error(`${id} has no handler`);
  }
});
check('"create a new identity" produces an nsec', () => {
  $('m-new').onclick();
  const nsec = $('generated-nsec').textContent;
  if (!nsec.startsWith('nsec1')) throw new Error(`got ${JSON.stringify(nsec)}`);
  if (!$('generated-nsec').dataset.hex) throw new Error('no hex stashed for the continue button');
});
check('generated key logs in and reveals the app', () => {
  $('use-generated-btn').onclick();
  if (!$('login-screen').classList.contains('hidden')) throw new Error('still on the login screen');
  if ($('app-screen').classList.contains('hidden')) throw new Error('app screen still hidden');
  if (!$('me-npub').textContent.startsWith('npub1')) throw new Error('npub not shown');
});
check('the session is persisted', () => {
  const raw = window.localStorage.getItem('menhir-signer');
  if (!raw) throw new Error('nothing stored');
  if (JSON.parse(raw).kind !== 'nsec') throw new Error('wrong signer kind stored');
});

console.log('\napp wiring:');
check('every app control is wired', () => {
  const ids = ['add-server-btn', 'add-server-confirm', 'scan-qr-btn', 'server-qr-btn',
    'server-settings-btn', 'server-rename-save', 'server-remove',
    'me-box', 'profile-save', 'copy-npub', 'reveal-nsec', 'copy-nsec', 'clear-cache',
    'logout-btn-settings', 'create-channel-btn', 'cc-confirm', 'send-btn',
    'channel-admin-btn', 'ca-save', 'ca-delete',
    'back-btn', 'logout-btn', 'host-recheck-btn', 'host-start-btn', 'host-stop-btn',
    'host-invite-btn', 'host-invite-qr', 'host-invite-copy', 'host-share-qr', 'host-copy-share',
    'host-open-local', 'host-wl-add', 'host-revoke-all', 'qr-copy',
    'emoji-btn', 'reply-cancel', 'host-btn'];
  // Elements the app writes into but never wires a click to.
  const written = ['chat-about', 'composer-note', 'reply-strip', 'reply-strip-who',
    'reply-strip-text', 'host-starting', 'host-start-note', 'host-invite-uses',
    'host-invite-expiry', 'confirm-title', 'confirm-body', 'confirm-go', 'confirm-cancel',
    'toast-stack', 'cc-type', 'ca-type'];
  const absent = written.filter((id) => !$(id));
  if (absent.length) throw new Error('missing elements: ' + absent.join(', '));
  const missing = ids.filter((id) => !$(id));
  if (missing.length) throw new Error('missing elements: ' + missing.join(', '));
  const unwired = ids.filter((id) => typeof $(id).onclick !== 'function');
  if (unwired.length) throw new Error('no handler on: ' + unwired.join(', '));
});
check('every data-close button targets a real modal', () => {
  for (const btn of window.document.querySelectorAll('[data-close]')) {
    if (!$(btn.dataset.close)) throw new Error(`data-close="${btn.dataset.close}" has no element`);
    if (typeof btn.onclick !== 'function') throw new Error(`${btn.dataset.close} close button unwired`);
  }
});
check('settings opens with identity, storage and version', () => {
  $('me-box').onclick();
  if ($('profile-modal').classList.contains('hidden')) throw new Error('settings did not open');
  if (!$('profile-npub').textContent.startsWith('npub1')) throw new Error('npub missing');
  if ($('profile-signer').textContent === '—') throw new Error('signer kind not described');
  if ($('cache-size').textContent === '—') throw new Error('cache size not reported');
  if (!/^\d+\.\d+\.\d+$/.test($('app-version').textContent)) {
    throw new Error('version not shown: ' + $('app-version').textContent);
  }
  if ($('reveal-nsec').classList.contains('hidden')) {
    throw new Error('nsec signer should offer to reveal the key');
  }
});
check('saving a profile with no connection explains why', () => {
  $('profile-name').value = 'smoke tester';
  $('profile-save').onclick();
  if ($('profile-error').classList.contains('hidden')) throw new Error('no error shown');
});
check('the channel admin button stays hidden for non-admins', () => {
  if (!$('channel-admin-btn').classList.contains('hidden')) {
    throw new Error('admin controls offered without admin rights');
  }
});

console.log('\njoin links:');
check('an obelisk://join link adds a server', () => {
  window.document.querySelector('[data-close="profile-modal"]').onclick();
  $('add-server-input').value = 'obelisk://join?relay=ws://abc.onion&invite=CODE123';
  $('add-server-confirm').onclick();
  const saved = JSON.parse(window.localStorage.getItem('menhir-servers') || '[]');
  if (!saved.length) throw new Error('no server stored');
  if (saved[0].url !== 'ws://abc.onion') throw new Error(`relay parsed as ${saved[0].url}`);
  if (saved[0].invite !== 'CODE123') throw new Error('invite not carried');
});
check('a bare relay URL is accepted', () => {
  $('add-server-input').value = 'wss://relay.example.com';
  $('add-server-confirm').onclick();
  const saved = JSON.parse(window.localStorage.getItem('menhir-servers') || '[]');
  if (!saved.some((s) => s.url === 'wss://relay.example.com')) throw new Error('not stored');
});
check('garbage input is rejected with a message', () => {
  $('add-server-input').value = 'definitely not a relay';
  $('add-server-confirm').onclick();
  if ($('add-server-error').classList.contains('hidden')) throw new Error('no error shown');
});
check('a clearnet host without a scheme is dialled over TLS', () => {
  $('add-server-input').value = 'relay.example.org:7777';
  $('add-server-confirm').onclick();
  const saved = JSON.parse(window.localStorage.getItem('menhir-servers') || '[]');
  if (!saved.some((s) => s.url === 'wss://relay.example.org:7777')) {
    throw new Error('expected wss://, got ' + JSON.stringify(saved.map((s) => s.url)));
  }
});
check('a LAN address without a scheme stays plain ws://', () => {
  $('add-server-input').value = '192.168.1.20:4869';
  $('add-server-confirm').onclick();
  const saved = JSON.parse(window.localStorage.getItem('menhir-servers') || '[]');
  if (!saved.some((s) => s.url === 'ws://192.168.1.20:4869')) {
    throw new Error('expected ws://, got ' + JSON.stringify(saved.map((s) => s.url)));
  }
});
check('an https:// URL is understood as a relay', () => {
  $('add-server-input').value = 'https://relay.example.net';
  $('add-server-confirm').onclick();
  const saved = JSON.parse(window.localStorage.getItem('menhir-servers') || '[]');
  if (!saved.some((s) => s.url === 'wss://relay.example.net')) throw new Error('https not converted');
});

console.log('\nmenus:');
check('settings shows one section at a time', () => {
  $('me-box').onclick();
  const panel = (name) => window.document.querySelector(`.settings-panel[data-panel="${name}"]`);
  if (panel('profile').classList.contains('hidden')) throw new Error('profile section not shown');
  if (!panel('identity').classList.contains('hidden')) throw new Error('every section shown at once');
  window.document.querySelector('.settings-tab[data-tab="identity"]').onclick();
  if (panel('identity').classList.contains('hidden')) throw new Error('identity did not open');
  if (!panel('profile').classList.contains('hidden')) throw new Error('profile did not close');
  window.document.querySelector('[data-close="profile-modal"]').onclick();
});
check('Escape closes the panel on top', () => {
  $('add-server-btn').onclick();
  if ($('add-server-modal').classList.contains('hidden')) throw new Error('panel did not open');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  if (!$('add-server-modal').classList.contains('hidden')) throw new Error('Escape did not close it');
});
check('a destructive action asks in-app, and Cancel means cancel', () => {
  const before = JSON.parse(window.localStorage.getItem('menhir-servers') || '[]').length;
  $('server-settings-btn').onclick();
  $('server-remove').onclick();
  if ($('confirm-modal').classList.contains('hidden')) throw new Error('no confirmation shown');
  $('confirm-cancel').onclick();
  const after = JSON.parse(window.localStorage.getItem('menhir-servers') || '[]').length;
  if (after !== before) throw new Error('cancelling still removed the server');
});
check('confirming removes the server and says so', async () => {
  const before = JSON.parse(window.localStorage.getItem('menhir-servers') || '[]').length;
  $('server-settings-btn').onclick();
  $('server-remove').onclick();
  $('confirm-go').onclick();
  await new Promise((r) => setTimeout(r, 20));
  const after = JSON.parse(window.localStorage.getItem('menhir-servers') || '[]').length;
  if (after !== before - 1) throw new Error(`server not removed (${before} → ${after})`);
  if (!$('toast-stack').textContent.includes('removed')) throw new Error('no toast shown');
});

console.log('\ncomposing:');
check('the emoji picker inserts at the caret', () => {
  const input = $('composer-input');
  input.value = 'hi ';
  input.setSelectionRange(3, 3);
  $('emoji-btn').onclick(new window.MouseEvent('click'));
  const picker = window.document.querySelector('.emoji-picker');
  if (!picker || picker.classList.contains('hidden')) throw new Error('picker did not open');
  const cell = picker.querySelector('.emoji-cell');
  if (!cell) throw new Error('no emoji to pick');
  cell.onclick();
  if (input.value === 'hi ') throw new Error('nothing inserted');
  if (!input.value.startsWith('hi ')) throw new Error('inserted in the wrong place: ' + input.value);
});
check('emoji search finds something for "fire"', () => {
  const picker = window.document.querySelector('.emoji-picker');
  const search = picker.querySelector('.emoji-search');
  search.value = 'fire';
  search.dispatchEvent(new window.Event('input'));
  const hits = picker.querySelectorAll('.emoji-cell');
  if (!hits.length) throw new Error('no results for "fire"');
  if (![...hits].some((c) => c.textContent === '🔥')) throw new Error('🔥 not among the results');
});
check('replying without a connection does not lose the text', async () => {
  const input = $('composer-input');
  input.value = 'a message that cannot be sent';
  $('send-btn').onclick();
  await new Promise((r) => setTimeout(r, 20));
  if (input.value !== 'a message that cannot be sent') throw new Error('the message was dropped');
});

console.log('\nunread:');
check('unread counts skip your own messages and anything already read', async () => {
  const store = await import('./src/store.js');
  const me = 'aa'.repeat(32);
  const them = 'bb'.repeat(32);
  const msgs = [
    { id: '1', pubkey: them, created_at: 100, content: 'old' },
    { id: '2', pubkey: me, created_at: 200, content: 'mine' },
    { id: '3', pubkey: them, created_at: 300, content: 'new' },
    { id: '4', pubkey: them, created_at: 400, content: 'newer' },
  ];
  const all = store.unreadIn(msgs, 0, me);
  if (all !== 3) throw new Error(`expected 3 unread from others, got ${all}`);
  const some = store.unreadIn(msgs, 200, me);
  if (some !== 2) throw new Error(`expected 2 after the read mark, got ${some}`);
  const none = store.unreadIn(msgs, 400, me);
  if (none !== 0) throw new Error(`expected 0 when caught up, got ${none}`);
  if (store.unreadIn([], 0, me) !== 0) throw new Error('empty channel must be 0');
});
check('merging is idempotent and keeps time order', async () => {
  const store = await import('./src/store.js');
  const a = [{ id: 'b', created_at: 200 }, { id: 'a', created_at: 100 }];
  const merged = store.mergeMessages(a, [{ id: 'a', created_at: 100 }, { id: 'c', created_at: 150 }]);
  if (merged.length !== 3) throw new Error(`duplicate not collapsed: ${merged.length}`);
  const times = merged.map((m) => m.created_at);
  if (String(times) !== '100,150,200') throw new Error('not sorted by time: ' + times);
});
check('resume point sits behind the newest message', async () => {
  const store = await import('./src/store.js');
  if (store.resumeSince([]) !== undefined) throw new Error('empty cache must fetch history');
  const since = store.resumeSince([{ created_at: 1000 }]);
  if (!(since < 1000)) throw new Error('resume must overlap, got ' + since);
});
check('flushing writes out the debounce instead of dropping it', async () => {
  // store.js reaches for the global localStorage; lend it the DOM's.
  globalThis.localStorage = window.localStorage;
  const store = await import('./src/store.js');
  const url = 'ws://flush.test';
  store.saveMessages(url, 'general', [{ id: 'x', created_at: 5, pubkey: 'aa', content: 'hi' }]);
  store.flushWrites();
  const back = store.loadMessages(url, 'general');
  if (back.length !== 1) throw new Error(`expected the message to survive, got ${back.length}`);
  store.forgetServer(url);
});
check('a self-hosted relay keeps its history when its port moves', async () => {
  globalThis.localStorage = window.localStorage;
  const store = await import('./src/store.js');
  store.saveChannels('ws://127.0.0.1:4869', [{ id: 'general', name: 'General' }]);
  store.saveMessages('ws://127.0.0.1:4869', 'general', [{ id: 'y', created_at: 9, pubkey: 'bb', content: 'yo' }]);
  store.flushWrites();
  store.renameServer('ws://127.0.0.1:4869', 'ws://127.0.0.1:5555');
  if (store.loadMessages('ws://127.0.0.1:5555', 'general').length !== 1) {
    throw new Error('messages did not follow the port');
  }
  if (store.loadChannels('ws://127.0.0.1:5555').length !== 1) {
    throw new Error('channels did not follow the port');
  }
  if (store.loadMessages('ws://127.0.0.1:4869', 'general').length !== 0) {
    throw new Error('the old key was left behind');
  }
  store.forgetServer('ws://127.0.0.1:5555');
});

console.log('\nqr:');
check('the share-QR path runs', () => {
  $('server-qr-btn').onclick();
  if ($('qr-modal').classList.contains('hidden')) throw new Error('qr modal did not open');
  if (!$('qr-text').textContent.includes('obelisk://join')) throw new Error('no share link rendered');
});

await Promise.all(pending);

console.log('');
// jsdom keeps timers (reconnect backoff, rAF) alive, so exit explicitly
// rather than waiting for the event loop to drain.
window.close();
if (failures.length) {
  console.error(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log('UI smoke test passed');
process.exit(0);
