//! CEF (Chromium) backend.
//!
//! Process model: CEF re-executes this binary for its renderer/GPU/utility
//! subprocesses. The browser process owns the window and the corvid-core
//! [`Host`]; renderer processes inject the mod bundle into discord.com main
//! frames at context creation (before any page script) and forward its
//! native calls to the browser process as CEF process messages.

use std::{
    cell::RefCell,
    os::unix::net::UnixListener,
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};

use cef::*;
use corvid_core::{Host, Paths, Ui, bundle, privacy};
use serde_json::{Value, json};

use crate::{Options, ms};

const MSG_IPC: &str = "corvid-ipc";
const MSG_CONFIG: &str = "corvid-config";
const NATIVE_POST: &str = "__corvidNative";

static RELAUNCH: AtomicBool = AtomicBool::new(false);

fn cs(s: &str) -> CefString {
    CefString::from(s)
}

/// A string for a struct out-parameter. cef-rs turns an owned `CefString`
/// into an empty C string when writing such structs back (only "borrowed"
/// strings pass through), so allocate the copy with CEF's own allocator and
/// wrap it as borrowed; CEF frees it with the struct.
fn cs_out(s: &str) -> CefString {
    let utf16: Vec<u16> = s.encode_utf16().collect();
    let mut raw: sys::_cef_string_utf16_t = unsafe { std::mem::zeroed() };
    // SAFETY: valid UTF-16 slice; copy=1 makes CEF own the new buffer.
    unsafe { sys::cef_string_utf16_set(utf16.as_ptr(), utf16.len(), &mut raw, 1) };
    CefString::from(raw)
}

fn us(s: &CefStringUserfree) -> String {
    CefString::from(s).to_string()
}

const DISCORD_HOSTS: &[&str] = &["discord.com", "ptb.discord.com", "canary.discord.com"];

fn is_discord(uri: &str) -> bool {
    url::Url::parse(uri)
        .ok()
        .filter(|u| u.scheme() == "https")
        .and_then(|u| u.host_str().map(|h| DISCORD_HOSTS.contains(&h)))
        .unwrap_or(false)
}

fn is_web(uri: &str) -> bool {
    uri.starts_with("https://") || uri.starts_with("http://")
}

fn xdg_open(target: &str) {
    match Command::new("xdg-open").arg(target).spawn() {
        Ok(mut c) => {
            std::thread::spawn(move || c.wait());
        }
        Err(e) => log::error!("xdg-open {target}: {e}"),
    }
}

/// CEF runtime files: next to the binary when installed, else $CEF_PATH,
/// else ~/.local/share/cef (dev builds).
fn cef_dir() -> std::path::PathBuf {
    if let Some(dir) = crate::exe_dir()
        && dir.join("libcef.so").exists()
    {
        return dir;
    }
    std::env::var_os("CEF_PATH")
        .map(Into::into)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share/cef")))
        .unwrap_or_default()
}

fn cef_version() -> String {
    std::str::from_utf8(sys::CEF_VERSION).unwrap_or("").trim_end_matches('\0').to_owned()
}

// ---------------------------------------------------------------- browser process state

struct Req {
    id: u64,
    cmd: String,
    args: Value,
}

/// Browser-process state that is safe to share with worker threads.
struct Shared {
    host: Arc<Host>,
    /// Name of the page global the host calls back into.
    token: String,
    /// core.js + plugins (config is prefixed per document).
    body: String,
    opts: Options,
    work_tx: Mutex<mpsc::Sender<Req>>,
    /// The theme watcher is running, so the host's compiled sheets track disk.
    watching: AtomicBool,
    /// The browser's extra_info already carries a fresh config: skip the
    /// duplicate push for the first Discord navigation.
    skip_config_push: AtomicBool,
}

impl Shared {
    /// `fresh`: compile themes from disk; otherwise reuse the compiled sheets
    /// (kept current by the watcher) when the watcher is running.
    fn config_json(&self, fresh: bool) -> String {
        let css = if fresh || !self.watching.load(Ordering::Relaxed) {
            self.host.initial_css()
        } else {
            self.host.css_snapshot()
        };
        json!({
            "settings": self.host.settings(),
            "css": css,
            "token": self.token,
            "version": versions(),
        })
        .to_string()
    }

    /// `window[token].<method>(args...)` as a JS statement.
    fn call_js(&self, method: &str, args: &[Value]) -> String {
        let args: Vec<String> = args.iter().map(Value::to_string).collect();
        format!("window[{}]?.{method}({});", Value::from(self.token.as_str()), args.join(","))
    }
}

