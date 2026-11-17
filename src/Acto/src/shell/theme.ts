/** The board's colour theme: light (the approved mock) by default, or WorkflowStudio's dark blueprint. */
export type Theme = 'dark' | 'light';

const KEY = 'acto.theme';

/** The theme last chosen in this browser; light when none was, or storage cannot be read. */
export function savedTheme(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Theme {
  try {
    return storage?.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Remembers the theme; a storage that refuses it (a private window) only loses the memory. */
export function saveTheme(theme: Theme, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, theme);
  } catch { /* the theme still applies for this page */ }
}

/** Shows the document in the theme; tokens.css reads the attribute. */
export function applyTheme(theme: Theme, doc: Document = document): void {
  doc.documentElement.dataset.theme = theme;
  doc.documentElement.style.colorScheme = theme;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
