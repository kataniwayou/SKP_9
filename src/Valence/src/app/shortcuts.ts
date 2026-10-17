import type { ShortcutGroup } from '../dock/ShortcutSheet';

/**
 * Every key stroke and gesture Valence answers, for the Shortcuts sheet on the menu strip (the user, 2026-10-17: "add all
 * the features like hover atom and ctrl you can relocate"; preview approved). Kept beside the handlers it describes:
 * ProjectDocument's keys (canvas, copy/paste), MoleculeView's mouse and touch, the Toolbox's, the Inspector's, the
 * workflow filter's and the dock's (dock/keys.ts, parts.tsx, AutoHide.tsx). F5, Ctrl+O and Alt+W are the dock's but do
 * nothing in Valence, so they are not listed. `column`: the sheet's left (0) or right (1) column.
 */

export const SHORTCUTS: readonly ShortcutGroup[] = [
  {
    group: 'Canvas — keys (click the canvas first)', column: 0,
    items: [
      { keys: 'Delete', does: 'Delete the pinned atom or arrow (or take back a new one)' },
      { keys: 'Ctrl+Z', does: 'Undo' },
      { keys: 'Ctrl+Y · Ctrl+Shift+Z', does: 'Redo' },
    ],
  },
  {
    group: 'Copy and paste — anywhere but a text field', column: 0,
    items: [
      { keys: 'Ctrl+C', does: 'Copy the pinned atom (not an arrow, a deleted or an updated one)' },
      { keys: 'Ctrl+V', does: 'Paste: the copy follows the pointer, click to drop' },
    ],
  },
  {
    group: 'Canvas — hover', column: 0,
    items: [
      { keys: 'Hover an atom', does: 'Preview it in the Inspector, light its arrows and neighbours, label them' },
      { keys: 'Hover an arrow', does: 'Preview it, light its two ends' },
      { keys: 'Hold Ctrl', does: 'The hand shows you may move or slide' },
    ],
  },
  {
    group: 'Canvas — mouse', column: 0,
    items: [
      { keys: 'Click', does: 'Pin an atom or arrow (the Inspector shows it)' },
      { keys: 'Click empty canvas', does: 'Unpin' },
      { keys: 'Ctrl+drag an atom', does: 'Relocate the atom (its arrows follow)' },
      { keys: 'Drag', does: 'Turn the molecule' },
      { keys: 'Drag, let go', does: 'Let go while moving: it keeps turning; hold still first: it stops' },
      { keys: 'Ctrl+drag', does: 'Slide the picture (the turning point stays)' },
      { keys: 'Right-drag', does: 'Move the camera sideways' },
      { keys: 'Wheel', does: 'Zoom toward the canvas centre' },
      { keys: 'Zoom in', does: "Names appear as you zoom in; a workflow's always" },
    ],
  },
  {
    group: 'Canvas — touch', column: 0,
    items: [
      { keys: 'One finger', does: 'Turn the molecule' },
      { keys: 'Drag an atom', does: 'Relocate the atom' },
      { keys: 'Pinch', does: 'Zoom' },
    ],
  },
  {
    group: 'Toolbox', column: 1,
    items: [
      { keys: 'Drag a tile', does: 'Make an atom: lone ones anywhere, the rest on their target' },
      { keys: 'Drop, then click', does: 'Draw an arrow: drop on its tail, click its head' },
      { keys: 'Type in search', does: 'Find a tile' },
      { keys: 'Escape', does: 'Cancel a drag, an arrow being drawn, or a paste' },
    ],
  },
  {
    group: 'Inspector', column: 1,
    items: [
      { keys: 'Type', does: "Edit the pinned atom's fields (virtual until applied)" },
      { keys: 'Revert', does: 'Undo every edit of the pinned atom' },
      { keys: 'Read-only ▸', does: 'Show or hide the read-only fields' },
    ],
  },
  {
    group: 'Workflows filter (top right)', column: 1,
    items: [
      { keys: 'Click a workflow', does: 'Highlight the workflows you pick; the rest fades' },
      { keys: 'Space · Enter', does: 'Pick or unpick the focused workflow' },
      { keys: 'Escape', does: 'Close the list' },
    ],
  },
  {
    group: 'Windows', column: 1,
    items: [
      { keys: 'Ctrl+E', does: 'Switch window (hold Ctrl, E again for the next)' },
      { keys: 'Ctrl+Shift+E', does: 'Switch window, backwards' },
      { keys: 'Double-click a tab', does: 'Maximise or restore' },
      { keys: 'Ctrl+double-click a tab', does: 'Float or dock' },
      { keys: 'Right-click a tab', does: 'Window-position menu' },
      { keys: 'Drag a tab', does: 'Move a pane, or dock it beside another' },
      { keys: 'Hover its side tab', does: 'Open an auto-hidden pane' },
      { keys: 'View ▸ pane', does: 'Show or hide a pane' },
      { keys: 'Escape', does: 'Close a menu or the switcher' },
    ],
  },
];
