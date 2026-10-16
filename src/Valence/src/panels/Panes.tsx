import { PaneNote } from './PaneNote';

/** Toolbox and Output in SKP Studio's frames, empty of business (stage 1, spec §3): each says what it will hold. */
export function Toolbox() {
  return <PaneNote pane="toolbox">Nothing to add yet: the entities to create come with the molecule.</PaneNote>;
}

export function Output() {
  return <PaneNote pane="output">No messages.</PaneNote>;
}
