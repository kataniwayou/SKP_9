import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Pick } from '../../board/selection';
import { openOn } from './testBoard';

afterEach(() => sessionStorage.clear());

const fetch: Pick = { kind: 'step', id: 'fetch' };
const CASES: ReadonlyArray<[string, Pick, string]> = [
  ['workflow', { kind: 'workflow', id: 'daily' }, 'Workflow'],
  ['step', fetch, 'Step'],
  ['processor', fetch, 'Processor'],
  ['schema', fetch, 'Config schema'],
  ['assignment', fetch, 'daily'],
  ['cache', { kind: 'cache', id: 'c1' }, 'Cache'],
];

// Studio's EntityForm order for every entity tab [user, 2026-11-18]
describe('one entity form', () => {
  it.each(CASES)('%s: head, Name, Version, show all, Description in that order', (_kind, pick, tab) => {
    openOn(tab, [pick]);
    const parts = [
      screen.getByLabelText('Unique name'),
      screen.getByLabelText('Name'),
      screen.getByLabelText('Version'),
      screen.getByRole('button', { name: '▸ show all' }),
      screen.getByLabelText('Description'),
    ];
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i - 1]!.compareDocumentPosition(parts[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `part ${i}`).toBeTruthy();
    }
    expect(screen.getByLabelText('Description').tagName).toBe('TEXTAREA');
  });
});
