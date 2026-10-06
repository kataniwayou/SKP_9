/**
 * Every gradient and filter the blocks and wires reference, defined once per page (mockup v49,
 * the defsInto block). The ids are document-global, so nothing else may define them.
 */
export function SvgDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <radialGradient id="wfBody" cx="36%" cy="30%" r="80%" fx="30%" fy="24%">
          <stop offset="0" stopColor="#7CCBF5" /><stop offset=".18" stopColor="#3B8ED0" /><stop offset=".45" stopColor="#1B5594" />
          <stop offset=".72" stopColor="#0E3263" /><stop offset=".9" stopColor="#081F42" /><stop offset="1" stopColor="#05142D" />
        </radialGradient>
        <radialGradient id="wfShade" cx="62%" cy="68%" r="62%"><stop offset=".55" stopColor="#020A18" stopOpacity="0" /><stop offset="1" stopColor="#020A18" stopOpacity=".55" /></radialGradient>
        <radialGradient id="wfRim"><stop offset=".84" stopColor="#7DD3FC" stopOpacity="0" /><stop offset=".97" stopColor="#7DD3FC" stopOpacity=".38" /><stop offset="1" stopColor="#7DD3FC" stopOpacity="0" /></radialGradient>
        <radialGradient id="wfSpec"><stop offset="0" stopColor="#FFFFFF" stopOpacity=".55" /><stop offset=".5" stopColor="#E0F4FF" stopOpacity=".16" /><stop offset="1" stopColor="#E0F4FF" stopOpacity="0" /></radialGradient>
        <radialGradient id="wfShadow"><stop offset="0" stopColor="#000" stopOpacity=".55" /><stop offset="1" stopColor="#000" stopOpacity="0" /></radialGradient>
        <radialGradient id="wfHalo"><stop offset=".55" stopColor="#7DD3FC" stopOpacity=".16" /><stop offset="1" stopColor="#7DD3FC" stopOpacity="0" /></radialGradient>
        <linearGradient id="capfill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#4FA2E0" /><stop offset=".35" stopColor="#22609F" /><stop offset="1" stopColor="#0C2E5A" /></linearGradient>
        <linearGradient id="darkbody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#11223B" /><stop offset="1" stopColor="#0A1527" /></linearGradient>
        <linearGradient id="rimline" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#9AD8FA" stopOpacity=".75" /><stop offset=".5" stopColor="#7DD3FC" stopOpacity=".25" /><stop offset="1" stopColor="#7DD3FC" stopOpacity=".06" /></linearGradient>
        <radialGradient id="glint"><stop offset="0" stopColor="#fff" stopOpacity=".5" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></radialGradient>
        <linearGradient id="drum" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#4E9AD8" /><stop offset=".35" stopColor="#2463A3" /><stop offset=".8" stopColor="#0F3566" /><stop offset="1" stopColor="#0A2549" /></linearGradient>
        <linearGradient id="drumTop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#9AD8FA" /><stop offset="1" stopColor="#3C82C4" /></linearGradient>
        <linearGradient id="chipRim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8CC8F2" stopOpacity=".6" /><stop offset=".55" stopColor="#3B5F8F" stopOpacity=".5" /><stop offset="1" stopColor="#1E3556" stopOpacity=".6" /></linearGradient>
        <linearGradient id="substrate" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#0E1C30" /><stop offset="1" stopColor="#08121F" /></linearGradient>
        <linearGradient id="dieFill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#1E4774" /><stop offset=".45" stopColor="#14325A" /><stop offset="1" stopColor="#0B1E3B" /></linearGradient>
        <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7" /></filter>
        {/* the step's glossy title cap (locked art): white to silver */}
        <linearGradient id="nxCap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#FFFFFF" stopOpacity=".95" /><stop offset="1" stopColor="#B9C9E2" stopOpacity=".72" /></linearGradient>
        {/* the selection glow (mockup v49 #glow): the selected block, die or sphere */}
        <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4" result="b" /><feFlood floodColor="#7DD3FC" floodOpacity=".45" /><feComposite in2="b" operator="in" /><feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        <filter id="pinGlow" x="-100%" y="-200%" width="300%" height="500%"><feGaussianBlur stdDeviation="1.6" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        {/* userSpaceOnUse: a perfectly straight wire has a zero-height bounding box, which would erase it */}
        <filter id="wsoft" filterUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"><feGaussianBlur stdDeviation="1.3" /></filter>
      </defs>
    </svg>
  );
}
