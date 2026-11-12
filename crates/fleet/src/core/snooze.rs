//! `fleet snooze`: set a live session aside until a time. Nothing stops: the session keeps
//! running, `fleet list` stamps the snooze on its row (`snooze: { until, at }`) and the views
//! move it out of the list into Snoozed. Once `until` has passed the row is back in the list,
//! still carrying the stamp, so the views can show it came back from a snooze.
//!
//! Snoozes live in `$FLEET_SNOOZE_STATE`, else `${XDG_STATE_HOME:-~/.local/state}/fleet/snooze.json`:
//! `{ "snoozes": [{ sessionId, tmuxSession, at, until }] }`. A snooze stops counting when the
//! user prompts the session after it was set (they took it up again, snoozed or back), or with
//! `fleet snooze <target> --clear`; `fleet bots tick` drops those and the ones whose session is
//! gone.

use std::path::PathBuf;

use chrono::{Local, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};

use crate::core::discovery::Session;
use crate::error::{Error, Result};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Snooze {
    pub session_id: String,
    pub tmux_session: String,
    /// When it was snoozed (ms epoch).
    pub at: i64,
    /// When it comes back (ms epoch).
    pub until: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    pub snoozes: Vec<Snooze>,
}

/// The snooze as `list` shows it on a row: snoozed while `until` is ahead, back after it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SnoozeRef {
    /// When it was snoozed (ms epoch).
    pub at: i64,
    /// When it comes back (ms epoch).
    pub until: i64,
}

pub fn state_path() -> PathBuf {
    if let Some(p) = std::env::var_os("FLEET_SNOOZE_STATE").filter(|p| !p.is_empty()) {
        return PathBuf::from(crate::core::tools::expand_tilde(&p.to_string_lossy()));
    }
    let base = std::env::var_os("XDG_STATE_HOME")
        .filter(|p| !p.is_empty())
        .map(|p| PathBuf::from(crate::core::tools::expand_tilde(&p.to_string_lossy())))
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".local")
                .join("state")
        });
    base.join("fleet").join("snooze.json")
}

pub fn load() -> State {
    std::fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(st: &State) -> Result<()> {
    let p = state_path();
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(st)?)?;
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

/// Pure: `--until` → ms epoch. Epoch ms, RFC 3339 (`2026-11-13T09:00:00+01:00`), or a local
/// date and time (`2026-11-13 09:00`, `2026-11-13T09:00`).
pub fn parse_until(v: &str) -> std::result::Result<i64, String> {
    let v = v.trim();
    if !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()) {
        return v.parse().map_err(|_| format!("bad time '{v}'"));
    }
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(v) {
        return Ok(t.timestamp_millis());
    }
    for fmt in [
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
    ] {
        if let Ok(n) = NaiveDateTime::parse_from_str(v, fmt) {
            return Local
                .from_local_datetime(&n)
                .earliest()
                .map(|t| t.timestamp_millis())
                .ok_or_else(|| format!("'{v}' does not exist in the local time zone"));
        }
    }
    Err(format!(
        "bad time '{v}' (use 2026-11-13 09:00, an RFC 3339 time, or epoch ms)"
    ))
}

/// Snooze `s` until `until` (ms epoch), replacing an earlier snooze. → the snooze.
pub fn set(s: &Session, until: i64, now: i64) -> Result<Snooze> {
    let sid = s
        .session_id
        .clone()
        .filter(|i| !i.is_empty() && !i.starts_with("pid-"))
        .ok_or_else(|| Error::Other("this session has no session id yet".into()))?;
    if until <= now {
        return Err(Error::Other("that time has already passed".into()));
    }
    let z = Snooze {
        session_id: sid,
        tmux_session: s.tmux_session.clone().unwrap_or_default(),
        at: now,
        until,
    };
    let mut st = load();
    st.snoozes.retain(|x| x.session_id != z.session_id);
    st.snoozes.push(z.clone());
    save(&st)?;
    Ok(z)
}

