import { useEffect, useState } from 'react';

/** The glyph's frames, Claude Code style; one step per GLYPH_MS. */
export const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽'] as const;
export const GLYPH_MS = 120;

const reducedMotion = (): boolean => {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
};

/** 3200 -> "3.2k", 12000 -> "12k", 950 -> "950". */
export const tokensText = (n: number): string => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`);

/**
 * What the model is doing while the chat is busy (2026-10-23), as Claude Code shows it: an animated glyph, then
 * `(12s · ↑ 9.3k · ↓ 3.2k tokens · thinking)`: ↑ the latest request (2026-10-24), ↓ what the model wrote for this message.
 * The glyph holds still under prefers-reduced-motion.
 */
export function StatusLine({ seconds, prompt, tokens, activity }: { seconds: number; prompt: number; tokens: number; activity: string }) {
  const [step, setStep] = useState(0);
  const [still] = useState(reducedMotion);
  useEffect(() => {
    if (still) return undefined;
    const timer = setInterval(() => setStep((s) => (s + 1) % GLYPHS.length), GLYPH_MS);
    return () => clearInterval(timer);
  }, [still]);
  return (
    <div className="chat-status" role="status">
      <span className="chat-glyph" aria-hidden="true">{still ? GLYPHS[GLYPHS.length - 2] : GLYPHS[step]}</span>
      <span className="chat-status-text">{`(${seconds}s · ↑ ${tokensText(prompt)} · ↓ ${tokensText(tokens)} tokens · ${activity})`}</span>
    </div>
  );
}
