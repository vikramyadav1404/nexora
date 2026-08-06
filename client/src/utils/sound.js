/**
 * Short UI sounds, synthesized rather than loaded.
 *
 * A like tap wants ~80ms of sound. Shipping an mp3 for that costs a network
 * request, a decode, and a binary in the repo; two oscillators through a gain
 * envelope cost none of those and are tweakable in place.
 *
 * Everything here fails silently. Sound is a garnish — a browser that blocks
 * autoplay, an older Safari, or a device with no audio output must not throw
 * into a click handler that also has to register a like.
 */

const STORAGE_KEY = 'nexora:sound';

let ctx = null;

/**
 * One AudioContext for the tab, created on the first actual sound.
 *
 * Creating it at import time gets it suspended by the autoplay policy, and it
 * then stays suspended until a gesture resumes it — so the first few taps are
 * silent for no visible reason. Building it inside a click means it starts in
 * `running`.
 */
function audio() {
  if (ctx) return ctx;
  const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

/** Off is remembered; anything else counts as on, so the default is audible. */
export function soundEnabled() {
  if (typeof localStorage === 'undefined') return true;
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundEnabled(on) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch { /* private mode — the setting just will not persist */ }
}

/**
 * One note.
 *
 * The gain envelope matters more than the pitch: a square wave switched on and
 * off at full volume clicks audibly at both ends, which reads as a glitch
 * rather than a sound. Ramping up over 8ms and decaying exponentially removes
 * both edges.
 */
function blip(startAt, { freq, endFreq, duration, peak, type = 'sine' }) {
  const a = audio();
  if (!a) return;

  const osc = a.createOscillator();
  const gain = a.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, startAt + duration);

  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  osc.connect(gain).connect(a.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

/**
 * Liking something: a quick two-note rise, so it reads as approval.
 *
 * Unliking is deliberately not the same sound played backwards — it is one
 * lower, duller note. Making the two symmetrical made double-taps sound like a
 * stutter rather than an undo.
 */
export function playLike(liked = true) {
  if (!soundEnabled()) return;
  const a = audio();
  if (!a) return;

  try {
    if (a.state === 'suspended') a.resume();
    const t = a.currentTime;

    if (liked) {
      blip(t, { freq: 660, endFreq: 990, duration: 0.09, peak: 0.09, type: 'triangle' });
      blip(t + 0.06, { freq: 990, endFreq: 1320, duration: 0.10, peak: 0.06, type: 'sine' });
    } else {
      blip(t, { freq: 420, endFreq: 300, duration: 0.10, peak: 0.05, type: 'sine' });
    }
  } catch { /* audio unavailable; the like still happens */ }
}

/** A softer tick for secondary actions, should they want one later. */
export function playTap() {
  if (!soundEnabled()) return;
  const a = audio();
  if (!a) return;
  try {
    if (a.state === 'suspended') a.resume();
    blip(a.currentTime, { freq: 520, duration: 0.05, peak: 0.04, type: 'sine' });
  } catch { /* ignored */ }
}
