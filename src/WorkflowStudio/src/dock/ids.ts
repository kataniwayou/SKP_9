/** The four shared tool panes (spec §6.1). Their ids are their dockview panel ids. */
export type ToolId = 'inspector' | 'toolbox' | 'problems' | 'output';

export const TOOL_IDS: readonly ToolId[] = ['inspector', 'toolbox', 'problems', 'output'];

export const TOOL_TITLES: Readonly<Record<ToolId, string>> = {
  inspector: 'Inspector', toolbox: 'Toolbox', problems: 'Problems', output: 'Output',
};

export const isToolId = (id: string): id is ToolId => (TOOL_IDS as readonly string[]).includes(id);

const DOC_PREFIX = 'doc:';

/** A document's dockview panel id. Documents and tool panes never share an id. */
export const docPanelId = (documentId: string): string => `${DOC_PREFIX}${documentId}`;
export const isDocPanelId = (panelId: string): boolean => panelId.startsWith(DOC_PREFIX);
/** The document id inside a document panel id, or null for any other panel. */
export const documentIdOf = (panelId: string): string | null =>
  isDocPanelId(panelId) ? panelId.slice(DOC_PREFIX.length) : null;
