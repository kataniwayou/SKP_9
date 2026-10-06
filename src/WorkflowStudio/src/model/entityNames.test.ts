import { describe, expect, it } from 'vitest';
import { entityName } from './entityNames';

describe('entityName', () => {
  it('formats name, version and the last two id groups, as Messaging.Contracts.EntityNames.Format does', () => {
    expect(entityName('kafka-import-export', '2.0.0', 'a5498df6-1522-4098-ad65-f4aff4998988'))
      .toBe('kafka-import-export_2.0.0-ad65-f4aff4998988');
  });

  it('lower-cases the suffix, as the C# "D" format does', () => {
    expect(entityName('wf', '1.0.0', 'A5498DF6-1522-4098-AD65-F4AFF4998988')).toBe('wf_1.0.0-ad65-f4aff4998988');
  });

  it('uses the whole id when it is not a GUID', () => {
    expect(entityName('wf', '1.0.0', 'w1')).toBe('wf_1.0.0-w1');
  });
});
