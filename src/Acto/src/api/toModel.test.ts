import { describe, expect, it } from 'vitest';
import { stepDto } from './fixtures';
import { stepFromDto } from './toModel';

describe('stepFromDto', () => {
  it('rejects a DTO without an id, because nothing downstream can key it', () => {
    expect(() => stepFromDto(stepDto('', { id: undefined } as never))).toThrow(/id/);
  });
});
