//! One corvid per data dir: a later launch pokes the running one over a unix
//! socket (it raises its window) and exits before CEF even loads.

use std::{
    io::Write,
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
};

pub enum Claim {
    Owner(Option<UnixListener>),
    Forwarded,
}

fn socket_path(data_dir: &Path) -> PathBuf {
    // Prefer the runtime dir (tmpfs, per-user 0700); key by data dir so
    // separate profiles can run side by side.
    let key = data_dir.to_string_lossy().bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100_0000_01b3));
    match std::env::var_os("XDG_RUNTIME_DIR") {
        Some(d) => PathBuf::from(d).join(format!("corvid-{key:016x}.sock")),
        None => data_dir.join("corvid.sock"),
    }
}

pub fn claim(data_dir: &Path) -> Claim {
    let p = socket_path(data_dir);
    if let Ok(mut s) = UnixStream::connect(&p) {
        if s.write_all(b"focus\n").is_ok() {
            return Claim::Forwarded;
        }
    }
    // Stale socket from a crash: nobody answered, so take it over.
    let _ = std::fs::remove_file(&p);
    match UnixListener::bind(&p) {
        Ok(l) => Claim::Owner(Some(l)),
        Err(e) => {
            log::warn!("single-instance socket {}: {e}; continuing without it", p.display());
            Claim::Owner(None)
        }
    }
}

/// Call `on_focus` for every later launch.
pub fn serve(listener: UnixListener, on_focus: impl Fn() + Send + 'static) {
    std::thread::Builder::new()
        .name("corvid-instance".into())
        .spawn(move || {
            for conn in listener.incoming() {
                if conn.is_ok() {
                    on_focus();
                }
            }
        })
        .ok();
}
