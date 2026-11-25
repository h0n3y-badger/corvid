// What capture devices does the engine expose? Does not open any device
// unless the page URL has ?capture (opening a Bluetooth mic switches the
// headset to its call profile).
const out = {};
const list = async () => (await navigator.mediaDevices.enumerateDevices())
    .map(d => `${d.kind}:${d.label || "(no label)"}:${d.deviceId.slice(0, 10) || "(no id)"}`);
out.devices = await list();
for (const name of ["microphone", "camera"]) {
    try { out[name + "Permission"] = (await navigator.permissions.query({ name })).state; }
    catch (e) { out[name + "Permission"] = "query failed: " + e; }
}
if (location.search.includes("capture")) {
    try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        out.capture = s.getAudioTracks().map(t => t.label);
        s.getTracks().forEach(t => t.stop());
    } catch (e) { out.captureError = `${e.name}: ${e.message} ${e.constraint || ""}`; }
    out.devicesAfter = await list();
}
return JSON.stringify(out, null, 1);
