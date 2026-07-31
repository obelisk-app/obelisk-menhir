# Roadmap

Menhir started as the smallest thing that proves the idea: sovereign text
channels, hosted from your own machine, reachable over Tor. That works now —
onion hosting, invites, whitelist, three signing methods, unread and
notifications, cached history, channel administration, replies, emoji, and
two channel types (chat and publication).

This is the plan for what comes next, and what gets ported from
[obelisk](https://github.com/obelisk-app/obelisk) (the full web client, called
obelisk-dex in development).

## The rule that decides what gets ported

Obelisk is a web app talking to public relays. Menhir is a desktop and mobile
app whose server is a laptop behind a Tor circuit. A feature that is cheap
there can be wrong here:

- **A Tor round-trip is slow.** Anything chatty (link previews, avatar
  fetches, per-message profile lookups) needs batching or caching, or it will
  feel broken over a circuit that takes 40s to build cold.
- **Media is expensive and identifying.** Blossom uploads go to a public host,
  which leaks who is in a private channel and defeats the point of hosting it
  yourself. Media has to be either relay-local or explicitly opt-in.
- **The relay is one person's machine.** Anything that assumes a fleet of
  public relays (WoT scoring over the whole network, cross-relay search) does
  not transfer directly.
- **Text-only is the current promise.** Every kind added widens what the
  relay accepts, which is a security surface, not just a feature.

Nothing below is ported for its own sake. Each item names why it earns its
place.

---

## Phase 1 — finish the MVP

The gap between "works" and "a group can use it daily".

| | Why |
|---|---|
| ~~Unread + notifications~~ | ✅ Done. A chat that arrives silently is not a chat. |
| **Send queue** | A message composed while offline should send when the connection returns, not fail. Especially on mobile, where the connection drops constantly. |
| **Message deletion** (NIP-09-shaped) | Admins can delete a channel but not one abusive message. Moderation needs the smaller instrument. |
| **Per-pubkey rate limiting** | The whitelist is currently the only throttle; one member can flood a channel. |
| **Server backup & restore** | The onion key *is* the address. Losing the data directory destroys the community permanently, with no recovery path. Encrypted export/import. |
| **Signed installers, bundled Tor** | Releases carry arm64 Linux and Android. No macOS, Windows or x86_64 build, nothing signed, and Tor must be installed by hand. Moving desktop *connections* to arti (as Android already does) removes the dependency entirely; hosting keeps C Tor until arti can publish onion services. |
| **Key storage** | The nsec sits in localStorage. OS keychain, or push people toward the remote signer that already works. |

## Phase 2 — the chat people expect

Ported from obelisk, in the order that most changes daily use.

| | Ported from | Notes |
|---|---|---|
| ~~Replies~~ | `MessageContent`, reply tags | ✅ Done. NIP-10 marked `e` tag, a quoted header, and the rule that makes publication channels work. |
| ~~Emoji picker~~ | `EmojiPicker`, `recent-emojis.ts` | ✅ Done — Unicode only. Emoji are text, so nothing had to change on the wire. |
| **Reactions** | kind 7 | Accepting kind 7 on the relay. Small, well-understood widening — the picker is already there. |
| **Mentions + autocomplete** | `mentions.ts`, `MentionAutocomplete`, `MentionNavigator` | Needs the member list, which the relay already publishes as kind 39002. |
| **Profile pictures and popovers** | `UserAvatar`, `ProfilePopover`, `NostrProfile` | Avatars are remote images — over Tor they must be cached hard and lazily fetched, or turned off by default. |
| **Markdown, code blocks, spoilers** | `markdown.ts`, `CodeBlock`, `SpoilerText`, `remark-spoiler.ts` | Rendering only — no protocol change. Must stay strictly sanitised; the current client deliberately renders `textContent`. |
| **Message editing** | — | Not in obelisk either. Decide deliberately rather than inherit. |
| **History pagination** | `HistoryPaginationStatus`, `channel-scroll-anchor.ts` | Currently the client loads the most recent 200 and stops. Real channels outgrow that. |
| **Search** | `group-search.ts`, NIP-50 | The relay would need to implement NIP-50; SQLite FTS makes this straightforward. |

