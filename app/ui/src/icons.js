// Inline SVG marks. Kept as strings rather than files so they can be dropped
// into a button, a rail tile or the login card without a second request — and
// so they inherit `currentColor` from whatever they sit in.

/**
 * The Buenos Aires obelisco, the Obelisk family mark — two faces, the left one
 * shaded. Same geometry as obelisk's `ObeliskIcon`, so a Menhir server you host
 * carries the same silhouette as the web client.
 */
export const OBELISK_SVG = `
<svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true" class="obelisk-mark">
  <path d="M 256,16 L 220,72 L 196,460 L 200,464 L 256,464 L 256,72 Z" opacity="0.7" />
  <path d="M 256,16 L 292,72 L 316,460 L 312,464 L 256,464 L 256,72 Z" />
</svg>`;

/** A speech bubble — the marker for an ordinary chat channel. */
export const CHAT_SVG = `
<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" class="chan-mark">
  <path d="M8 1.5c-3.6 0-6.5 2.2-6.5 5 0 1.6.9 3 2.4 3.9-.1.8-.5 1.7-1.2 2.5 1.4-.2 2.6-.7 3.5-1.4.6.1 1.2.2 1.8.2 3.6 0 6.5-2.2 6.5-5s-2.9-5.2-6.5-5.2z" />
</svg>`;

/** Stacked lines — the marker for a publication channel. */
export const PUBLICATION_SVG = `
<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" class="chan-mark">
  <path d="M2.5 2h11a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5zm1 2v3h9V4h-9zm0 4.5v1h9v-1h-9zm0 2.5v1h6v-1h-6z" />
</svg>`;
