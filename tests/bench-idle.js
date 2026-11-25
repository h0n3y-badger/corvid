window.__benchIdle = true;
// Used by tests/bench.sh: finish as soon as Discord's server list is on
// screen (or, with ?idle in the hash, idle 30 s for memory sampling).
const t0 = performance.now();
while (!document.querySelector('[data-list-id="guildsnav"]') && performance.now() - t0 < 60000)
    await new Promise(r => setTimeout(r, 25));
if (window.__benchIdle) await new Promise(r => setTimeout(r, 30000));
return "ready " + Math.round(performance.now());
