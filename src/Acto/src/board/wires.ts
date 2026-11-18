/** A wire's colour, letter and name, from the entry condition of the step it leads into. */
const STYLES: Record<number, { letter: string; colour: string; name: string }> = {
  1: { letter: 'C', colour: '#0F9488', name: 'Completed' },
  2: { letter: 'F', colour: '#E0482F', name: 'Failed' },
  3: { letter: 'X', colour: '#C27C06', name: 'Cancelled' },
  4: { letter: 'A', colour: '#7C4FD6', name: 'Always' },
  5: { letter: 'N', colour: '#DB2777', name: 'Never' },
};
const INVALID = { letter: '?', colour: '#64748B', name: 'Invalid' };

export function conditionStyle(condition: number): { letter: string; colour: string; name: string } {
  return { ...(STYLES[condition] ?? INVALID) };
}
