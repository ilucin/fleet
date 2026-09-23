//! Host dispatch, exec, all-hosts aggregation — without a real remote. Remote
//! hops are exercised in dry-run (the ssh command is printed, not run) or
//! against a destination that cannot resolve.

mod common;

use common::{Env, fixture, stderr, stdout, two_hosts};

#[test]
fn tmux_commands_go_to_the_default_host() {
    let env = Env::new();
    env.write_config(&two_hosts());
    let out = env.cmd().args(["-n", "tmux", "list"]).output().unwrap();
    assert!(out.status.success(), "{}", stderr(&out));
    let s = stdout(&out);
    assert!(s.starts_with("ssh "), "{s}");
    assert!(s.contains("devbox"), "{s}");
    assert!(s.contains("BatchMode=yes"), "not a terminal → no pty: {s}");
    assert!(s.contains("--local --as-host workstation tmux list"), "{s}");
    // The dispatcher's own flags don't travel.
    assert!(!s.contains(" -n "), "{s}");
}

#[test]
fn session_commands_stay_on_this_machine_unless_told() {
    let env = Env::new();
    env.write_config(&two_hosts());
    let fx = fixture(
        env.dir.path(),
        r#"[{"pid":7,"session_id":"s-1","name":"demo","status":"idle","backend":"tmux"}]"#,
    );
    let out = env
        .cmd()
        .env("FLEET_FIXTURE", &fx)
        .args(["list", "--json"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v[0]["name"], "demo");
    assert_eq!(v[0]["host"], "laptop", "rows carry this machine's name");

    let out = env
        .cmd()
        .args(["-n", "-H", "workstation", "list", "--json"])
        .output()
        .unwrap();
    assert!(stdout(&out).contains("--as-host workstation list --json"));
    // FLEET_HOST works like -H…
    let out = env
        .cmd()
        .env("FLEET_HOST", "workstation")
        .args(["-n", "list"])
        .output()
        .unwrap();
    assert!(stdout(&out).contains("devbox"), "{}", stdout(&out));
    // …and --local beats both.
    let out = env
        .cmd()
        .env("FLEET_HOST", "workstation")
        .env("FLEET_FIXTURE", &fx)
        .args(["--local", "list", "--json"])
        .output()
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v[0]["name"], "demo");
}

#[test]
fn as_host_tags_rows_with_the_callers_name() {
    let env = Env::new();
    let fx = fixture(
        env.dir.path(),
        r#"[{"pid":7,"session_id":"s-1","name":"demo","status":"idle","backend":"tmux"}]"#,
    );
    let out = env
        .cmd()
        .env("FLEET_FIXTURE", &fx)
        .args(["--local", "--as-host", "workstation", "list", "--json"])
        .output()
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v[0]["host"], "workstation");
}

#[test]
fn directories_are_remapped_for_the_remote_home() {
    let env = Env::new();
    env.write_config(&two_hosts());
    let home = dirs::home_dir().unwrap();
    let dir = home.join("Code/project");
    let out = env
        .cmd()
        .args(["-n", "-H", "workstation", "spawn", "--dir"])
        .arg(&dir)
        .arg("go")
        .output()
        .unwrap();
    let s = stdout(&out);
    assert!(s.contains("~/Code/project"), "{s}");
    assert!(!s.contains(&home.display().to_string()), "{s}");

    let out = env
        .cmd()
        .args(["-n", "new", "x", "-C", "relative/dir"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(stderr(&out).contains("absolute"), "{}", stderr(&out));
}

#[test]
fn unknown_and_address_less_hosts() {
    let env = Env::new();
    let mut cfg = two_hosts();
    cfg["hosts"]["noaddr"] = serde_json::json!({ "ssh": null });
    env.write_config(&cfg);
    let out = env.cmd().args(["-H", "noaddr", "list"]).output().unwrap();
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("no ssh destination"),
        "{}",
        stderr(&out)
    );
    // An unconfigured name is used as an ssh destination as-is.
    let out = env
        .cmd()
        .args(["-n", "-H", "some-alias", "tmux", "list"])
        .output()
        .unwrap();
    assert!(stdout(&out).contains(" some-alias "), "{}", stdout(&out));
}

#[test]
fn an_unreachable_host_is_a_clear_error() {
    let env = Env::new();
    let mut cfg = two_hosts();
    cfg["hosts"]["workstation"]["ssh"] = serde_json::json!("fleet-test-host.invalid");
    env.write_config(&cfg);
    let out = env
        .cmd()
        .args(["tmux", "list"])
        .timeout(std::time::Duration::from_secs(20))
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(4), "{}", stderr(&out));
    assert!(
        stderr(&out).contains("cannot reach 'workstation'"),
        "{}",
        stderr(&out)
    );
}

