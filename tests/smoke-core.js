// Host <-> core round trip on a local page: run with
//   corvid --url=file://$PWD/tests/blank.html --smoke-js=tests/smoke-core.js
const k = Object.getOwnPropertyNames(window).find(n => n.startsWith("__cv"));
const c = window[k];
const out = { corvid: !!c, nativeLeaked: typeof window.__corvidNative !== "undefined" };
if (!c) return JSON.stringify(out);
out.info = await c.native("app.info");
await c.native("quickcss.set", { css: "body { --corvid-smoke: 1px; }" });
await new Promise(r => setTimeout(r, 300));
out.quickcssLive = getComputedStyle(document.body).getPropertyValue("--corvid-smoke").trim();
out.sheets = document.adoptedStyleSheets.length;
try { await c.native("open.external", { url: "file:///etc/passwd" }); out.fileUrl = "ALLOWED"; }
catch (e) { out.fileUrl = "rejected"; }
out.telemetry = await fetch("https://discord.com/api/v9/science", { method: "POST", body: "{}" }).then(r => r.status, e => "err " + e);
out.plugins = Object.keys(c.plugins);
out.rtc = typeof RTCRtpScriptTransform;
return JSON.stringify(out);