fn versions() -> Value {
    let cef = cef_version();
    json!({ "corvid": env!("CARGO_PKG_VERSION"), "cef": cef, "chrome": cef.rsplit('-').next() })
}

thread_local! {
    /// UI-thread-only CEF objects (not Send).
    static UI: RefCell<UiState> = RefCell::new(UiState::default());
}

#[derive(Default)]
struct UiState {
    browser: Option<Browser>,
    window: Option<Window>,
}

fn with_main_frame(f: impl FnOnce(&Frame)) {
    UI.with(|ui| {
        if let Some(frame) = ui.borrow().browser.as_ref().and_then(|b| b.main_frame()) {
            f(&frame);
        }
    });
}

wrap_task! {
    struct EvalTask {
        js: String,
    }

    impl Task {
        fn execute(&self) {
            with_main_frame(|f| {
                let u = us(&f.url());
                if is_discord(&u) || u.starts_with("file://") {
                    f.execute_java_script(Some(&cs(&self.js)), Some(&cs("corvid://host")), 0);
                }
            });
        }
    }
}

fn post_eval(js: String) {
    let mut t = EvalTask::new(js);
    post_task(ThreadId::UI, Some(&mut t));
}

wrap_task! {
    struct FocusTask {}

    impl Task {
        fn execute(&self) {
            UI.with(|ui| {
                if let Some(w) = ui.borrow().window.as_ref() {
                    if w.is_minimized() != 0 {
                        w.restore();
                    }
                    w.show();
                    w.activate();
                }
            });
        }
    }
}

wrap_task! {
    struct CloseTask {}

    impl Task {
        fn execute(&self) {
            UI.with(|ui| {
                if let Some(h) = ui.borrow().browser.as_ref().and_then(|b| b.host()) {
                    h.close_browser(1);
                }
            });
        }
    }
}

// Send the renderer fresh config so the next document (reload, navigation)
// gets current settings and CSS.
wrap_task! {
    struct PushConfigTask {
        config: String,
    }

    impl Task {
        fn execute(&self) {
            with_main_frame(|f| send_config(f, &self.config));
        }
    }
}

fn send_config(f: &Frame, config: &str) {
    if let Some(mut msg) = process_message_create(Some(&cs(MSG_CONFIG))) {
        if let Some(args) = msg.argument_list() {
            args.set_string(0, Some(&cs(config)));
        }
        f.send_process_message(ProcessId::RENDERER, Some(&mut msg));
    }
}

struct CefUi {
    shared: std::sync::Weak<Shared>,
}

impl Ui for CefUi {
    fn set_css(&self, id: &str, css: Option<&str>) {
        if let Some(s) = self.shared.upgrade() {
            post_eval(s.call_js("css", &[id.into(), css.map(Value::from).unwrap_or(Value::Null)]));
        }
    }
    fn emit(&self, name: &str, payload: Value) {
        if let Some(s) = self.shared.upgrade() {
            post_eval(s.call_js("event", &[name.into(), payload]));
        }
    }
    fn open_external(&self, target: &str) {
        xdg_open(target);
    }
    fn relaunch(&self) {
        RELAUNCH.store(true, Ordering::SeqCst);
        let mut t = CloseTask::new();
        post_task(ThreadId::UI, Some(&mut t));
    }
    fn versions(&self) -> Value {
        versions()
    }
}

// ---------------------------------------------------------------- browser-side handlers

wrap_client! {
    struct CorvidClient {
        shared: Arc<Shared>,
    }

    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(CorvidLifeSpan::new())
        }
        fn request_handler(&self) -> Option<RequestHandler> {
            Some(CorvidRequests::new(self.shared.clone()))
        }
        fn permission_handler(&self) -> Option<PermissionHandler> {
            Some(CorvidPermissions::new(self.shared.opts.smoke_js.is_some()))
        }
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(CorvidDisplay::new(self.shared.opts.smoke_js.is_some()))
        }
        fn load_handler(&self) -> Option<LoadHandler> {
            Some(CorvidLoad::new(self.shared.clone()))
        }

        fn on_process_message_received(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _source_process: ProcessId,
            message: Option<&mut ProcessMessage>,
        ) -> i32 {
            let (Some(frame), Some(message)) = (frame, message) else { return 0 };
            if us(&message.name()) != MSG_IPC {
                return 0;
            }
            // Only the Discord main frame may talk to the host.
            let url = us(&frame.url());
            let test_page = self.shared.opts.smoke_js.is_some() && url.starts_with("file://");
            if frame.is_main() == 0 || !(is_discord(&url) || test_page) {
                log::warn!("dropping IPC from non-main or non-Discord frame {url}");
                return 1;
            }
            let Some(raw) = message.argument_list().map(|a| us(&a.string(0))) else { return 1 };
            let Ok(v) = serde_json::from_str::<Value>(&raw) else { return 1 };
            let (Some(id), Some(cmd)) = (v["id"].as_u64(), v["cmd"].as_str()) else { return 1 };
            let req = Req { id, cmd: cmd.to_owned(), args: v["args"].clone() };
            let _ = self.shared.work_tx.lock().unwrap().send(req);
            1
        }
    }
}

