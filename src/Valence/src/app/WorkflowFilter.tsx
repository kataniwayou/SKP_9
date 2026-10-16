import { useMemo } from 'react';
import { useHighlights, type Highlights } from './highlights';
import { WorkflowSelect } from './WorkflowSelect';
import { useWorkspace, type Workspace } from './workspace';

/**
 * The workflow filter on the main menu strip (the user, 2026-10-16): the workflows of the loaded project, each by its
 * name (an edited name too, decision 8). The picked ones set the molecule's base state: what they reach stays, the rest
 * fades; hover and pin work on top of it as before. Ids are workflow atom keys (`wf:<id>`).
 */
export function WorkflowFilter({ workspace, highlights }: { workspace: Workspace; highlights: Highlights }) {
  const molecule = useWorkspace(workspace, (s) => s.molecule);
  const edits = useWorkspace(workspace, (s) => s.edits);
  const selected = useHighlights(highlights);
  const items = useMemo(() => (molecule
    ? [...molecule.atoms.values()].filter((a) => a.type === 'wf')
      .map((a) => ({ id: a.key, label: edits[a.key]?.name ?? a.name }))
      .sort((x, y) => x.label.localeCompare(y.label))
    : []), [molecule, edits]);
  return (
    <WorkflowSelect items={items} selected={selected} onChange={highlights.set}
      note={molecule ? 'The project has no workflows.' : 'Reading the project…'} />
  );
}
