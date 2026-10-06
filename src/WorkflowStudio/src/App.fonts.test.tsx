import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudioApi } from './api/client';
import { App } from './App';
import * as fitText from './canvas/fitText';

// Its own file: the fitter is made once per document per module, and this test must see it made.
vi.mock('./canvas/fitText', async (original) => {
  const actual = await original<typeof import('./canvas/fitText')>();
  return { ...actual, createTextFitter: vi.fn(actual.createTextFitter) };
});

afterEach(() => { delete (document as { fonts?: unknown }).fonts; });

describe('App fonts (plan 2 preload, kept)', () => {
  it('starts loading every measured face as the page opens, before any fitter is made', async () => {
    const load = vi.fn().mockResolvedValue([]);
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load, ready: Promise.resolve() } });
    const api = { listWorkflows: vi.fn().mockResolvedValue({ ok: true, value: [] }) } as unknown as StudioApi;

    render(<App api={api} storage={null} />);

    await waitFor(() => expect(fitText.createTextFitter).toHaveBeenCalled());
    expect(load.mock.calls.map((c) => c[0]).sort()).toEqual([...fitText.MEASURED_FONTS].sort());
    expect(Math.max(...load.mock.invocationCallOrder)).toBeLessThan(vi.mocked(fitText.createTextFitter).mock.invocationCallOrder[0]!);
  });
});
