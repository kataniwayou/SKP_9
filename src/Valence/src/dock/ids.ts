/**
 * The three shared tool panes (spec §6.1). Their ids are their dockview panel ids. Problems is gone (2026-10-09):
 * Output pins the current problems at its top.
 */
export type ToolId = 'inspector' | 'toolbox' | 'output' | 'chat';

export const TOOL_IDS: readonly ToolId[] = ['inspector', 'toolbox', 'output', 'chat'];

export const TOOL_TITLES: Readonly<Record<ToolId, string>> = {
  inspector: 'Inspector', toolbox: 'Toolbox', output: 'Output', chat: 'Chat',
};

export const isToolId = (id: string): id is ToolId => (TOOL_IDS as readonly string[]).includes(id);

/** A pane that auto-hides to a rail tab: a tool pane's id or a document's panel id (`doc:…`; Valence, 2026-10-16). */
export type PaneId = string;

/** Tool panes the studio had and no longer has; a stored layout holding one loads without it (layoutPersistence). */
export const RETIRED_TOOL_IDS: readonly string[] = ['problems'];

const DOC_PREFIX = 'doc:';

/** A document's dockview panel id. Documents and tool panes never share an id. */
export const docPanelId = (documentId: string): string => `${DOC_PREFIX}${documentId}`;
export const isDocPanelId = (panelId: string): boolean => panelId.startsWith(DOC_PREFIX);
/** The document id inside a document panel id, or null for any other panel. */
export const documentIdOf = (panelId: string): string | null =>
  isDocPanelId(panelId) ? panelId.slice(DOC_PREFIX.length) : null;
