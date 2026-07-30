//! Event kinds used by the Menhir text-channel protocol (NIP-29 subset).

/// User profile metadata (NIP-01).
pub const PROFILE: u32 = 0;
/// Plain-text channel chat message (NIP-29). Must carry an `h` tag.
pub const CHAT: u32 = 9;
/// Add user to group / put-user (NIP-29 moderation).
pub const PUT_USER: u32 = 9000;
/// Remove user from group (NIP-29 moderation).
pub const REMOVE_USER: u32 = 9001;
/// Edit group metadata (NIP-29 moderation).
pub const EDIT_METADATA: u32 = 9002;
/// Delete group (NIP-29 moderation).
pub const DELETE_GROUP: u32 = 9008;
/// Create group (NIP-29). Must carry an `h` tag with the new group id.
pub const CREATE_GROUP: u32 = 9007;
/// Join request (NIP-29).
pub const JOIN_REQUEST: u32 = 9021;
/// Leave request (NIP-29).
pub const LEAVE_REQUEST: u32 = 9022;
/// Relay-generated group metadata (NIP-29, addressable, `d` = group id).
pub const GROUP_METADATA: u32 = 39000;
/// Relay-generated group admin list (NIP-29, addressable, `d` = group id).
pub const GROUP_ADMINS: u32 = 39001;
/// Relay-generated group member list (NIP-29, addressable, `d` = group id).
pub const GROUP_MEMBERS: u32 = 39002;
/// NIP-42 client authentication event.
pub const CLIENT_AUTH: u32 = 22242;
/// Menhir invite redemption (ephemeral, custom). Content = invite code.
pub const INVITE_REDEEM: u32 = 20284;

/// Kinds a Menhir relay accepts from clients. Text-channel logic only —
/// no media, no long-form, no reactions, no DMs in the MVP.
pub const ALLOWED_CLIENT_KINDS: &[u32] = &[
    PROFILE,
    CHAT,
    PUT_USER,
    REMOVE_USER,
    EDIT_METADATA,
    CREATE_GROUP,
    DELETE_GROUP,
    JOIN_REQUEST,
    LEAVE_REQUEST,
    CLIENT_AUTH,
    INVITE_REDEEM,
];

/// True for kinds that are ephemeral per NIP-01 (never stored).
pub fn is_ephemeral(kind: u32) -> bool {
    (20000..30000).contains(&kind)
}

/// True for kinds replaced by (pubkey, kind) — e.g. profiles.
pub fn is_replaceable(kind: u32) -> bool {
    kind == 0 || kind == 3 || (10000..20000).contains(&kind)
}

/// True for kinds replaced by (pubkey, kind, d-tag) — e.g. group metadata.
pub fn is_addressable(kind: u32) -> bool {
    (30000..40000).contains(&kind)
}