fn run_request(shared: &Shared, req: Req) {
    let r = shared.host.invoke(&req.cmd, &req.args);
    if let Err(e) = &r {
        log::debug!("{} failed: {e}", req.cmd);
    }
    let (ok, val) = match r {
        Ok(v) => (true, v),
        Err(e) => (false, Value::String(e)),
    };
    post_eval(shared.call_js("reply", &[req.id.into(), ok.into(), val]));
}

wrap_life_span_handler! {
    struct CorvidLifeSpan {}

    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            log::info!("[{} ms] browser created", ms());
            UI.with(|ui| {
                let mut ui = ui.borrow_mut();
                if ui.browser.is_none() {
                    ui.browser = browser.cloned();
                }
            });
        }

        fn on_before_close(&self, browser: Option<&mut Browser>) {
            let is_main = UI.with(|ui| {
                let ui = ui.borrow();
                match (ui.browser.as_ref(), browser) {
                    (Some(main), Some(b)) => main.is_same(Some(b)) != 0,
                    _ => false,
                }
            });
            if is_main {
                UI.with(|ui| *ui.borrow_mut() = UiState::default());
                quit_message_loop();
            }
        }

        fn on_before_popup(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _popup_id: i32,
            target_url: Option<&CefString>,
            _target_frame_name: Option<&CefString>,
            _target_disposition: WindowOpenDisposition,
            _user_gesture: i32,
            _popup_features: Option<&PopupFeatures>,
            _window_info: Option<&mut WindowInfo>,
            _client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            _no_javascript_access: Option<&mut i32>,
        ) -> i32 {
            // window.open / target=_blank: hand web links to the desktop browser.
            if let Some(u) = target_url.map(|u| u.to_string())
                && is_web(&u)
            {
                xdg_open(&u);
            }
            1
        }
    }
}

wrap_request_handler! {
    struct CorvidRequests {
        shared: Arc<Shared>,
    }

    impl RequestHandler {
        fn on_before_browse(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            request: Option<&mut Request>,
            user_gesture: i32,
            _is_redirect: i32,
        ) -> i32 {
            let (Some(frame), Some(request)) = (frame, request) else { return 0 };
            if frame.is_main() == 0 {
                return 0;
            }
            let url = us(&request.url());
            // Keep the main frame on Discord; user-clicked links elsewhere go to the browser.
            if user_gesture != 0 && is_web(&url) && !is_discord(&url) {
                xdg_open(&url);
                return 1;
            }
            // New document coming (reload/navigation): refresh the renderer's config.
            if is_discord(&url) && !self.shared.skip_config_push.swap(false, Ordering::Relaxed) {
                send_config(frame, &self.shared.config_json(false));
            }
            0
        }

        fn resource_request_handler(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            request: Option<&mut Request>,
            _is_navigation: i32,
            _is_download: i32,
            _request_initiator: Option<&CefString>,
            _disable_default_handling: Option<&mut i32>,
        ) -> Option<ResourceRequestHandler> {
            if !self.shared.host.options.block_telemetry {
                return None;
            }
            let url = us(&request?.url());
            privacy::is_telemetry(&url).then(|| {
                log::debug!("telemetry answered locally: {url}");
                TelemetrySink::new()
            })
        }
    }
}

// Requests to telemetry endpoints get an empty 204 from here instead of the
// network, so Discord's code sees success and doesn't queue retries.
wrap_resource_request_handler! {
    struct TelemetrySink {}

    impl ResourceRequestHandler {
        fn resource_handler(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _request: Option<&mut Request>,
        ) -> Option<ResourceHandler> {
            Some(NoContent::new())
        }
    }
}

