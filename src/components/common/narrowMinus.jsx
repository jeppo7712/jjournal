import React from 'react';

// Inter's tabular figures (font-variant-numeric: tabular-nums) draw the
// minus as wide as a digit, which leaves a gap in a big figure ("- $58").
// Only the minus is drawn at its own width; the digits stay tabular, so a
// figure that updates live doesn't jiggle. Anything else comes back as is.
export default function narrowMinus(text) {
  if (typeof text !== 'string' || !text.startsWith('-')) return text;
  return (
    <>
      <span style={{ fontVariantNumeric: 'normal' }}>-</span>
      {text.slice(1)}
    </>
  );
}
