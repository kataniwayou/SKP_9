import { describe, expect, it } from 'vitest';
import { DRAWING_RULES } from '../ai/drawing';
import { CONDITIONS } from '../model/entryConditions';
import { FIELDS } from '../store/entityForms';
import { systemPrompt } from './prompt';
import { DESTRUCTIVE, TOOLS } from './tools';

describe('systemPrompt', () => {
  const prompt = systemPrompt();

  it('carries the drawing rules verbatim and every family', () => {
    expect(prompt).toContain(DRAWING_RULES);
    for (const c of CONDITIONS) expect(prompt).toContain(c.name);
  });

  it('names every entity field and every destructive tool', () => {
    for (const fields of Object.values(FIELDS)) for (const f of fields) expect(prompt).toContain(f.key);
    for (const name of DESTRUCTIVE) expect(prompt).toContain(name);
  });

  it('says the wand is not available, and no tool is the wand', () => {
    expect(prompt).toMatch(/wand[^.\n]*not available to you/i);
    expect(prompt).not.toMatch(/you may (use|press|run) the wand/i);
    expect(TOOLS.map((t) => t.function.name).filter((n) => /wand|draw/i.test(n))).toEqual([]);
  });

  it('teaches the working method', () => {
    expect(prompt).toMatch(/read_design/);
    expect(prompt).toMatch(/move_blocks/);
    expect(prompt).toMatch(/join/);
    expect(prompt).toMatch(/never guess/i);
    expect(prompt).toMatch(/read_entity[^.\n]*set_field/);
    expect(prompt).toMatch(/name and version/i);
  });
});
