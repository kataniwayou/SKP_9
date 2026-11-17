import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === 'node_modules') return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? cssFiles(p) : n.endsWith('.css') ? [p] : [];
  });
}

/** The colours that are the same in both themes and so may stay literal outside tokens.css (entry conditions and
 *  run states are constants in TS, not css). Only the accent pink and its translucent halos belong here. */
const CONSTANT = [/#FF0072/gi, /rgba\(255,\s*0,\s*114,\s*\.\d+\)/g];
const NAMED = /\b(white|black|red|green|blue|gray|grey|yellow|orange|purple|pink|silver|navy|teal)\b/i;

/** What is left of a stylesheet once comments, var(--x, fallback) uses and the constant colours are removed. */
function literals(css: string): string[] {
  let s = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const c of CONSTANT) s = s.replace(c, '');
  s = s.replace(/var\(--[\w-]+\s*(?:,[^)]*)?\)/g, 'VAR');
  const found: string[] = [];
  for (const m of s.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi)) found.push(m[0]);
  for (const m of s.matchAll(/[\w-]+\s*:\s*([^;{}]+)/g)) { const n = NAMED.exec(m[1]!); if (n) found.push(n[0]); }
  return found;
}

describe('token coverage', () => {
  const files = cssFiles(SRC).filter((f) => !f.endsWith('tokens.css'));
  it('finds the stylesheets', () => { expect(files.length).toBeGreaterThanOrEqual(3); });
  it('catches a literal colour', () => {
    expect(literals('a { color: #123456; background: rgba(0,0,0,.5); border-color: white }')).toHaveLength(3);
    expect(literals('a { color: var(--ink, #fff); border-color: #FF0072 }')).toEqual([]);
  });
  for (const f of files) {
    it(`${relative(SRC, f)} has no literal colour`, () => {
      expect(literals(readFileSync(f, 'utf8'))).toEqual([]);
    });
  }
  it('defines every token it uses, in both themes', () => {
    const tokens = readFileSync(join(SRC, 'tokens.css'), 'utf8');
    const [light, dark] = [/:root,\s*\[data-theme="light"\]\s*\{([^}]*)\}/.exec(tokens)?.[1], /\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(tokens)?.[1]];
    expect(light).toBeTruthy(); expect(dark).toBeTruthy();
    const names = (b: string) => [...b.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!);
    const lightNames = new Set(names(light!));
    for (const n of lightNames) expect(dark, n).toContain(`${n}:`);
    for (const f of files) {
      const css = readFileSync(f, 'utf8');
      for (const m of css.matchAll(/var\((--[\w-]+)/g)) {
        if (m[1]!.startsWith('--xy-') || /--(tw|iw|bh|ow)$/.test(m[1]!)) continue;
        expect(lightNames.has(m[1]!), `${m[1]} in ${relative(SRC, f)}`).toBe(true);
      }
    }
  });
});
