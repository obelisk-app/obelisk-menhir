//! SQLite storage: events, tag index, whitelist, invites, groups, members.

use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use menhir_core::{kinds, Event, Filter};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection};

const DEFAULT_QUERY_LIMIT: usize = 500;
const MAX_QUERY_LIMIT: usize = 5000;

#[derive(Debug, PartialEq, Eq)]
pub enum StoreResult {
    Stored,
    Duplicate,
    /// A newer replaceable event already exists.
    Stale,
}

pub struct Db {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Invite {
    pub code: String,
    pub created_at: u64,
    pub expires_at: Option<u64>,
    pub max_uses: u32,
    pub uses: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GroupRow {
    pub id: String,
    pub name: String,
    pub about: String,
    pub created_by: String,
    pub created_at: u64,
}

impl Db {
    pub fn open(path: &Path) -> Result<Db> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                pubkey TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                kind INTEGER NOT NULL,
                tags TEXT NOT NULL,
                content TEXT NOT NULL,
                sig TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_kind_time ON events(kind, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey);
            CREATE TABLE IF NOT EXISTS tags (
                event_id TEXT NOT NULL,
                name TEXT NOT NULL,
                value TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tags ON tags(name, value, event_id);
            CREATE INDEX IF NOT EXISTS idx_tags_event ON tags(event_id);
            CREATE TABLE IF NOT EXISTS whitelist (
                pubkey TEXT PRIMARY KEY,
                added_at INTEGER NOT NULL,
                note TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS invites (
                code TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                expires_at INTEGER,
                max_uses INTEGER NOT NULL DEFAULT 1,
                uses INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS groups_ (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                about TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS members (
                group_id TEXT NOT NULL,
                pubkey TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                added_at INTEGER NOT NULL,
                PRIMARY KEY (group_id, pubkey)
            );
            CREATE TABLE IF NOT EXISTS retired_groups (
                id TEXT PRIMARY KEY,
                retired_at INTEGER NOT NULL
            );",
        )?;
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    // ---- events ----

    pub fn has_event(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row("SELECT 1 FROM events WHERE id = ?1", params![id], |_| {
                Ok(true)
            })
            .unwrap_or(false))
    }

    pub fn insert_event(&self, ev: &Event) -> Result<StoreResult> {
        let mut conn = self.conn.lock().unwrap();
        // One transaction: replacement deletes the old row before writing the
        // new one, so a failure in between would otherwise leave a profile or
        // channel metadata simply gone, and a half-written tag index makes an
        // event unfindable by the tags it declares.
        let tx = conn.transaction()?;

        let exists: bool = tx
            .query_row("SELECT 1 FROM events WHERE id = ?1", params![ev.id], |_| {
                Ok(true)
            })
            .unwrap_or(false);
        if exists {
            return Ok(StoreResult::Duplicate);
        }

        // Replaceable semantics: newest wins; on an equal created_at NIP-01
        // breaks the tie by keeping the lowest id, so every relay fed the same
        // pair converges on the same survivor regardless of arrival order.
        let existing: Vec<(String, i64)> = if kinds::is_replaceable(ev.kind) {
            let mut stmt =
                tx.prepare("SELECT id, created_at FROM events WHERE kind = ?1 AND pubkey = ?2")?;
            let rows = stmt
                .query_map(params![ev.kind, ev.pubkey], |r| Ok((r.get(0)?, r.get(1)?)))?
                .filter_map(|r| r.ok())
                .collect();
            rows
        } else if kinds::is_addressable(ev.kind) {
            let d = ev.first_tag("d").unwrap_or("").to_string();
            let mut stmt = tx.prepare(
                "SELECT e.id, e.created_at FROM events e
                 WHERE e.kind = ?1 AND e.pubkey = ?2
                   AND COALESCE((SELECT t.value FROM tags t WHERE t.event_id = e.id AND t.name = 'd' LIMIT 1), '') = ?3",
            )?;
            let rows = stmt
                .query_map(params![ev.kind, ev.pubkey, d], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?
                .filter_map(|r| r.ok())
                .collect();
            rows
        } else {
            vec![]
        };

        let superseded = |(id, t): &(String, i64)| {
            let t = *t as u64;
            t > ev.created_at || (t == ev.created_at && id.as_str() < ev.id.as_str())
        };
        if existing.iter().any(superseded) {
            return Ok(StoreResult::Stale);
        }

        for (id, _) in &existing {
            tx.execute("DELETE FROM events WHERE id = ?1", params![id])?;
            tx.execute("DELETE FROM tags WHERE event_id = ?1", params![id])?;
        }

        tx.execute(
            "INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                ev.id,
                ev.pubkey,
                ev.created_at as i64,
                ev.kind,
                serde_json::to_string(&ev.tags)?,
                ev.content,
                ev.sig
            ],
        )?;
        for tag in &ev.tags {
            if let (Some(name), Some(value)) = (tag.first(), tag.get(1)) {
                if name.len() == 1 {
                    tx.execute(
                        "INSERT INTO tags (event_id, name, value) VALUES (?1, ?2, ?3)",
                        params![ev.id, name, value],
                    )?;
                }
            }
        }
        tx.commit()?;
        Ok(StoreResult::Stored)
    }

    /// Newest `created_at` among this author's addressable events carrying
    /// `d = d_tag`. Used to keep relay-generated channel metadata strictly
    /// increasing: several updates can land inside one second, and the
    /// equal-timestamp tie-break would otherwise keep an arbitrary one.
    pub fn max_created_at_for_d(&self, pubkey: &str, d_tag: &str) -> Result<Option<u64>> {
        let conn = self.conn.lock().unwrap();
        let newest: Option<i64> = conn
            .query_row(
                "SELECT MAX(e.created_at) FROM events e
                 WHERE e.pubkey = ?1
                   AND EXISTS (SELECT 1 FROM tags t
                               WHERE t.event_id = e.id AND t.name = 'd' AND t.value = ?2)",
                params![pubkey, d_tag],
                |r| r.get(0),
            )
            .unwrap_or(None);
        Ok(newest.map(|t| t as u64))
    }

    pub fn query(&self, filters: &[Filter]) -> Result<Vec<Event>> {
        let conn = self.conn.lock().unwrap();
        let mut out: Vec<Event> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for f in filters {
            let mut sql = String::from(
                "SELECT id, pubkey, created_at, kind, tags, content, sig FROM events WHERE 1=1",
            );
            let mut args: Vec<SqlValue> = Vec::new();

            let in_clause =
                |sql: &mut String, col: &str, values: &[String], args: &mut Vec<SqlValue>| {
                    if values.is_empty() {
                        sql.push_str(" AND 0");
                        return;
                    }
                    sql.push_str(&format!(
                        " AND {col} IN ({})",
                        vec!["?"; values.len()].join(",")
                    ));
                    for v in values {
                        args.push(SqlValue::Text(v.clone()));
                    }
                };

            if let Some(ids) = &f.ids {
                in_clause(&mut sql, "id", ids, &mut args);
            }
            if let Some(authors) = &f.authors {
                in_clause(&mut sql, "pubkey", authors, &mut args);
            }
            if let Some(ks) = &f.kinds {
                if ks.is_empty() {
                    sql.push_str(" AND 0");
                } else {
                    sql.push_str(&format!(" AND kind IN ({})", vec!["?"; ks.len()].join(",")));
                    for k in ks {
                        args.push(SqlValue::Integer(*k as i64));
                    }
                }
            }
            if let Some(since) = f.since {
                sql.push_str(" AND created_at >= ?");
                args.push(SqlValue::Integer(since as i64));
            }
            if let Some(until) = f.until {
                sql.push_str(" AND created_at <= ?");
                args.push(SqlValue::Integer(until as i64));
            }
            for (name, values) in f.tag_filters() {
                if values.is_empty() {
                    sql.push_str(" AND 0");
                    continue;
                }
                sql.push_str(&format!(
                    " AND EXISTS (SELECT 1 FROM tags t WHERE t.event_id = events.id AND t.name = ? AND t.value IN ({}))",
                    vec!["?"; values.len()].join(",")
                ));
                args.push(SqlValue::Text(name));
                for v in values {
                    args.push(SqlValue::Text(v));
                }
            }

            let limit = f.limit.unwrap_or(DEFAULT_QUERY_LIMIT).min(MAX_QUERY_LIMIT);
            sql.push_str(" ORDER BY created_at DESC, id ASC LIMIT ?");
            args.push(SqlValue::Integer(limit as i64));

            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(args), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, u32>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                ))
            })?;
            for row in rows {
                let (id, pubkey, created_at, kind, tags, content, sig) = row?;
                if seen.insert(id.clone()) {
                    out.push(Event {
                        id,
                        pubkey,
                        created_at: created_at as u64,
                        kind,
                        tags: serde_json::from_str(&tags).unwrap_or_default(),
                        content,
                        sig,
                    });
                }
            }
        }
        Ok(out)
    }

