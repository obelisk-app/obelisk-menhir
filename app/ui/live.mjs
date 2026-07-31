// Drive the built UI against a real menhir-relay, in jsdom over a real
// WebSocket: connect, create both channel types, send, reply, and check that a
// publication channel refuses a post from someone who is not its admin.
//
// The smoke test proves the app boots and its wiring exists; this proves the
// protocol round trip the app is actually for.
//
//   cargo build -p menhir-relay -p menhir-cli
//   npm run build && node live.mjs
//
// Binaries are found in CARGO_TARGET_DIR (or ../../target); JSDOM_PATH and
// WS_PATH point at the two node modules this borrows.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const UI = path.dirname(fileURLToPath(import.meta.url));
const TARGET = process.env.CARGO_TARGET_DIR || path.join(UI, '../../target');
const RELAY_BIN = path.join(TARGET, 'debug/menhir-relay');
const CLI = path.join(TARGET, 'debug/menhir');
const JSDOM_PATH = process.env.JSDOM_PATH || '/root/obelisk-dex/node_modules/jsdom/lib/api.js';
const WS_PATH = process.env.WS_PATH || '/root/node_modules/ws/index.js';

for (const bin of [RELAY_BIN, CLI]) {
  if (!fs.existsSync(bin)) {
    console.error(`missing ${bin} — run: cargo build -p menhir-relay -p menhir-cli`);
    process.exit(1);
  }
}

const { JSDOM } = await import(JSDOM_PATH);
const WS = (await import(WS_PATH)).default;

const dataDir = fs.mkdtempSync('/tmp/menhir-live-');
const relay = spawn(RELAY_BIN,
  ['--data-dir', dataDir, 'serve', '--open', '--port', '0'],
  { stdio: ['ignore', 'pipe', 'pipe'] });

let port = null;
const ready = new Promise((resolve, reject) => {
  const onData = (buf) => {
    const s = buf.toString();
    process.stdout.write('[relay] ' + s);
    const m = s.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
    if (m) { port = Number(m[1]); resolve(); }
  };
  relay.stdout.on('data', onData);
  relay.stderr.on('data', onData);
  setTimeout(() => reject(new Error('relay did not report a port')), 10000);
});
await ready;

const html = fs.readFileSync(path.join(UI, 'dist/index.html'), 'utf8');
const bundle = fs.readFileSync(path.join(UI, 'dist/bundle.js'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.WebSocket = WS;
window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
window.navigator.clipboard = { writeText: async () => {} };
window.crypto ??= (await import('node:crypto')).webcrypto;
window.fetch = async () => { throw new Error('no nip-11 in this test'); };
window.HTMLCanvasElement.prototype.getContext = () => ({
  fillRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  clearRect() {}, fillText() {}, measureText: () => ({ width: 0 }),
});
const errors = [];
window.addEventListener('error', (e) => errors.push(e.error?.message || e.message));
window.onerror = (m) => errors.push(String(m));

window.eval(bundle);
const $ = (id) => window.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) fails.push(name);
};

await sleep(200);
$('m-new').onclick();
$('use-generated-btn').onclick();
await sleep(100);

$('add-server-input').value = `ws://127.0.0.1:${port}`;
$('add-server-confirm').onclick();
await sleep(2500);
check('connected to the relay', $('server-status').textContent.startsWith('online'), $('server-status').textContent);

// A chat channel.
$('create-channel-btn').onclick();
$('cc-id').value = 'general';
$('cc-name').value = 'General';
window.document.querySelector('input[name="cc-type"][value="chat"]').checked = true;
await $('cc-confirm').onclick();
await sleep(1200);

// A publication channel.
$('create-channel-btn').onclick();
$('cc-id').value = 'notices';
$('cc-name').value = 'Notices';
window.document.querySelector('input[name="cc-type"][value="publication"]').checked = true;
await $('cc-confirm').onclick();
await sleep(1500);

const items = [...window.document.querySelectorAll('.channel-item')].map((d) => d.textContent);
check('both channels are listed', items.length === 2, JSON.stringify(items));

// Back to the chat channel, send and reply.
[...window.document.querySelectorAll('.channel-item')].find((d) => d.textContent.includes('General')).onclick();
await sleep(400);
$('composer-input').value = 'first message';
$('send-btn').onclick();
await sleep(800);
const first = window.document.querySelector('#messages .msg[data-id]');
check('the message is on screen', !!first && first.textContent.includes('first message'), first?.textContent);

first.querySelector('.msg-reply-btn').onclick();
check('the reply strip appears', !$('reply-strip').classList.contains('hidden'));
$('composer-input').value = 'an answer';
$('send-btn').onclick();
await sleep(900);
const quote = window.document.querySelector('#messages .reply-quote');
check('the reply shows what it answers', !!quote && quote.textContent.includes('first message'), quote?.textContent);
check('the reply strip cleared after sending', $('reply-strip').classList.contains('hidden'));

// Publication channel: admin can post, and it renders as a card.
[...window.document.querySelectorAll('.channel-item')].find((d) => d.textContent.includes('Notices')).onclick();
await sleep(500);
check('the composer invites a post', $('composer-input').placeholder.includes('Publish'), $('composer-input').placeholder);
$('composer-input').value = 'the hall is closed on Tuesday';
$('send-btn').onclick();
await sleep(900);
const post = window.document.querySelector('#messages .post');
check('the post renders as a card', !!post && post.textContent.includes('closed on Tuesday'), post?.textContent);

post.querySelector('.msg-reply-btn').onclick();
$('composer-input').value = 'which Tuesday?';
$('send-btn').onclick();
await sleep(900);
const nested = window.document.querySelector('#messages .post .post-replies .msg');
check('the reply sits under the post', !!nested && nested.textContent.includes('which Tuesday'), nested?.textContent);

// Someone else's publication channel: we are not its admin.
const relayUrl = `ws://127.0.0.1:${port}`;
const other = JSON.parse(execFileSync(CLI, ['keygen', '--json']).toString());
const cli = (args) => execFileSync(CLI, [...args, '--relay', relayUrl, '--nsec', other.nsec]).toString();
cli(['create-channel', '--id', 'news', '--name', 'News', '--type', 'publication']);
cli(['send', '--channel', 'news', '--message', 'read all about it']);
await sleep(1500);

const newsItem = [...window.document.querySelectorAll('.channel-item')].find((d) => d.textContent.includes('News'));
check('someone else\'s channel appears', !!newsItem);
newsItem.onclick();
await sleep(900);
check('a non-admin cannot open a post', $('composer-input').disabled, 'composer was writable');
check('and is told why', $('composer-note').textContent.includes('Only admins publish'), $('composer-note').textContent);
const theirPost = window.document.querySelector('#messages .post .msg-reply-btn');
check('their post is on screen', !!theirPost);
theirPost.onclick();
check('replying unlocks the box', !$('composer-input').disabled, 'still disabled');
$('composer-input').value = 'a reply from a member';
$('send-btn').onclick();
await sleep(900);
const memberReply = window.document.querySelector('#messages .post .post-replies .msg');
check('the reply is accepted', !!memberReply && memberReply.textContent.includes('a reply from a member'), memberReply?.textContent);
check('the composer locks again afterwards', $('composer-input').disabled, 'stayed open');

check('no uncaught errors', errors.length === 0, errors.join(' | '));

relay.kill();
window.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} failure(s)` : '\nlive test passed');
process.exit(fails.length ? 1 : 0);
