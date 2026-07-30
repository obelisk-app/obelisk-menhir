// Signing backends. Every one exposes the same async surface:
//   signer.pubkey            hex pubkey
//   await signer.sign(tmpl)  -> signed event
//   signer.kind              'nsec' | 'nip07' | 'bunker'
//   signer.persist()         -> JSON-serialisable resume blob (or null)
//
// Signing is async across the board because remote signers round-trip to a
// bunker; the nsec path just resolves immediately.

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import * as nip19 from 'nostr-tools/nip19';
import { BunkerSigner as ToolsBunkerSigner, parseBunkerInput, createNostrConnectURI } from 'nostr-tools/nip46';

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const NOW = () => Math.floor(Date.now() / 1000);

/** Local secret key. Fast, but the key lives in this device's storage. */
export class NsecSigner {
  constructor(sk) {
    this.kind = 'nsec';
    this.sk = sk;
    this.pubkey = getPublicKey(sk);
  }

  static fromInput(input) {
    const trimmed = (input || '').trim();
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
    return new NsecSigner(bytes);
  }

  static generate() {
    return new NsecSigner(generateSecretKey());
  }

  async sign({ kind, tags, content }) {
    return finalizeEvent({ kind, tags, content, created_at: NOW() }, this.sk);
  }

  nsec() {
    return nip19.nsecEncode(this.sk);
  }

  persist() {
    return { kind: 'nsec', sk: bytesToHex(this.sk) };
  }
}

/** NIP-07 browser extension (nos2x, Alby, …). The key never reaches us. */
export class Nip07Signer {
  constructor(pubkey) {
    this.kind = 'nip07';
    this.pubkey = pubkey;
  }

  static available() {
    return typeof window !== 'undefined' && !!window.nostr?.signEvent;
  }

  static async connect() {
    if (!Nip07Signer.available()) {
      throw new Error('no NIP-07 extension found in this browser');
    }
    const pubkey = await window.nostr.getPublicKey();
    if (!pubkey) throw new Error('the extension did not return a public key');
    return new Nip07Signer(pubkey);
  }

  async sign({ kind, tags, content }) {
    return window.nostr.signEvent({ kind, tags, content, created_at: NOW(), pubkey: this.pubkey });
  }

  persist() {
    return { kind: 'nip07', pubkey: this.pubkey };
  }
}

/**
 * NIP-46 remote signer. The signing key stays in a bunker (Amber, nsec.app,
 * a self-hosted signer); we hold only a throwaway local key used to talk to it.
 */
export class RemoteSigner {
  constructor(inner, pubkey, localSk, bunkerUri) {
    this.kind = 'bunker';
    this.inner = inner;
    this.pubkey = pubkey;
    this.localSk = localSk;
    this.bunkerUri = bunkerUri;
  }

  /** Connect to a `bunker://…` URI (from a signer app or an nsec.app link). */
  static async fromBunkerUri(uri, localSkHex) {
    const pointer = await parseBunkerInput((uri || '').trim());
    if (!pointer) throw new Error('that is not a valid bunker:// URI');
    const localSk = localSkHex ? hexToBytes(localSkHex) : generateSecretKey();
    const pool = new SimplePool();
    const inner = new ToolsBunkerSigner(localSk, pointer, { pool });
    await inner.connect();
    const pubkey = await inner.getPublicKey();
    return new RemoteSigner(inner, pubkey, localSk, uri.trim());
  }

  /**
   * The other direction: we publish a `nostrconnect://` URI (as a QR) and wait
   * for a signer app to scan it and connect back to us.
   */
  static startNostrConnect({ relays, name, onConnected, onError }) {
    const localSk = generateSecretKey();
    const localPk = getPublicKey(localSk);
    const secret = bytesToHex(generateSecretKey()).slice(0, 32);
    const uri = createNostrConnectURI({
      clientPubkey: localPk,
      relays,
      secret,
      name,
      perms: 'sign_event:0,sign_event:9,sign_event:9007,sign_event:9021,sign_event:9022,sign_event:22242,sign_event:20284',
    });

    const pool = new SimplePool();
    let settled = false;
    const sub = pool.subscribe(relays, { kinds: [24133], '#p': [localPk], since: NOW() - 10 }, {
      onevent: async () => {
        if (settled) return;
        settled = true;
        try {
          sub.close();
          const inner = new ToolsBunkerSigner(localSk, { relays, pubkey: localPk, secret }, { pool });
          await inner.connect();
          const pubkey = await inner.getPublicKey();
          onConnected(new RemoteSigner(inner, pubkey, localSk, null));
        } catch (e) {
          onError?.(e);
        }
      },
    });

    return { uri, cancel: () => { settled = true; try { sub.close(); } catch {} } };
  }

  async sign({ kind, tags, content }) {
    return this.inner.signEvent({ kind, tags, content, created_at: NOW() });
  }

  persist() {
    // Only bunker:// sessions can be resumed unattended — a nostrconnect
    // session has no URI to dial back out to.
    return this.bunkerUri
      ? { kind: 'bunker', uri: this.bunkerUri, localSk: bytesToHex(this.localSk) }
      : null;
  }
}

/** Rebuild a signer from a persisted blob, or null if it cannot be resumed. */
export async function restoreSigner(blob) {
  if (!blob || !blob.kind) return null;
  try {
    if (blob.kind === 'nsec') return new NsecSigner(hexToBytes(blob.sk));
    if (blob.kind === 'nip07') {
      if (!Nip07Signer.available()) return null;
      const pubkey = await window.nostr.getPublicKey();
      return pubkey === blob.pubkey ? new Nip07Signer(pubkey) : null;
    }
    if (blob.kind === 'bunker') return await RemoteSigner.fromBunkerUri(blob.uri, blob.localSk);
  } catch {
    return null;
  }
  return null;
}
