/** A step's entry condition, as drawn: the wire colour into it and the letter on its pill. */
export interface ConditionInfo {
  name: string;
  letter: string;
  colour: string;
}

// Values are the stored wire integers (StepEntryCondition.cs) and must not change.
const TABLE: Record<number, ConditionInfo> = {
  1: { name: 'Completed', letter: 'C', colour: '#2DD4BF' },
  2: { name: 'Failed', letter: 'F', colour: '#FF7A66' },
  3: { name: 'Cancelled', letter: 'X', colour: '#F5B841' },
  4: { name: 'Always', letter: 'A', colour: '#B392F0' },
  5: { name: 'Never', letter: 'N', colour: '#F472B6' },
};

// 0 (PreviousProcessing) is rejected by both step validators, but the editor never blocks a
// design, so it is drawn as invalid instead of throwing.
const INVALID: ConditionInfo = { name: 'Invalid', letter: '?', colour: '#5A6B86' };

export function conditionInfo(condition: number): ConditionInfo {
  return TABLE[condition] ?? INVALID;
}

export const CONDITIONS: ReadonlyArray<{ value: number } & ConditionInfo> =
  [1, 2, 3, 4, 5].map((value) => ({ value, ...TABLE[value]! }));
