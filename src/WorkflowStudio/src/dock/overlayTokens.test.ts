import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs from src/WorkflowStudio (npm test, npx vitest).
const src = path.resolve(process.cwd(), 'src');

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return name.endsWith('.css') ? [full] : [];
  });
}

describe('overlay layers (spec §6.3)', () => {
  it('are defined once, as tokens above dockview floating groups (999)', () => {
    const tokens = readFileSync(path.join(src, 'canvas', 'tokens.css'), 'utf8');
    for (const [name, value] of [['fly', 1000], ['menu', 1010], ['toast', 1020], ['modal', 1030], ['switcher', 1040], ['tip', 1050]] as const) {
      expect(tokens).toMatch(new RegExp(`--z-${name}:\\s*${value};`));
    }
  });

  it('are the only way any stylesheet reaches dockview floating groups', () => {
    const offenders: string[] = [];
    for (const file of cssFiles(src)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/z-index:\s*([^;]+);/g)) {
        const value = match[1]!.trim();
        if (value.startsWith('var(--z-')) continue;
        if (Number(value) >= 999 || Number.isNaN(Number(value))) offenders.push(`${path.relative(src, file)}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
