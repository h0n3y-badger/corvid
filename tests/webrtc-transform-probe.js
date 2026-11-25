// Narrow down RTCRtpScriptTransform behaviour: does the worker run, does the
// rtctransform event fire (send and receive side), and is the transform
// actually in the media path (a dropping transform must stop packets)?
const sleep = ms => new Promise(r => setTimeout(r, ms));
const step = (r, name, p) => { r.stage = name; console.log("[probe] " + r.mode + " " + name); return Promise.race([p, sleep(8000).then(() => { throw new Error("timeout at " + name); })]); };
const results = [];
async function run(mode) {
    const r = { mode, msgs: [] };
    results.push(r);
    const ctx = new AudioContext();
    await ctx.resume();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest); osc.start();
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = e => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate);
    const src = `console.log("[worker] up"); postMessage("worker-up");
self.addEventListener("rtctransform", ev => {
    console.log("[worker] rtctransform " + JSON.stringify(ev.transformer.options)); postMessage("event:" + JSON.stringify(ev.transformer.options));
    let n = 0;
    ev.transformer.readable.pipeThrough(new TransformStream({
        transform(frame, c) {
            if (++n <= 2 || n % 50 === 0) console.log("[worker] frame " + n), postMessage("frame " + n + " bytes=" + frame.data.byteLength + " type=" + frame.constructor.name);
            if (${mode === "drop" ? "false" : "true"}) c.enqueue(frame);
        }
    })).pipeTo(ev.transformer.writable).catch(e => postMessage("pipe error " + e));
});`;
    const mk = () => {
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
        w.onmessage = e => r.msgs.push(e.data);
        w.onerror = e => r.msgs.push("worker error " + e.message);
        return w;
    };
    const sender = a.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
    sender.transform = new RTCRtpScriptTransform(mk(), { side: "send" });
    b.ontrack = e => { e.receiver.transform = new RTCRtpScriptTransform(mk(), { side: "recv" }); };
    const offer = await step(r, "createOffer", a.createOffer()); await step(r, "a.setLocal", a.setLocalDescription(offer)); await step(r, "b.setRemote", b.setRemoteDescription(offer));
    const answer = await step(r, "createAnswer", b.createAnswer()); await step(r, "b.setLocal", b.setLocalDescription(answer)); await step(r, "a.setRemote", a.setRemoteDescription(answer));
    r.stage = "flowing"; await sleep(4000);
    r.stage = "stats"; (await step(r, "a.getStats", a.getStats())).forEach(s => { if (s.type === "outbound-rtp") r.sent = s.packetsSent; });
    (await step(r, "b.getStats", b.getStats())).forEach(s => { if (s.type === "inbound-rtp") r.recv = s.packetsReceived; });
    r.state = a.connectionState;
    a.close(); b.close(); ctx.close();
    return r;
}
try {
    await run("pass");
    await run("drop");
} catch (e) {
    results.push({ error: String(e && e.message || e) });
}
for (const r of results) if (r.msgs) r.msgs = r.msgs.slice(0, 12);
return JSON.stringify(results, null, 1);
