// An offscreen document: the only place an extension can play a sound from (a service worker has no audio). It synthesises a short alert.
const SOUNDS = {
  // the default: a falling two-note "uh-oh"
  uhoh: [[523, 0, 0.16], [392, 0.18, 0.26]],
  ping: [[880, 0, 0.18]],
  chime: [[660, 0, 0.14], [880, 0.12, 0.14], [1100, 0.24, 0.2]],
};

let ctx;
function play(name, volume) {
  ctx ??= new AudioContext();
  void ctx.resume();
  const now = ctx.currentTime;
  for (const [freq, at, len] of SOUNDS[name] ?? SOUNDS.uhoh) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.4 * volume), now + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + len);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + at);
    osc.stop(now + at + len + 0.05);
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'play-sound') return false;
  play(String(msg.sound ?? 'uhoh'), Math.min(1, Math.max(0, Number(msg.volume ?? 0.6))));
  return false;
});
