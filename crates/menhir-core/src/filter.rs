//! NIP-01 subscription filters (subset): ids, authors, kinds, since, until,
//! limit, and `#x` tag filters.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::event::Event;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Filter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authors: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    /// Captures `#e`, `#p`, `#h`, `#d`, … tag filters (and ignores unknown keys).
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Filter {
    pub fn new() -> Filter {
        Filter::default()
    }

    pub fn kinds(mut self, kinds: Vec<u32>) -> Filter {
        self.kinds = Some(kinds);
        self
    }

    pub fn authors(mut self, authors: Vec<String>) -> Filter {
        self.authors = Some(authors);
        self
    }

    pub fn limit(mut self, limit: usize) -> Filter {
        self.limit = Some(limit);
        self
    }

    pub fn since(mut self, since: u64) -> Filter {
        self.since = Some(since);
        self
    }

    pub fn tag(mut self, name: &str, values: Vec<String>) -> Filter {
        self.extra
            .insert(format!("#{name}"), serde_json::json!(values));
        self
    }

    /// Tag filters as (tag_name, values) pairs, from `#x` keys.
    pub fn tag_filters(&self) -> Vec<(String, Vec<String>)> {
        self.extra
            .iter()
            .filter_map(|(k, v)| {
                let name = k.strip_prefix('#')?;
                let values: Vec<String> = v
                    .as_array()?
                    .iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect();
                Some((name.to_string(), values))
            })
            .collect()
    }

    pub fn matches(&self, ev: &Event) -> bool {
        if let Some(ids) = &self.ids {
            if !ids.iter().any(|i| i == &ev.id) {
                return false;
            }
        }
        if let Some(authors) = &self.authors {
            if !authors.iter().any(|a| a == &ev.pubkey) {
                return false;
            }
        }
        if let Some(kinds) = &self.kinds {
            if !kinds.contains(&ev.kind) {
                return false;
            }
        }
        if let Some(since) = self.since {
            if ev.created_at < since {
                return false;
            }
        }
        if let Some(until) = self.until {
            if ev.created_at > until {
                return false;
            }
        }
        for (name, values) in self.tag_filters() {
            let ev_values = ev.tag_values(&name);
            if !values.iter().any(|v| ev_values.contains(&v.as_str())) {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::EventTemplate;
    use crate::keys::Keys;

    fn chat_event(channel: &str, content: &str) -> Event {
        let keys = Keys::generate();
        Event::sign(
            EventTemplate {
                kind: 9,
                tags: vec![vec!["h".into(), channel.into()]],
                content: content.into(),
                created_at: Some(1_700_000_000),
            },
            &keys,
        )
        .unwrap()
    }

    #[test]
    fn matches_kind_and_tag() {
        let ev = chat_event("general", "hi");
        let f = Filter::new()
            .kinds(vec![9])
            .tag("h", vec!["general".into()]);
        assert!(f.matches(&ev));
        let f2 = Filter::new().kinds(vec![9]).tag("h", vec!["other".into()]);
        assert!(!f2.matches(&ev));
        let f3 = Filter::new().kinds(vec![7]);
        assert!(!f3.matches(&ev));
    }

    #[test]
    fn serde_roundtrip_with_tag_filter() {
        let f = Filter::new()
            .kinds(vec![9])
            .tag("h", vec!["general".into()])
            .limit(50);
        let json = serde_json::to_string(&f).unwrap();
        assert!(json.contains("\"#h\""));
        let parsed: Filter = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.kinds, Some(vec![9]));
        assert_eq!(
            parsed.tag_filters(),
            vec![("h".to_string(), vec!["general".to_string()])]
        );
        assert_eq!(parsed.limit, Some(50));
    }

    #[test]
    fn since_until_bounds() {
        let ev = chat_event("general", "hi");
        assert!(Filter::new().since(1_600_000_000).matches(&ev));
        assert!(!Filter::new().since(1_800_000_000).matches(&ev));
        let mut f = Filter::new();
        f.until = Some(1_600_000_000);
        assert!(!f.matches(&ev));
    }
}
