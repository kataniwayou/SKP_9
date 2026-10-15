const keys = new WeakMap<Window, string>();
let next = 0;

/** A stable React key for a browser window (the main one or a pop-out). */
export function windowKey(win: Window): string {
  let key = keys.get(win);
  if (key === undefined) { key = `w${next++}`; keys.set(win, key); }
  return key;
}
