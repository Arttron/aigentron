/**
 * Whether an audio endpoint may be called WITHOUT an API key: only servers on this machine or the local network (a Whisper/TTS
 * server you run yourself), never a public host — those must have a key set. Pure so it can be tested.
 */
export function isKeylessAudioHost(base: string): boolean {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return false;
  }
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === 'host.docker.internal' || h === '::1') return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  // a single-label name is a docker service / LAN host (`whisper`, `voice`) — it never resolves on the public internet
  return !h.includes('.') && !h.includes(':');
}