wrap_resource_handler! {
    struct NoContent {}

    impl ResourceHandler {
        fn open(
            &self,
            _request: Option<&mut Request>,
            handle_request: Option<&mut i32>,
            _callback: Option<&mut Callback>,
        ) -> i32 {
            if let Some(h) = handle_request {
                *h = 1;
            }
            1
        }

        fn response_headers(
            &self,
            response: Option<&mut Response>,
            response_length: Option<&mut i64>,
            _redirect_url: Option<&mut CefString>,
        ) {
            if let Some(r) = response {
                r.set_status(204);
                r.set_status_text(Some(&cs("No Content")));
                r.set_mime_type(Some(&cs("text/plain")));
                r.set_header_by_name(Some(&cs("Access-Control-Allow-Origin")), Some(&cs("*")), 1);
            }
            if let Some(l) = response_length {
                *l = 0;
            }
        }

        fn read(
            &self,
            _data_out: *mut u8,
            _bytes_to_read: i32,
            bytes_read: Option<&mut i32>,
            _callback: Option<&mut ResourceReadCallback>,
        ) -> i32 {
            if let Some(b) = bytes_read {
                *b = 0;
            }
            0
        }
    }
}

wrap_permission_handler! {
    struct CorvidPermissions {
        // --smoke-js: also grant file:// test pages
        test: bool,
    }

    impl PermissionHandler {
        fn on_request_media_access_permission(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            requesting_origin: Option<&CefString>,
            requested_permissions: u32,
            callback: Option<&mut MediaAccessCallback>,
        ) -> i32 {
            let origin = requesting_origin.map(|o| o.to_string()).unwrap_or_default();
            let Some(cb) = callback else { return 0 };
            if is_discord(&origin) || (self.test && origin.starts_with("file://")) {
                log::info!("granting media access {requested_permissions:#x} to {origin}");
                cb.cont(requested_permissions);
            } else {
                log::info!("denying media access to {origin}");
                cb.cont(0);
            }
            1
        }

        fn on_show_permission_prompt(
            &self,
            _browser: Option<&mut Browser>,
            _prompt_id: u64,
            requesting_origin: Option<&CefString>,
            requested_permissions: u32,
            callback: Option<&mut PermissionPromptCallback>,
        ) -> i32 {
            let origin = requesting_origin.map(|o| o.to_string()).unwrap_or_default();
            let Some(cb) = callback else { return 0 };
            let ok = is_discord(&origin) || (self.test && origin.starts_with("file://"));
            log::info!(
                "{} permission prompt {requested_permissions:#x} for {origin}",
                if ok { "accepting" } else { "denying" }
            );
            cb.cont(if ok { PermissionRequestResult::ACCEPT } else { PermissionRequestResult::DENY });
            1
        }
    }
}

wrap_display_handler! {
    struct CorvidDisplay {
        test: bool,
    }

    impl DisplayHandler {
        fn on_title_change(&self, browser: Option<&mut Browser>, title: Option<&CefString>) {
            let t = title.map(|t| t.to_string()).unwrap_or_default();
            if self.test && let Some(r) = t.strip_prefix("SMOKE:") {
                println!("SMOKE {r}");
                if let Some(h) = browser.and_then(|b| b.host()) {
                    h.close_browser(1);
                }
                return;
            }
            let t = if t.is_empty() { "corvid".to_owned() } else { format!("{t} - corvid") };
            UI.with(|ui| {
                if let Some(w) = ui.borrow().window.as_ref() {
                    w.set_title(Some(&cs(&t)));
                }
            });
        }

        fn on_console_message(
            &self,
            _browser: Option<&mut Browser>,
            level: LogSeverity,
            message: Option<&CefString>,
            source: Option<&CefString>,
            line: i32,
        ) -> i32 {
            // corvid's own lines (and everything under --smoke-js) go to the log.
            let m = message.map(|m| m.to_string()).unwrap_or_default();
            if self.test || m.contains("[corvid]") {
                let src = source.map(|s| s.to_string()).unwrap_or_default();
                log::info!("[{} ms] console {level:?}: {m} ({src}:{line})", ms());
            }
            0
        }
    }
}

wrap_load_handler! {
    struct CorvidLoad {
        shared: Arc<Shared>,
    }

    impl LoadHandler {
        fn on_load_end(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, _status: i32) {
            let (Some(_), Some(frame)) = (browser, frame) else { return };
            if frame.is_main() == 0 {
                return;
            }
            log::info!("[{} ms] load end {}", ms(), us(&frame.url()));
            let Some(body) = self.shared.opts.smoke_js.clone() else { return };
            // --smoke-js: run the script, report through the title.
            let wrapped = format!(
                "(async () => {{ let r; try {{ r = await (async () => {{ {body}\n }})(); }} catch (e) {{ r = 'SMOKE-ERROR ' + (e && e.stack || e); }} \
                 document.title = 'SMOKE:' + r; }})();"
            );
            frame.execute_java_script(Some(&cs(&wrapped)), Some(&cs("corvid://smoke.js")), 0);
        }
    }
}

