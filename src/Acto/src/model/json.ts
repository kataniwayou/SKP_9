// Ported from WorkflowStudio's store/entityForms.ts: JSON is shown one field to a line, and typed back to the same JSON
// (however laid out) it is no edit.

/** Two-space, one field to a line; text that does not parse is shown as it is. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Whether two JSON texts say the same thing, however laid out; text that does not parse is the same only to itself. */
export function sameJson(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
}
