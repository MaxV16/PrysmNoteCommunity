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