/// Drop the snooze of session `id` (snoozed, or back from one). → whether there was one.
pub fn clear(id: &str) -> Result<bool> {
    let mut st = load();
    let before = st.snoozes.len();
    st.snoozes.retain(|x| x.session_id != id);
    if st.snoozes.len() == before {
        return Ok(false);
    }
    save(&st)?;
    Ok(true)
}

/// Pure: `z` still stands for session `s` (`None` = gone): not prompted since it was set.
pub fn stands(z: &Snooze, s: Option<&Session>) -> bool {
    s.is_some_and(|s| s.prompted_at.is_none_or(|p| p <= z.at))
}

/// Put `snooze` on every row whose snooze still stands. Read-only.
pub fn stamp_snoozes(rows: &mut [Session]) {
    let st = load();
    if st.snoozes.is_empty() {
        return;
    }
    for r in rows.iter_mut() {
        let Some(id) = r.session_id.as_deref() else {
            continue;
        };
        r.snooze = st
            .snoozes
            .iter()
            .find(|z| z.session_id == id)
            .filter(|z| stands(z, Some(r)))
            .map(|z| SnoozeRef {
                at: z.at,
                until: z.until,
            });
    }
}

/// Drop the snoozes that no longer stand (session gone, or prompted since). → one log line each.
pub fn prune(rows: &[Session]) -> Result<Vec<String>> {
    let mut st = load();
    if st.snoozes.is_empty() {
        return Ok(Vec::new());
    }
    let mut log = Vec::new();
    let before = st.snoozes.len();
    st.snoozes.retain(|z| {
        let s = rows
            .iter()
            .find(|r| r.session_id.as_deref() == Some(z.session_id.as_str()));
        let keep = stands(z, s);
        if !keep {
            let why = if s.is_some() { "prompted" } else { "gone" };
            log.push(format!("snooze: {} dropped ({why})", z.tmux_session));
        }
        keep
    });
    if st.snoozes.len() != before {
        save(&st)?;
    }
    Ok(log)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(prompted: Option<i64>) -> Session {
        Session {
            session_id: Some("abc".into()),
            status: "idle".into(),
            prompted_at: prompted,
            ..Default::default()
        }
    }

    #[test]
    fn a_snooze_stands_until_the_user_prompts() {
        let z = Snooze {
            session_id: "abc".into(),
            at: 1_000,
            until: 5_000,
            ..Default::default()
        };
        assert!(!stands(&z, None));
        assert!(stands(&z, Some(&row(None))));
        assert!(stands(&z, Some(&row(Some(900)))));
        // prompted while snoozed, or after it came back: over
        assert!(!stands(&z, Some(&row(Some(2_000)))));
        assert!(!stands(&z, Some(&row(Some(6_000)))));
    }

    #[test]
    fn parse_until_forms() {
        assert_eq!(parse_until("1763020800000"), Ok(1_763_020_800_000));
        assert_eq!(
            parse_until("2026-11-13T09:00:00+01:00"),
            Ok(chrono::DateTime::parse_from_rfc3339("2026-11-13T08:00:00Z")
                .unwrap()
                .timestamp_millis())
        );
        let local = Local
            .from_local_datetime(
                &NaiveDateTime::parse_from_str("2026-11-13 09:00", "%Y-%m-%d %H:%M").unwrap(),
            )
            .earliest()
            .unwrap()
            .timestamp_millis();
        assert_eq!(parse_until("2026-11-13 09:00"), Ok(local));
        assert_eq!(parse_until("2026-11-13T09:00"), Ok(local));
        assert!(parse_until("tomorrow").is_err());
        assert!(parse_until("").is_err());
    }

    #[test]
    fn set_needs_a_session_id_and_a_future_time() {
        let mut s = row(None);
        s.session_id = Some("pid-12".into());
        assert!(set(&s, 10, 1).is_err());
        assert!(set(&row(None), 1, 2).is_err());
    }
}