wrap_browser_view_delegate! {
    struct CorvidBrowserViewDelegate {}

    impl ViewDelegate {}

    impl BrowserViewDelegate {
        fn on_popup_browser_view_created(
            &self,
            _browser_view: Option<&mut BrowserView>,
            popup_browser_view: Option<&mut BrowserView>,
            _is_devtools: i32,
        ) -> i32 {
            // Only DevTools gets here (other popups are cancelled): give it a window.
            let mut d = CorvidWindowDelegate::new(RefCell::new(popup_browser_view.cloned()), false);
            window_create_top_level(Some(&mut d));
            1
        }
    }
}

wrap_window_delegate! {
    struct CorvidWindowDelegate {
        browser_view: RefCell<Option<BrowserView>>,
        main: bool,
    }

    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 1280, height: 800 }
        }
    }

    impl PanelDelegate {}

    impl WindowDelegate {
        fn on_window_created(&self, window: Option<&mut Window>) {
            let (Some(window), Some(bv)) = (window, self.browser_view.borrow().clone()) else { return };
            window.add_child_view(Some(&mut View::from(&bv)));
            window.set_title(Some(&cs("corvid")));
            if self.main {
                UI.with(|ui| ui.borrow_mut().window = Some(window.clone()));
            }
            window.show();
            log::info!("[{} ms] window shown", ms());
        }

        fn on_window_destroyed(&self, _window: Option<&mut Window>) {
            *self.browser_view.borrow_mut() = None;
        }

        fn linux_window_properties(
            &self,
            _window: Option<&mut Window>,
            properties: Option<&mut LinuxWindowProperties>,
        ) -> i32 {
            // Wayland app_id / X11 WM_CLASS, matching corvid.desktop.
            let Some(p) = properties else { return 0 };
            p.wayland_app_id = cs_out("corvid");
            p.wm_class_class = cs_out("corvid");
            p.wm_class_name = cs_out("corvid");
            1
        }

        // cef-rs defaults unimplemented methods to 0, but CEF's C++ defaults for
        // these are true; without them the window is fixed-size, which tiling
        // compositors (Hyprland) treat as a floating dialog.
        fn can_resize(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        fn can_maximize(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        fn can_minimize(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        fn with_standard_window_buttons(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        fn can_close(&self, _window: Option<&mut Window>) -> i32 {
            match self.browser_view.borrow().as_ref().and_then(|bv| bv.browser()) {
                Some(b) => b.host().map(|h| h.try_close_browser()).unwrap_or(1),
                None => 1,
            }
        }
    }
}

// Browsers Chromium creates on its own (Chrome-style session restore after
// an unclean exit, startup URLs) get this client and are closed at once.
wrap_client! {
    struct StrayClient {}

    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(StrayLifeSpan::new())
        }
    }
}

wrap_life_span_handler! {
    struct StrayLifeSpan {}

    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            let Some(browser) = browser else { return };
            let url = browser.main_frame().map(|f| us(&f.url())).unwrap_or_default();
            log::info!("closing browser window not opened by corvid ({url})");
            if let Some(h) = browser.host() {
                h.close_browser(1);
            }
        }
    }
}

/// Persistently allow mic + camera for Discord. CEF's media-access callback
/// only answers single requests; without a stored content setting Chromium
/// keeps the permission at "prompt", so enumerateDevices() hides device ids
/// and labels and Discord finds no microphone.
fn grant_capture(origins: &[String]) {
    let Some(ctx) = request_context_get_global_context() else {
        log::error!("no global request context; mic/camera permission not stored");
        return;
    };
    for o in origins {
        let url = cs(o);
        for kind in [
            ContentSettingTypes::MEDIASTREAM_MIC,
            ContentSettingTypes::MEDIASTREAM_CAMERA,
            ContentSettingTypes::NOTIFICATIONS,
        ] {
            ctx.set_content_setting(Some(&url), Some(&url), kind, ContentSettingValues::ALLOW);
        }
    }
}

