import { describe, expect, it } from 'vitest';
import { createGeneration } from './generation';

describe('a generation', () => {
  it('keeps a run current until the generation ends, and never again after', () => {
    const generation = createGeneration();
    const first = generation.start();
    expect(first()).toBe(true);

    generation.end();
    expect(first()).toBe(false);

    const second = generation.start();
    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });

  it('ends every run started so far at once', () => {
    const generation = createGeneration();
    const runs = [generation.start(), generation.start()];
    generation.end();
    expect(runs.map((current) => current())).toEqual([false, false]);
  });
});
