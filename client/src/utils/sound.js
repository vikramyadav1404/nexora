/**
 * Short UI sounds, synthesized rather than loaded.
 *
 * A like tap wants under half a second of audio. Shipping an mp3 for that costs
 * a network request, a decode, and a binary in the repo; oscillators through a
 * filter cost none of those and are tweakable in place.
 *
 * The first version of this was two bare oscillators, and it sounded like it —
 * thin and electronic, the way a browser beep does. Three things fix that, and
 * they matter more than which notes get played:
 *
 *   1. A pop transient before the notes, so the sound has a body and lands as a
 *      "bloop" instead of starting mid-air on a pure tone.
 *   2. Every note played twice, a few cents apart. One oscillator is a test
 *      tone; two slightly-detuned ones beat against each other and read as warm
 *      and wide. This is the single biggest difference.
 *   3. A lowpass over the whole chain, taking off the piercing top end that
 *      makes synthesized audio sound cheap.
 *
 * Everything here fails silently. Sound is a garnish — a browser that blocks
 * autoplay, an older Safari, or a device with no output must not throw into a
 * click handler that also has to register a like.
 */

const STORAGE_KEY = 'nexora:sound';

let ctx = null;
let lastPlayedAt = 0;

/**
 * Rapid taps must not stack.
 *
 * Ten likes in a second used to start ten overlapping jingles, and summing ten
 * copies of the same waveform clips hard — it arrives as a burst of distortion
 * rather than ten sounds. Dropping anything that arrives too soon after the
 * last one keeps it clean, and the like itself is unaffected either way.
 */
const RETRIGGER_MS = 60;

/**
 * One AudioContext for the tab, created on the first actual sound.
 *
 * Creating it at import time gets it suspended by the autoplay policy, and it
 * then stays suspended until a gesture resumes it — so the first few taps are
 * silent for no visible reason. Building it inside a click means it starts
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
 * A shared output stage: lowpass, then master gain.
 *
 * Built per-sound rather than once for the tab so like and unlike can be
 * filtered differently — the duller cutoff is most of what makes unlike read as
 * an undo rather than a second, quieter approval.
 */
function outputChain(a, { cutoff, gain }) {
  const filter = a.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  // Slight resonance at the corner adds a little sparkle without brightening
  // the whole spectrum.
  filter.Q.value = 0.7;

  const master = a.createGain();
  master.gain.value = gain;

  filter.connect(master).connect(a.destination);
  return filter;
}

/**
 * One note, as a detuned pair.
 *
 * The gain envelope matters as much as the pitch: a wave switched on and off at
 * full volume clicks audibly at both ends, which reads as a glitch rather than
 * a sound. Ramping up over a few milliseconds and decaying exponentially
 * removes both edges.
 */
function note(a, dest, startAt, { freq, duration, peak, type = 'sine', detune = 7, attack = 0.006 }) {
  for (const cents of [-detune, detune]) {
    const osc = a.createOscillator();
    const gain = a.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, startAt);
    osc.detune.setValueAtTime(cents, startAt);

    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(peak, startAt + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

    osc.connect(gain).connect(dest);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  }
}

/** The rounded body at the front — a fast downward sweep, felt more than heard. */
function pop(a, dest, startAt) {
  const osc = a.createOscillator();
  const gain = a.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(200, startAt);
  osc.frequency.exponentialRampToValueAtTime(90, startAt + 0.05);

  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.18, startAt + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.06);

  osc.connect(gain).connect(dest);
  osc.start(startAt);
  osc.stop(startAt + 0.09);
}

/**
 * E major add9, rising. A major arpeggio going up is what reads as approval —
 * the same notes descending would read as dismissal, which is why unlike uses
 * exactly that.
 */
const LIKE_ARPEGGIO = [659.25, 830.61, 987.77, 1318.51]; // E5 G#5 B5 E6
const STEP = 0.055;

/**
 * Liking: pop, then a bright rising chime, then a shimmer that rings out.
 *
 * Unliking is deliberately not this played backwards. Making the two
 * symmetrical made a double-tap sound like a stutter rather than an undo, so it
 * gets its own shorter, darker, quieter phrase.
 */
export function playLike(liked = true) {
  if (!soundEnabled()) return;

  const now = Date.now();
  if (now - lastPlayedAt < RETRIGGER_MS) return;
  lastPlayedAt = now;

  const a = audio();
  if (!a) return;

  try {
    if (a.state === 'suspended') a.resume();
    const t = a.currentTime;

    if (liked) {
      const out = outputChain(a, { cutoff: 5000, gain: 0.5 });

      pop(a, out, t);

      LIKE_ARPEGGIO.forEach((freq, i) => {
        note(a, out, t + 0.03 + i * STEP, {
          freq,
          duration: 0.28 - i * 0.03,
          // Each note a little quieter than the last, so the phrase lifts
          // without the top note stabbing.
          peak: 0.13 - i * 0.02,
          type: i === 0 ? 'triangle' : 'sine'
        });
      });

      // Rings on after the arpeggio has stopped, so it fades rather than ends.
      note(a, out, t + 0.03 + 3 * STEP, {
        freq: 2637.02, // E7
        duration: 0.42,
        peak: 0.035,
        type: 'sine',
        detune: 4,
        attack: 0.02
      });
    } else {
      // Darker filter and two falling notes. Shorter than the like on purpose:
      // undoing something should not command the same attention as doing it.
      const out = outputChain(a, { cutoff: 1200, gain: 0.45 });
      note(a, out, t, { freq: 493.88, duration: 0.14, peak: 0.09, type: 'sine' });      // B4
      note(a, out, t + 0.07, { freq: 329.63, duration: 0.18, peak: 0.07, type: 'sine' }); // E4
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
    const out = outputChain(a, { cutoff: 3500, gain: 0.4 });
    note(a, out, a.currentTime, { freq: 523.25, duration: 0.06, peak: 0.07, type: 'sine', detune: 4 });
  } catch { /* ignored */ }
}
