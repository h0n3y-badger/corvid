// Themes end to end (run by tests/themes.sh on a blank page, scratch data dir).
const k = Object.getOwnPropertyNames(window).find(n => n.startsWith("__cv"));
const c = window[k];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sheetText = () => document.adoptedStyleSheets.map(s => [...s.cssRules].map(r => r.cssText).join("\n")).join("\n");
const out = {};
out.list = (await c.native("themes.list")).map(t => `${t.name} by ${t.author} enabled=${t.enabled}`);
const t0 = performance.now();
await c.native("themes.setEnabled", { fileName: "test.theme.css", enabled: true });
out.localApplied = getComputedStyle(document.body).getPropertyValue("--corvid-theme-test").trim();
// remote @import arrives after the host fetched it
while (!sheetText().includes("--ctp-") && performance.now() - t0 < 15000) await sleep(100);
out.remoteImportInlinedMs = sheetText().includes("--ctp-") ? Math.round(performance.now() - t0) : "NO";
out.noImportLeft = !sheetText().includes("@import");
// the runner edits the file at ~4 s
const t1 = performance.now();
while (getComputedStyle(document.body).getPropertyValue("--corvid-theme-test").trim() !== "2px" && performance.now() - t1 < 10000) await sleep(50);
out.liveEdit = getComputedStyle(document.body).getPropertyValue("--corvid-theme-test").trim();
await c.native("themes.setEnabled", { fileName: "test.theme.css", enabled: false });
await sleep(300);
out.disabledRemoved = getComputedStyle(document.body).getPropertyValue("--corvid-theme-test").trim() === "";
return JSON.stringify(out);
