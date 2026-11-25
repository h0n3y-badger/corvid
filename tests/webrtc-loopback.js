// WebRTC loopback self-test for an engine build, no Discord account needed:
//   corvid --url file:///some/blank.html --smoke-js tests/webrtc-loopback.js
// Sends a synthetic tone + canvas video between two in-page peer connections
// with an RTCRtpScriptTransform on the audio sender (what Discord's DAVE E2EE
// uses) and reports whether media and transformed frames actually flow.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { if (f()) return true; await sleep(100); }
    return false;
};
const out = {};
try {
    const ctx = new AudioContext();
    await ctx.resume();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const audio = dest.stream.getAudioTracks()[0];

    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 240;
    document.body.append(canvas);
    const g = canvas.getContext("2d");
    let hue = 0;
    const paint = setInterval(() => { g.fillStyle = `hsl(${hue = (hue + 7) % 360} 80% 50%)`; g.fillRect(0, 0, 320, 240); }, 33);
    const vstream = canvas.captureStream(30);
    const video = vstream.getVideoTracks()[0];

    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = e => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate);
    const aSender = a.addTrack(audio, dest.stream);
    a.addTrack(video, vstream);

    const workerSrc = `let n = 0;
onrtctransform = ev => {
    const t = ev.transformer;
    t.readable.pipeThrough(new TransformStream({
        transform(frame, c) { n++; if (n % 10 === 1) postMessage(n); c.enqueue(frame); }
    })).pipeTo(t.writable);
};`;
    const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" })));
    out.framesTransformed = 0;
    worker.onmessage = e => out.framesTransformed = e.data;
    try { aSender.transform = new RTCRtpScriptTransform(worker, { side: "send" }); out.transform = "attached"; }
    catch (e) { out.transform = "error: " + e; }

    const kinds = [];
    b.ontrack = e => kinds.push(e.track.kind);

    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);
    out.offerCodecs = [...new Set([...offer.sdp.matchAll(/a=rtpmap:\d+ ([\w-]+)\//g)].map(m => m[1]))];

    out.connected = await until(() => a.connectionState === "connected", 15000);
    out.state = a.connectionState;
    await sleep(4000);
    clearInterval(paint);

    out.remoteTracks = kinds;
    const per = {};
    (await a.getStats()).forEach(s => {
        if (s.type === "outbound-rtp") (per[s.kind] ??= {}).sent = s.packetsSent;
        if (s.type === "codec") (out.codecsUsed ??= []).push(s.mimeType);
    });
    (await b.getStats()).forEach(s => {
        if (s.type === "inbound-rtp") Object.assign(per[s.kind] ??= {}, { recv: s.packetsReceived, framesDecoded: s.framesDecoded });
    });
    out.packets = per;
    a.close(); b.close(); ctx.close();
} catch (e) {
    out.error = String(e && e.stack || e);
}
return JSON.stringify(out);
