// libcef.so must be findable at runtime. Release builds get $ORIGIN (install
// layout: CEF files next to the binary, see scripts/install.sh); dev builds
// also get $CEF_PATH so they run in place.
fn main() {
    println!("cargo::rerun-if-env-changed=CEF_PATH");
    println!("cargo::rustc-link-arg-bins=-Wl,-rpath,$ORIGIN");
    if std::env::var("PROFILE").as_deref() != Ok("release")
        && let Ok(p) = std::env::var("CEF_PATH")
    {
        println!("cargo::rustc-link-arg-bins=-Wl,-rpath,{p}");
    }
}