wrap_browser_process_handler! {
    struct CorvidBrowserProcess {
        shared: Arc<Shared>,
    }

    impl BrowserProcessHandler {
        fn default_client(&self) -> Option<Client> {
            Some(StrayClient::new())
        }

        fn on_context_initialized(&self) {
            log::info!("[{} ms] CEF context initialized", ms());
            let shared = self.shared.clone();
            let origins: Vec<String> = DISCORD_HOSTS.iter().map(|h| format!("https://{h}/")).collect();
            grant_capture(&origins);
            let mut client = CorvidClient::new(shared.clone());

            // The renderer can't read files: hand it everything up front.
            let mut extra = dictionary_value_create().expect("dictionary");
            extra.set_string(Some(&cs("config")), Some(&cs(&shared.config_json(true))));
            shared.skip_config_push.store(is_discord(&shared.opts.url), Ordering::Relaxed);
            extra.set_string(Some(&cs("body")), Some(&cs(&shared.body)));

            let settings = BrowserSettings {
                background_color: shared.host.options.background,
                ..Default::default()
            };
            let mut bv_delegate = CorvidBrowserViewDelegate::new();
            let bv = browser_view_create(
                Some(&mut client),
                Some(&cs(&shared.opts.url)),
                Some(&settings),
                Some(&mut extra),
                None,
                Some(&mut bv_delegate),
            );
            let mut wd = CorvidWindowDelegate::new(RefCell::new(bv), true);
            window_create_top_level(Some(&mut wd));
        }
    }
}

// ---------------------------------------------------------------- renderer process

#[derive(Default)]
struct RendererData {
    config: String,
    body: String,
}

thread_local! {
    static RENDERER: RefCell<RendererData> = RefCell::new(RendererData::default());
}

// `__corvidNative(json)`: forward a native call to the browser process.
wrap_v8_handler! {
    struct NativePost {
        frame: Frame,
    }

    impl V8Handler {
        fn execute(
            &self,
            _name: Option<&CefString>,
            _object: Option<&mut V8Value>,
            arguments: Option<&[Option<V8Value>]>,
            _retval: Option<&mut Option<V8Value>>,
            _exception: Option<&mut CefString>,
        ) -> i32 {
            let Some(arg) = arguments.and_then(|a| a.first().cloned().flatten()) else { return 0 };
            let s = us(&arg.string_value());
            if let Some(mut msg) = process_message_create(Some(&cs(MSG_IPC))) {
                if let Some(args) = msg.argument_list() {
                    args.set_string(0, Some(&cs(&s)));
                }
                self.frame.send_process_message(ProcessId::BROWSER, Some(&mut msg));
            }
            1
        }
    }
}

wrap_render_process_handler! {
    struct CorvidRenderProcess {}

    impl RenderProcessHandler {
        fn on_browser_created(&self, _browser: Option<&mut Browser>, extra_info: Option<&mut DictionaryValue>) {
            let Some(extra) = extra_info else { return };
            let get = |k: &str| us(&extra.string(Some(&cs(k))));
            RENDERER.with(|r| {
                let mut r = r.borrow_mut();
                r.config = get("config");
                r.body = get("body");
            });
        }

        fn on_process_message_received(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            source_process: ProcessId,
            message: Option<&mut ProcessMessage>,
        ) -> i32 {
            let Some(message) = message else { return 0 };
            if source_process != ProcessId::BROWSER || us(&message.name()) != MSG_CONFIG {
                return 0;
            }
            if let Some(cfg) = message.argument_list().map(|a| us(&a.string(0))) {
                RENDERER.with(|r| r.borrow_mut().config = cfg);
            }
            1
        }

        fn on_context_created(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            context: Option<&mut V8Context>,
        ) {
            let (Some(frame), Some(context)) = (frame, context) else { return };
            if frame.is_main() == 0 {
                return;
            }
            let url = us(&frame.url());
            let test_page = std::env::var_os("CORVID_TEST_ANY_PAGE").is_some() && url.starts_with("file://");
            if !is_discord(&url) && !test_page {
                return;
            }
            let script = RENDERER.with(|r| {
                let r = r.borrow();
                (!r.body.is_empty()).then(|| bundle::with_config(&r.config, &r.body))
            });
            let Some(script) = script else {
                log::error!("no mod bundle in renderer; corvid not injected");
                return;
            };

            // Define the native post function, then run the bundle
            // synchronously, before any page script.
            let Some(global) = context.global() else { return };
            let mut handler = NativePost::new(frame.clone());
            if let Some(mut f) = v8_value_create_function(Some(&cs(NATIVE_POST)), Some(&mut handler)) {
                global.set_value_bykey(Some(&cs(NATIVE_POST)), Some(&mut f), V8Propertyattribute::default());
            }
            let mut ret = None;
            let mut exc = None;
            if context.eval(Some(&cs(&script)), Some(&cs("corvid://bundle.js")), 1, Some(&mut ret), Some(&mut exc)) == 0 {
                let m = exc.map(|e| us(&e.message())).unwrap_or_default();
                log::error!("corvid bundle threw: {m}");
            }
        }
    }
}