    // ---- whitelist ----

    pub fn whitelist_add(&self, pubkey: &str, note: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO whitelist (pubkey, added_at, note) VALUES (?1, ?2, ?3)",
            params![pubkey, menhir_core::now() as i64, note],
        )?;
        Ok(())
    }

    pub fn whitelist_remove(&self, pubkey: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute("DELETE FROM whitelist WHERE pubkey = ?1", params![pubkey])? > 0)
    }

    pub fn whitelist_contains(&self, pubkey: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row(
                "SELECT 1 FROM whitelist WHERE pubkey = ?1",
                params![pubkey],
                |_| Ok(true),
            )
            .unwrap_or(false))
    }

    pub fn whitelist_list(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT pubkey FROM whitelist ORDER BY added_at")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // ---- invites ----

    pub fn invite_create(&self, max_uses: u32, expires_at: Option<u64>) -> Result<Invite> {
        let code: String = {
            // Unambiguous alphabet (no 0/O/1/I/l).
            const ALPHABET: &[u8] = b"23456789abcdefghjkmnpqrstuvwxyz";
            (0..12)
                .map(|_| ALPHABET[rand::random::<usize>() % ALPHABET.len()] as char)
                .collect()
        };
        let invite = Invite {
            code,
            created_at: menhir_core::now(),
            expires_at,
            max_uses,
            uses: 0,
        };
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO invites (code, created_at, expires_at, max_uses, uses) VALUES (?1, ?2, ?3, ?4, 0)",
            params![
                invite.code,
                invite.created_at as i64,
                invite.expires_at.map(|e| e as i64),
                invite.max_uses
            ],
        )?;
        Ok(invite)
    }

    pub fn invite_list(&self) -> Result<Vec<Invite>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT code, created_at, expires_at, max_uses, uses FROM invites ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |r| {
            Ok(Invite {
                code: r.get(0)?,
                created_at: r.get::<_, i64>(1)? as u64,
                expires_at: r.get::<_, Option<i64>>(2)?.map(|e| e as u64),
                max_uses: r.get(3)?,
                uses: r.get(4)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Delete one invite code. Returns true if it existed.
    pub fn invite_revoke(&self, code: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute("DELETE FROM invites WHERE code = ?1", params![code])? > 0)
    }

    /// Delete every invite code, so nothing outstanding can still be redeemed.
    pub fn invite_revoke_all(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute("DELETE FROM invites", [])?)
    }

    /// Validate + consume one use of an invite code.
    pub fn invite_redeem(&self, code: &str) -> Result<std::result::Result<(), String>> {
        let conn = self.conn.lock().unwrap();
        let row: Option<(Option<i64>, u32, u32)> = conn
            .query_row(
                "SELECT expires_at, max_uses, uses FROM invites WHERE code = ?1",
                params![code],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();
        let Some((expires_at, max_uses, uses)) = row else {
            return Ok(Err("unknown invite code".to_string()));
        };
        if let Some(exp) = expires_at {
            if menhir_core::now() > exp as u64 {
                return Ok(Err("invite expired".to_string()));
            }
        }
        if uses >= max_uses {
            return Ok(Err("invite already used up".to_string()));
        }
        conn.execute(
            "UPDATE invites SET uses = uses + 1 WHERE code = ?1",
            params![code],
        )?;
        Ok(Ok(()))
    }

    // ---- groups / members ----

    pub fn group_create(
        &self,
        id: &str,
        name: &str,
        about: &str,
        created_by: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "INSERT OR IGNORE INTO groups_ (id, name, about, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, about, created_by, menhir_core::now() as i64],
        )?;
        Ok(n > 0)
    }

    pub fn group_update_meta(
        &self,
        id: &str,
        name: Option<&str>,
        about: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        if let Some(name) = name {
            conn.execute(
                "UPDATE groups_ SET name = ?2 WHERE id = ?1",
                params![id, name],
            )?;
        }
        if let Some(about) = about {
            conn.execute(
                "UPDATE groups_ SET about = ?2 WHERE id = ?1",
                params![id, about],
            )?;
        }
        Ok(())
    }

    pub fn group_delete(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM groups_ WHERE id = ?1", params![id])?;
        conn.execute("DELETE FROM members WHERE group_id = ?1", params![id])?;
        conn.execute(
            "INSERT OR IGNORE INTO retired_groups (id, retired_at) VALUES (?1, ?2)",
            params![id, menhir_core::now() as i64],
        )?;
        Ok(())
    }

    /// True once a channel id has been deleted. Ids are never recycled:
    /// whoever creates a channel becomes its admin, so a freed id would let
    /// the next caller take over the name an admin just purged — and re-post
    /// the purged events, whose signatures remain perfectly valid.
    pub fn group_is_retired(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row(
                "SELECT 1 FROM retired_groups WHERE id = ?1",
                params![id],
                |_| Ok(true),
            )
            .unwrap_or(false))
    }

    pub fn group_get(&self, id: &str) -> Result<Option<GroupRow>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row(
                "SELECT id, name, about, created_by, created_at FROM groups_ WHERE id = ?1",
                params![id],
                |r| {
                    Ok(GroupRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        about: r.get(2)?,
                        created_by: r.get(3)?,
                        created_at: r.get::<_, i64>(4)? as u64,
                    })
                },
            )
            .ok())
    }

    pub fn group_list(&self) -> Result<Vec<GroupRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, about, created_by, created_at FROM groups_ ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(GroupRow {
                id: r.get(0)?,
                name: r.get(1)?,
                about: r.get(2)?,
                created_by: r.get(3)?,
                created_at: r.get::<_, i64>(4)? as u64,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn member_add(&self, group_id: &str, pubkey: &str, role: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO members (group_id, pubkey, role, added_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(group_id, pubkey) DO UPDATE SET role = excluded.role",
            params![group_id, pubkey, role, menhir_core::now() as i64],
        )?;
        Ok(())
    }

    /// Add a member only if absent — never changes an existing role.
    /// Returns true when a new row was inserted.
    pub fn member_add_if_absent(&self, group_id: &str, pubkey: &str, role: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "INSERT OR IGNORE INTO members (group_id, pubkey, role, added_at) VALUES (?1, ?2, ?3, ?4)",
            params![group_id, pubkey, role, menhir_core::now() as i64],
        )?;
        Ok(n > 0)
    }

    pub fn member_remove(&self, group_id: &str, pubkey: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM members WHERE group_id = ?1 AND pubkey = ?2",
            params![group_id, pubkey],
        )?;
        Ok(())
    }

    /// (pubkey, role) pairs for a group.
    pub fn members(&self, group_id: &str) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT pubkey, role FROM members WHERE group_id = ?1 ORDER BY added_at")?;
        let rows = stmt.query_map(params![group_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Delete all stored events scoped to a group (`h` chat tags and relay
    /// `d`-tagged metadata), used by NIP-29 delete-group (kind 9008).
    pub fn purge_group_events(&self, group_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM events WHERE id IN
               (SELECT event_id FROM tags WHERE (name = 'h' OR name = 'd') AND value = ?1)",
            params![group_id],
        )?;
        conn.execute(
            "DELETE FROM tags WHERE event_id NOT IN (SELECT id FROM events)",
            [],
        )?;
        Ok(())
    }

    pub fn is_group_admin(&self, group_id: &str, pubkey: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row(
                "SELECT 1 FROM members WHERE group_id = ?1 AND pubkey = ?2 AND role = 'admin'",
                params![group_id, pubkey],
                |_| Ok(true),
            )
            .unwrap_or(false))
    }
}
