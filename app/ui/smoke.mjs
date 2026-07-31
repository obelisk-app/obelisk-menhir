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
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
};

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
    'host-invite-btn', 'host-invite-qr', 'host-share-qr', 'host-copy-share',
    'host-open-local', 'host-wl-add', 'host-revoke-all', 'qr-copy'];
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

console.log('\nqr:');
check('the share-QR path runs', () => {
  $('server-qr-btn').onclick();
  if ($('qr-modal').classList.contains('hidden')) throw new Error('qr modal did not open');
  if (!$('qr-text').textContent.includes('obelisk://join')) throw new Error('no share link rendered');
});

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
