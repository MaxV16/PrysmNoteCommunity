"use client";

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  return ctx;
}

// A short, pleasant two-note chime for when a task is marked complete. Generated
// with the Web Audio API so no audio asset is required.
export function playCompletionSound(): void {
  const audio = getCtx();
  if (!audio) return;
  if (audio.state === "suspended") audio.resume();

  const now = audio.currentTime;
  const playTone = (freq: number, start: number, duration: number, gain: number) => {
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, now + start);
    g.gain.exponentialRampToValueAtTime(gain, now + start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
    osc.connect(g);
    g.connect(audio.destination);
    osc.start(now + start);
    osc.stop(now + start + duration + 0.05);
  };

  playTone(880, 0, 0.15, 0.12);
  playTone(1318.5, 0.12, 0.25, 0.12);
}

// A soft, short ping for when the AI finishes a reply (replaces the removed
// spoken voice feedback). Distinctly quieter and shorter than the completion
// chime so it never sounds like a task was completed. Generated with the Web
// Audio API so no audio asset is required.
export function playAiReplyPing(): void {
  const audio = getCtx();
  if (!audio) return;
  if (audio.state === "suspended") audio.resume();

  const now = audio.currentTime;
  const playTone = (freq: number, start: number, duration: number, gain: number) => {
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, now + start);
    g.gain.exponentialRampToValueAtTime(gain, now + start + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
    osc.connect(g);
    g.connect(audio.destination);
    osc.start(now + start);
    osc.stop(now + start + duration + 0.03);
  };

  playTone(1046.5, 0, 0.12, 0.08);
  playTone(1568, 0.09, 0.18, 0.06);
}

// A tiny pluck for a priority change. Each tier has its own note (High is the
// brightest, Low the warmest), so the choice is audible as well as visible. The
// quick downward pitch bend keeps it reading as a soft tick instead of a beep.
export function playPriorityTick(tier: 1 | 2 | 3): void {
  const audio = getCtx();
  if (!audio) return;
  if (audio.state === "suspended") audio.resume();

  const now = audio.currentTime;
  const freq = tier === 1 ? 659.25 : tier === 2 ? 523.25 : 392;
  const playTone = (f: number, gain: number, duration: number) => {
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(f, now);
    osc.frequency.exponentialRampToValueAtTime(f * 0.94, now + duration);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(g);
    g.connect(audio.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  };

  playTone(freq, 0.06, 0.14);
  playTone(freq * 2, 0.018, 0.09);
}

// A gentle reminder ping for in-app task reminders: two soft descending notes,
// distinct from the completion chime and the AI reply ping. Synthesized so no
// audio asset is required.
export function playReminderPing(): void {
  const audio = getCtx();
  if (!audio) return;
  if (audio.state === "suspended") audio.resume();

  const now = audio.currentTime;
  const playTone = (freq: number, start: number, duration: number, gain: number) => {
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, now + start);
    g.gain.exponentialRampToValueAtTime(gain, now + start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
    osc.connect(g);
    g.connect(audio.destination);
    osc.start(now + start);
    osc.stop(now + start + duration + 0.04);
  };

  playTone(987.77, 0, 0.16, 0.09);
  playTone(740, 0.13, 0.22, 0.08);
}
