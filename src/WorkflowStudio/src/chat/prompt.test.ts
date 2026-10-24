import { describe, expect, it } from 'vitest';
import { DRAWING_RULES } from './drawingRules';
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

  it('says no tool lays the drawing out, and no tool draws for the model', () => {
    expect(prompt).toMatch(/No tool lays the drawing out for you: you place everything you add yourself with move_blocks/);
    expect(prompt).not.toMatch(/wand/i);
    expect(TOOLS.map((t) => t.function.name).filter((n) => /wand|draw/i.test(n))).toEqual([]);
  });

  it('frames drawing rule 1 as governing tidying, not as a ban on building', () => {
    expect(prompt).toMatch(/rule 1 governs tidying/i);
    expect(prompt).toMatch(/adding the steps, wires and caches the user asked for is not tidying/i);
  });

  it('limits rule 4 to renaming, rewiring and repurposing, and allows moving blocks', () => {
    expect(prompt).toMatch(/did not name or point to/);
    expect(prompt).toMatch(/Moving existing blocks to make room or to tidy is allowed/);
    expect(prompt).toMatch(/separate or parallel work \(not an extension of the main path\) goes on its own row below/);
  });

  it('says a pasted cache keeps its root and needs a new one before Save', () => {
    expect(prompt).toMatch(/pasted cache keeps the same root[^\n]*new root[^\n]*before Save/i);
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
