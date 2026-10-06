/**
 * The gradient and filter the art shares, defined once per window (the main page and each pop-out):
 * the step cap's gloss and the selection glow. The ids are document-global, so nothing else may
 * define them.
 */
export function SvgDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        {/* the step's glossy title cap (locked art): white to silver */}
        <linearGradient id="nxCap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#FFFFFF" stopOpacity=".95" /><stop offset="1" stopColor="#B9C9E2" stopOpacity=".72" /></linearGradient>
        {/* the selection glow (mockup v49 #glow): the selected block, die or sphere */}
        <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4" result="b" /><feFlood floodColor="#7DD3FC" floodOpacity=".45" /><feComposite in2="b" operator="in" /><feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
    </svg>
  );
}
