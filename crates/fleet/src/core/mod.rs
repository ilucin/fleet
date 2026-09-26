//! The reusable core. Nothing in here prints to stdout on its own (dry-run
//! output aside) — rendering belongs to the UIs.

pub mod backend;
pub mod config;
pub mod context;
pub mod discovery;
pub mod grouping;
pub mod hosts;
pub mod naming;
pub mod tmux;
pub mod tools;