## Phase 3 — identity and trust

| | Ported from | Notes |
|---|---|---|
| **Multi-account** | `store/multi-account.ts` | One person, several identities — natural when identity is a keypair. |
| **Read state across devices** | `lib/read-state/`, NIP-59 gift wrap | Menhir's read marks are per device. Obelisk already solved this with encrypted per-user storage; the relay would need to accept kind 1059. |
| **Web of Trust** | `lib/wot/`, `WotBadge` | Useful for *deciding who to admit* — the spec's original intent — rather than for scoring a public feed. Pairs with the invite system: "admit anyone N of my contacts vouch for". |
| **Moderation tooling** | `store/moderation.ts` | Mute lists, per-user blocks, an audit trail for admin actions. |
| **Account backup** | `lib/account-backup.ts` | Distinct from server backup: this is the user's identity and settings. |

## Phase 4 — richer content

Each item here widens what the relay stores. Take them one at a time, with the
storage and privacy questions answered first.

| | Ported from | The question to answer first |
|---|---|---|
| **Attachments and images** | `attachments.ts`, `blossom.ts`, `ImageGallery` | Where do bytes live? A public Blossom host leaks membership of a private channel. Relay-local storage means the operator's laptop holds everyone's files. |
| **Link previews** | `LinkPreview.tsx` | Fetching a preview reveals the reader's IP to the linked site unless it goes through Tor or the relay fetches it. |
| **Custom emoji, stickers, media packs** | `relay-emojis.ts`, `personal-stickers.ts`, `media-packs.ts` | Same storage question, lower stakes. The Unicode picker deliberately shipped without any of it. |
| **Voice notes** | `voice-note-tags.ts` | Audio is large; a Tor circuit is not. |
| **Forum view** | `ForumView.tsx` | Publication channels are the first half: an admin's posts with replies gathered under each. The rest — a thread per post as its own channel, curated tags, sort and gallery views — needs child channels (`parent` tag) the relay does not model yet. |

## Phase 5 — beyond text

Deliberately last. Each is a project.

| | Ported from | Notes |
|---|---|---|
| **Direct messages** | `lib/dm/`, NIP-04/NIP-17 | Obelisk routes DMs cross-relay via NIP-65. Menhir has one relay per server — DMs between people on different Menhir servers need a routing story that does not leak the private relay. |
| **Voice and video** | `lib/voice/`, obelisk-sfu | Explicitly out of scope in the current spec. Mesh WebRTC over a Tor-signalled channel is plausible; media over Tor is not — it would need direct connections, which reveals IPs. |
| **Payments and zaps** | `lib/wallet/`, NIP-47, `MessageZapModal` | Self-contained; needs a wallet connection that does not undo the network privacy. |
| **Relay branding and layout** | `relay-branding.ts`, `channel-layout.ts` (NIP-78) | Lets an operator shape their server: ordering, categories, an icon. Cheap and satisfying once channels multiply. |
| **i18n** | `lib/i18n.ts` | Obelisk ships English and Spanish. |

---

## Reachability

Tor is the default and the interesting case: no domain, no port forwarding,
no public IP. But it is not the only one, and as of the current release it is
no longer required:

- **Tor onion service** — the default. Reachable from anywhere, address stable
  across restarts, nothing to configure.
- **Local network** — `--clearnet` on the CLI, "Also listen on my network" in
  the app. Binds every interface and reports the LAN address. Good for a
  household or an office, and for testing without waiting on a circuit.
- **Your own domain** — the same clearnet listener behind a reverse proxy
  terminating TLS, giving `wss://`. This is the path for an always-on server
  with a real name.

The client speaks all three; the invite link carries whichever address the
operator shares. A plain `ws://` server that is neither loopback nor onion is
flagged as unencrypted in the connection status, because it is.

## Things that will not be ported

- **Relay-to-relay replication.** The spec rules it out for good reasons:
  loop prevention, storage limits, deletion semantics, and a privacy review
  none of which are MVP-sized.
- **Automatically importing onion addresses from arbitrary Nostr events.** A
  server is added by an explicit act, never by something a relay said.
- **Hidden background hosting after the user quits.** If the app is closed,
  the server is down. That is honest, and it is the deal.
