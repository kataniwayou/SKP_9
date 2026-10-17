/**
 * Every key stroke and mouse gesture Valence answers, for the Shortcuts menu on the menu strip (the user, 2026-10-17).
 * Kept beside the handlers it describes: ProjectDocument's keys (canvas, copy/paste), the Toolbox's, MoleculeView's
 * mouse, and the dock's (dock/keys.ts). F5, Ctrl+O and Alt+W are the dock's but do nothing in Valence, so not listed.
 */
export const SHORTCUTS: readonly { group: string; items: readonly { keys: string; does: string }[] }[] = [
  {
    group: 'Canvas — click it first',
    items: [
      { keys: 'Delete', does: 'Delete the pinned atom or arrow (or take back a new one)' },
      { keys: 'Ctrl+Z', does: 'Undo' },
      { keys: 'Ctrl+Y', does: 'Redo' },
      { keys: 'Ctrl+Shift+Z', does: 'Redo' },
    ],
  },
  {
    group: 'Copy and paste — anywhere but a text field',
    items: [
      { keys: 'Ctrl+C', does: 'Copy the pinned atom' },
      { keys: 'Ctrl+V', does: 'Paste it: the copy follows the pointer, click to drop' },
    ],
  },
  {
    group: 'Toolbox',
    items: [
      { keys: 'Drag a tile', does: 'Make an atom where it is dropped' },
      { keys: 'Drop, then click', does: 'Draw an arrow: drop on its tail, click its head' },
      { keys: 'Escape', does: 'Cancel a drag, an arrow being drawn, or a paste' },
    ],
  },
  {
    group: 'Canvas — mouse',
    items: [
      { keys: 'Click', does: 'Pin an atom or arrow (the Inspector shows it)' },
      { keys: 'Drag', does: 'Turn the molecule' },
      { keys: 'Ctrl+drag an atom', does: 'Move the atom' },
      { keys: 'Ctrl+drag', does: 'Slide (pan) the picture' },
      { keys: 'Wheel', does: 'Zoom toward the centre' },
    ],
  },
  {
    group: 'Windows',
    items: [
      { keys: 'Ctrl+E', does: 'Switch window (hold Ctrl, press E again for the next)' },
      { keys: 'Ctrl+Shift+E', does: 'Switch window, backwards' },
      { keys: 'Double-click a tab', does: 'Maximise or restore' },
      { keys: 'Ctrl+double-click a tab', does: 'Float or dock' },
      { keys: 'Escape', does: 'Close a menu or the switcher' },
    ],
  },
];
