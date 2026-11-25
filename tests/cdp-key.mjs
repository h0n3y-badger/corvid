// Send real key presses to the Discord page over the DevTools protocol:
//   node tests/cdp-key.mjs PORT Key[,Key...]   e.g. 9333 Escape
// (corvid must run with --remote-debugging-port=PORT; localhost only.)
const [port, keys] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page" && t.url.startsWith("https://discord.com"));
if (!page) { console.error("no discord page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let id = 0;
const send = (method, params) => new Promise(res => {
    const my = ++id;
    ws.addEventListener("message", function h(e) { const m = JSON.parse(e.data); if (m.id === my) { ws.removeEventListener("message", h); res(m); } });
    ws.send(JSON.stringify({ id: my, method, params }));
});
const codes = { Escape: 27, Enter: 13, Tab: 9 };
for (const key of keys.split(",")) {
    const base = { key, code: key, windowsVirtualKeyCode: codes[key] ?? 0 };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
ws.close();
console.log("sent", keys);
