// Settings entry + overlay: open Discord settings, click "corvid", expect the
// overlay; the runner sends a real Escape ~6 s in; expect it closed.
const sleep = ms => new Promise(r => setTimeout(r, ms));
while (!document.querySelector('[data-list-id="guildsnav"]')) await sleep(50);
await sleep(1500);
document.querySelector('button[aria-label="User Settings"]').click();
let entry;
for (let i = 0; i < 100 && !(entry = document.querySelector("[data-corvid-entry]")); i++) await sleep(50);
const out = { entry: !!entry, entryText: entry?.textContent.trim() };
entry?.querySelector('[role=link]')?.click() ?? entry?.click();
await sleep(800);
const overlay = () => !!document.getElementById("corvid-settings");
out.overlayOpen = overlay();
out.discordSettingsClosed = !document.querySelector('nav[aria-label="Settings pages"]');
await sleep(5000); // Escape arrives here
out.overlayClosedByEscape = !overlay();
return JSON.stringify(out);
