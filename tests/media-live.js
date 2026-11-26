// Media transcoding self-test, no Discord account needed (run by tests/media.sh,
// which serves H.264/AAC samples on 127.0.0.1:18733 and sets
// CORVID_MEDIA_TEST_ORIGIN so corvid treats that origin like Discord's CDN).
//   short.mp4: finishes inside the wait → complete, seekable WebM
//   long.mp4:  doesn't → streamed while ffmpeg writes it; replay is seekable
const base = "http://127.0.0.1:18733/";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = { codecH264: document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"') || "no" };

async function play(name, { seekTo, watchMs = 4000 } = {}) {
    const v = document.createElement("video");
    v.muted = true;
    v.src = base + name;
    document.body.appendChild(v);
    const t0 = performance.now();
    const r = { name };
    const playing = new Promise(res => v.addEventListener("playing", res, { once: true }));
    const failed = new Promise(res => v.addEventListener("error", res, { once: true }));
    v.play().catch(() => {});
    const first = await Promise.race([playing.then(() => "playing"), failed.then(() => "error"), sleep(20000).then(() => "timeout")]);
    r.startMs = Math.round(performance.now() - t0);
    r.start = first;
    if (first !== "playing") {
        r.error = v.error && `${v.error.code} ${v.error.message}`;
        v.remove();
        return r;
    }
    r.width = v.videoWidth;
    r.duration = v.duration;
    if (seekTo !== undefined) {
        v.currentTime = seekTo;
        await Promise.race([new Promise(res => v.addEventListener("seeked", res, { once: true })), sleep(5000)]);
        r.seekedTo = Math.round(v.currentTime * 10) / 10;
    }
    const c0 = v.currentTime;
    await sleep(watchMs);
    r.advanced = Math.round((v.currentTime - c0) * 10) / 10;
    r.error = v.error && `${v.error.code} ${v.error.message}`;
    v.pause();
    v.remove();
    return r;
}

out.short = await play("short.mp4", { seekTo: 2 , watchMs: 800 });
out.long = await play("long.mp4", { watchMs: 3000 });
// wait for the transcode to finish, then replay from the cache with a seek
await sleep(12000);
out.longReplay = await play("long.mp4", { seekTo: 60, watchMs: 2000 });
return JSON.stringify(out);
