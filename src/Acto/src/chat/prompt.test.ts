import { describe, expect, it } from 'vitest';
import { CONDITIONS } from '../model/entryConditions';
import { systemPrompt } from './prompt';
import { DESTRUCTIVE, TOOL_DEFS } from './tools';

describe('systemPrompt', () => {
  const prompt = systemPrompt();

  it('mentions none of WorkflowStudio\'s removed drawing and document notions', () => {
    for (const word of ['junction', 'bend', 'hub', 'open_workflow', 'activate']) expect(prompt.toLowerCase()).not.toContain(word);
  });

  it('names every family and every destructive tool, and says they ask the user', () => {
    for (const c of CONDITIONS) expect(prompt).toContain(c.name);
    for (const name of DESTRUCTIVE) expect(prompt).toContain(name);
    expect(prompt).toMatch(/asks the user/);
  });

  it('teaches Acto\'s board', () => {
    expect(prompt).toMatch(/one board/i);
    expect(prompt).toMatch(/frame/);
    expect(prompt).toMatch(/always has a processor/);
    expect(prompt).toMatch(/first steps?[^.\n]*derived from the wires/i);
    expect(prompt).toMatch(/one wire per link/i);
    expect(prompt).toMatch(/entry condition/);
    expect(prompt).toMatch(/workflow_id/);
    expect(prompt).toMatch(/Save saves one workflow/);
    expect(prompt).toMatch(/Start runs the saved version/);
  });

  it('names no tool that does not exist (every snake_case word is a tool or an argument of one)', () => {
    const known = new Set<string>(TOOL_DEFS.map((t) => t.name));
    for (const t of TOOL_DEFS) for (const k of Object.keys((t.parameters as { properties?: object }).properties ?? {})) known.add(k);
    const words = new Set(prompt.match(/[a-z]+(?:_[a-z]+)+/g) ?? []);
    expect([...words].filter((w) => !known.has(w))).toEqual([]);
  });

  it('describes the field and assignment tools', () => {
    for (const name of ['set_field', 'create_assignment', 'remove_assignment']) expect(prompt).toContain(name);
  });
});
