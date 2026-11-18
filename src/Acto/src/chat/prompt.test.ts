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

  it('teaches the shared graph and the triangle in three sentences, then the tools', () => {
    const model = prompt.split('\n').find((l) => /shared graph/i.test(l)) ?? '';
    expect(model.match(/[.!?](\s|$)/g)).toHaveLength(3);
    expect(prompt).toMatch(/triangle/i);
    expect(prompt).toMatch(/entry steps/i);
    expect(prompt).toMatch(/Save is board-wide/);
    expect(prompt).toMatch(/dry run/);
    expect(prompt).toMatch(/Start refuses/);
    expect(prompt).toMatch(/always has a processor/);
    expect(prompt).toMatch(/entry condition/);
    expect(prompt).toMatch(/workflow_id/);
  });

  it('names every tool', () => {
    for (const t of TOOL_DEFS) expect(prompt).toContain(t.name);
    for (const name of ['list_workflows', 'read_board', 'read_entity', 'read_output', 'list_processors', 'list_caches', 'list_schemas', 'new_workflow', 'add_step', 'add_cache', 'connect', 'disconnect', 'set_entry', 'remove_entry', 'link_cache', 'unlink_cache', 'set_field', 'set_payload', 'remove_assignment', 'set_processor', 'move_blocks', 'pick', 'copy', 'paste', 'delete_picked', 'delete_workflow', 'save', 'undo', 'redo', 'start', 'stop', 'list_ghosts', 'read_selection', 'restore_ghosts', 'remove_ghosts', 'take_stored']) {
      expect(TOOL_DEFS.map((t) => t.name)).toContain(name);
      expect(prompt).toContain(name);
    }
    expect(TOOL_DEFS).toHaveLength(36);
  });

  it('has none of the redundant lines (2026-11-18 rule audit): each rule is said once', () => {
    expect(prompt).not.toMatch(/smooth curve/);
    expect(prompt).not.toMatch(/Acto asks the user first/);
    expect(prompt).not.toMatch(/Save, start and stop only when asked/);
    expect(prompt.match(/Never save, start or stop on your own/g)).toHaveLength(1);
  });

  it('states the selection and Inspector rules, the cache root rule and the ghost and Take stored tools', () => {
    expect(prompt).toMatch(/Ctrl\+click toggles/);
    expect(prompt).toMatch(/exactly one workflow and one step, Step and Processor with that workflow's assignment/);
    expect(prompt).toMatch(/BaseAPI refuses to save a cache without a root/);
    expect(prompt).toMatch(/restore_ghosts/);
    expect(prompt).toMatch(/take_stored/);
  });

  it('has no wording of the frame era', () => {
    for (const word of ['frame', 'parked', 'locked', 'read_design', 'create_assignment']) expect(prompt.toLowerCase()).not.toContain(word);
    expect(prompt).not.toMatch(/\block\b/i);
    expect(prompt).not.toMatch(/Save saves one workflow/);
  });

  it('names no tool that does not exist (every snake_case word is a tool or an argument of one)', () => {
    const known = new Set<string>(TOOL_DEFS.map((t) => t.name));
    for (const t of TOOL_DEFS) for (const k of Object.keys((t.parameters as { properties?: object }).properties ?? {})) known.add(k);
    const words = new Set(prompt.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);
    expect([...words].filter((w) => !known.has(w))).toEqual([]);
  });

});