#[test]
fn list_all_hosts_keeps_going_past_a_dead_host() {
    let env = Env::new();
    let mut cfg = two_hosts();
    cfg["hosts"]["workstation"]["ssh"] = serde_json::json!("fleet-test-host.invalid");
    env.write_config(&cfg);
    let fx = fixture(
        env.dir.path(),
        r#"[{"pid":7,"session_id":"s-1","name":"demo","status":"idle","backend":"tmux"}]"#,
    );
    let out = env
        .cmd()
        .env("FLEET_FIXTURE", &fx)
        .args(["list", "--all-hosts", "--json"])
        .timeout(std::time::Duration::from_secs(30))
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", stderr(&out));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v.as_array().unwrap().len(), 1);
    assert_eq!(v[0]["host"], "laptop");
    assert!(stderr(&out).contains("workstation"), "{}", stderr(&out));

    let out = env
        .cmd()
        .env("FLEET_FIXTURE", &fx)
        .args(["list", "--all-hosts"])
        .timeout(std::time::Duration::from_secs(30))
        .output()
        .unwrap();
    assert!(stdout(&out).contains("FLEET @ laptop"), "{}", stdout(&out));
}

#[test]
fn exec_passes_the_exit_code_through() {
    let env = Env::new();
    let out = env
        .cmd()
        .args(["exec", "--", "sh", "-c", "exit 7"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(7));
    let tmp = env.dir.path().canonicalize().unwrap();
    let out = env
        .cmd()
        .args(["exec", "-C"])
        .arg(&tmp)
        .args(["--", "pwd"])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        std::path::Path::new(stdout(&out).trim())
            .canonicalize()
            .unwrap(),
        tmp
    );
}

#[test]
fn remote_exec_is_a_plain_ssh_hop() {
    let env = Env::new();
    env.write_config(&two_hosts());
    let out = env
        .cmd()
        .args([
            "-n",
            "-H",
            "workstation",
            "exec",
            "-C",
            "~/x",
            "--",
            "echo",
            "a b",
        ])
        .output()
        .unwrap();
    let s = stdout(&out);
    assert!(s.contains("devbox"), "{s}");
    assert!(s.contains("cd \"$HOME\"/x && exec echo "), "{s}");
    assert!(
        !s.contains("--local"),
        "exec needs no fleet on the remote: {s}"
    );
}

#[test]
fn install_needs_a_remote_host() {
    let env = Env::new();
    env.write_config(&two_hosts());
    let out = env.cmd().arg("install").output().unwrap();
    assert!(!out.status.success());
    let out = env
        .cmd()
        .args(["install", "--host", "laptop"])
        .output()
        .unwrap();
    assert!(
        !out.status.success(),
        "installing onto yourself is a mistake"
    );
    let out = env
        .cmd()
        .args(["-n", "install", "--host", "workstation", "--no-web"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", stderr(&out));
    let s = stdout(&out);
    assert!(s.contains("uname -sm"), "{s}");
    assert!(s.contains("scp "), "{s}");
    assert!(s.contains("devbox:.local/bin/fleet.new"), "{s}");
}

#[test]
fn doctor_runs_with_no_config() {
    let env = Env::new();
    let out = env
        .cmd()
        .arg("doctor")
        .timeout(std::time::Duration::from_secs(30))
        .output()
        .unwrap();
    let s = stdout(&out);
    assert!(s.contains("fleet doctor"), "{s}");
    assert!(s.contains("this machine"), "{s}");
    assert!(s.contains("fleet init"), "{s}");
}

#[test]
fn probe_is_json() {
    let env = Env::new();
    let out = env.cmd().arg("_probe").output().unwrap();
    assert!(out.status.success());
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["fleetVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(v["configExists"], false);
}

#[test]
fn skill_is_embedded_and_generic() {
    let env = Env::new();
    let out = env.cmd().args(["skill", "show"]).output().unwrap();
    let s = stdout(&out);
    assert!(s.contains("name: fleet"), "{s}");
    assert!(s.contains("fleet list"), "{s}");
    assert!(!s.contains("tb-fleet"), "{s}");
}

#[test]
fn web_serve_runs_node_with_the_config() {
    if fleet::core::tools::find_binary("node").is_none() {
        return;
    }
    let env = Env::new();
    let web = env.path("web");
    std::fs::create_dir_all(&web).unwrap();
    std::fs::write(web.join("server.mjs"), "").unwrap();
    let out = env
        .cmd()
        .args(["-n", "web", "serve", "--port", "7799", "--dir"])
        .arg(&web)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", stderr(&out));
    let s = stdout(&out);
    assert!(s.contains("FLEET_CONFIG="), "{s}");
    assert!(s.contains("FLEET_WEB_PORT=7799"), "{s}");
    assert!(s.contains("server.mjs"), "{s}");

    let out = env
        .cmd()
        .args(["web", "serve", "--dir"])
        .arg(env.path("nowhere"))
        .output()
        .unwrap();
    assert!(!out.status.success());
}

#[cfg(target_os = "macos")]
#[test]
fn web_service_prints_a_launchd_plist() {
    let env = Env::new();
    let out = env
        .cmd()
        .args(["web", "install-service", "--print"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let s = stdout(&out);
    assert!(s.contains("<key>ProgramArguments</key>"), "{s}");
    assert!(s.contains(&env.config_path().display().to_string()), "{s}");
}
