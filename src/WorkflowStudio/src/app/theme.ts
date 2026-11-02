/** The studio's colour theme (the user, 2026-11-01): dark, the blueprint the mockups drew, or light. */
export type Theme = 'dark' | 'light';

const KEY = 'skp.studio.theme';

/** The theme last chosen in this browser; dark when none was, or storage cannot be read. */
export function savedTheme(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Theme {
  try {
    return storage?.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** Remembers the theme; a storage that refuses it (a private window) only loses the memory. */
export function saveTheme(theme: Theme, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, theme);
  } catch { /* the theme still applies for this page */ }
}

/** Shows a window in the theme: the main page, or a popped-out window's own document. tokens.css reads the attribute. */
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
