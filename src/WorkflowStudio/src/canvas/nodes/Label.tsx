import type { ReactNode, SVGProps } from 'react';
import type { FittedText } from '../fitText';

/**
 * A label that may have been shortened. When it was, its full text is a native SVG tooltip: a
 * <title> beside the <text> inside a wrapping <g> (a <title> describes its parent), so the <text>
 * itself holds only what is drawn.
 */
export function Tip({ full, cut, children }: { full: string; cut: boolean; children: ReactNode }) {
  return cut ? <g><title>{full}</title>{children}</g> : <>{children}</>;
}

export function Label({ fitted, ...props }: { fitted: FittedText } & SVGProps<SVGTextElement>) {
  return <Tip full={fitted.full} cut={fitted.cut}><text {...props}>{fitted.text}</text></Tip>;
}