// ---------------------------------------------------------------- app

/// Chromium switches. Everything here is about startup time, memory and not
/// phoning home; voice/video/screen share must keep working.
fn configure_switches(cl: &mut CommandLine, o: &corvid_core::settings::HostOptions) {
    let has = |k: &str| cl.has_switch(Some(&cs(k))) != 0;
    let sw = |k: &str| cl.append_switch(Some(&cs(k)));
    let swv = |k: &str, v: &str| cl.append_switch_with_value(Some(&cs(k)), Some(&cs(v)));

    // Native Wayland when available (falls back to X11).
    if !has("ozone-platform") {
        swv("ozone-platform-hint", "auto");
    }
    // Audio service in the browser process (one fewer process). The network
    // service stays out of process: CEF 156 ignores NetworkServiceInProcess
    // and NetworkServiceInProcess2 (checked: the utility process still runs).
    // GPU stays separate so a driver crash doesn't take the app down.
    // Screen share via PipeWire needs no feature any more
    // ("WebRTCPipeWireCapturer" is gone from Chromium).
    let enable: Vec<&str> = vec![];
    let disable = vec![
        // Google services / background traffic CEF doesn't need
        "Translate",
        "MediaRouter",
        "DialMediaRouteProvider",
        "OptimizationHints",
        "AutofillServerCommunication",
        "NetworkTimeServiceQuerying",
        // Chrome-style browsers preconnect to the default search engine (Google)
        "SearchEnginePreconnect2",
        "PreconnectToSearch",
        // resources
        "SpareRendererForSitePerProcess", // no idle spare renderer (~30-50 MB)
        "BackForwardCache",
        "HardwareMediaKeyHandling", // no MPRIS player for Discord's sounds
        // Chrome's AGC moving the system mic volume around
        "WebRtcAllowInputVolumeAdjustment",
        "AudioServiceOutOfProcess",
    ];
    if o.low_memory {
        sw("in-process-gpu");
        sw("process-per-site");
        swv("renderer-process-limit", "2");
    }
    // V8 flags; a --js-flags given on the command line wins (A/B testing).
    if !has("js-flags") {
        let mut js = Vec::new();
        if o.compact_heap {
            js.push("--optimize-for-size");
        }
        if o.low_memory {
            js.push("--max-lazy");
        }
        if !js.is_empty() {
            swv("js-flags", &js.join(" "));
        }
    }
    // Chromium keeps only the last value of a switch, and CEF puts its own
    // feature lists there (dropping them crashes the Chrome UI glue): merge.
    let merged = |k: &str, ours: &[&str]| {
        let cur = us(&cl.switch_value(Some(&cs(k))));
        log::debug!("existing --{k}={cur}");
        let mut all: Vec<&str> = cur.split(',').filter(|s| !s.is_empty()).collect();
        all.extend(ours.iter().copied());
        all.join(",")
    };
    let en = merged("enable-features", &enable);
    let dis = merged("disable-features", &disable);
    swv("enable-features", &en);
    swv("disable-features", &dis);

    for s in [
        "disable-background-networking",
        "disable-component-update",
        "disable-domain-reliability",
        "disable-breakpad",
        "disable-crash-reporter",
        "disable-sync",
        "no-pings",
        "no-first-run",
        "no-default-browser-check",
        "disable-default-apps",
        "disable-client-side-phishing-detection",
    ] {
        sw(s);
    }
    // Discord plays notification/ringing sounds without a click first.
    swv("autoplay-policy", "no-user-gesture-required");
    if o.hide_local_ips && !has("force-webrtc-ip-handling-policy") {
        swv("force-webrtc-ip-handling-policy", "default_public_interface_only");
    }
    if !o.spellcheck {
        sw("disable-spell-checking");
    }
    if !o.gpu {
        sw("disable-gpu");
        sw("disable-gpu-compositing");
    }
    if !o.proxy.is_empty() && !has("proxy-server") {
        swv("proxy-server", &o.proxy);
        // DNS through the proxy too (socks5 resolves remotely).
        swv("host-resolver-rules", "MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
    }
}

wrap_app! {
    struct CorvidApp {
        shared: Option<Arc<Shared>>,
    }

    impl App {
        fn on_before_command_line_processing(
            &self,
            process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            let is_browser = process_type.map(|p| p.to_string().is_empty()).unwrap_or(true);
            let (Some(cl), Some(shared)) = (command_line, self.shared.as_ref()) else { return };
            if is_browser {
                configure_switches(cl, &shared.host.options);
            }
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            self.shared.as_ref().map(|s| CorvidBrowserProcess::new(s.clone()))
        }

        fn render_process_handler(&self) -> Option<RenderProcessHandler> {
            Some(CorvidRenderProcess::new())
        }
    }
}

/// Call first thing in `main`. In a CEF subprocess this runs it and returns
/// its exit code; in the browser process it returns `None`.
pub fn run_subprocess_if_needed() -> Option<i32> {
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    let args = cef::args::Args::new();
    let cmd = args.as_cmd_line()?;
    if cmd.has_switch(Some(&cs("type"))) == 0 {
        return None;
    }
    let mut app = CorvidApp::new(None);
    Some(execute_process(Some(args.as_main_args()), Some(&mut app), std::ptr::null_mut()))
}

/// Runs until the window closes. Returns true if a relaunch was requested.
pub fn run(opts: Options, paths: Paths, listener: Option<UnixListener>) -> Result<bool, String> {
    if opts.smoke_js.is_some() {
        // Renderer processes inherit this: inject into file:// test pages too.
        // SAFETY: no other threads exist yet.
        unsafe { std::env::set_var("CORVID_TEST_ANY_PAGE", "1") };
    }
    let host = Host::new(paths.clone()).map_err(|e| format!("data dir {}: {e}", paths.data_dir.display()))?;
    let sources = bundle::Sources::load();
    let body = bundle::body(&sources);
    log::info!("[{} ms] mod bundle: {} plugin files, {} KB", ms(), sources.plugins.len(), body.len() / 1024);

    let (work_tx, work_rx) = mpsc::channel::<Req>();
    let token = format!("_cv{:024x}", rand_u128());
    let shared = Arc::new(Shared {
        host: host.clone(),
        token,
        body,
        opts,
        work_tx: Mutex::new(work_tx),
        watching: AtomicBool::new(false),
        skip_config_push: AtomicBool::new(false),
    });
    host.set_ui(Arc::new(CefUi { shared: Arc::downgrade(&shared) }));
    let watcher = host.watch().map_err(|e| log::warn!("theme watcher: {e}")).ok();
    shared.watching.store(watcher.is_some(), Ordering::Relaxed);
    {
        let shared = shared.clone();
        std::thread::Builder::new()
            .name("corvid-ipc".into())
            .spawn(move || {
                for req in work_rx {
                    run_request(&shared, req);
                }
            })
            .map_err(|e| e.to_string())?;
    }
    if let Some(l) = listener {
        crate::single_instance::serve(l, || {
            let mut t = FocusTask::new();
            post_task(ThreadId::UI, Some(&mut t));
        });
    }

    let args = cef::args::Args::new();
    let mut app = CorvidApp::new(Some(shared.clone()));
    let ret = execute_process(Some(args.as_main_args()), Some(&mut app), std::ptr::null_mut());
    if ret != -1 {
        return Err(format!("execute_process returned {ret} in the browser process"));
    }

    let cef = cef_dir();
    let profile = paths.profile_dir.to_string_lossy().into_owned();
    let settings = Settings {
        no_sandbox: shared.opts.no_sandbox as i32,
        root_cache_path: cs(&profile),
        cache_path: cs(&format!("{profile}/default")),
        persist_session_cookies: 1,
        resources_dir_path: cs(&cef.to_string_lossy()),
        locales_dir_path: cs(&cef.join("locales").to_string_lossy()),
        log_file: cs(&paths.data_dir.join("cef.log").to_string_lossy()),
        log_severity: LogSeverity::WARNING,
        remote_debugging_port: shared.opts.remote_debugging_port.unwrap_or(0) as i32,
        background_color: shared.host.options.background,
        // Common value; doesn't leak the system locale list.
        accept_language_list: cs("en-US,en"),
        ..Default::default()
    };
    if initialize(Some(args.as_main_args()), Some(&settings), Some(&mut app), std::ptr::null_mut()) != 1 {
        return Err(format!("CEF failed to initialize (see {})", paths.data_dir.join("cef.log").display()));
    }
    log::info!("[{} ms] CEF initialized", ms());
    run_message_loop();
    shutdown();
    Ok(RELAUNCH.load(Ordering::SeqCst))
}

fn rand_u128() -> u128 {
    let mut b = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut b);
    }
    u128::from_le_bytes(b) ^ std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}
