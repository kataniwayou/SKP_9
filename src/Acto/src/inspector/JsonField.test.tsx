import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JsonField } from './JsonField';

function Host({ start }: { start: string }) {
  const [value, setValue] = useState(start);
  return <JsonField label="Payload" value={value} saved={start} onChange={setValue} />;
}

describe('JsonField', () => {
  it('keeps its height when it loses the focus: a one-line typed payload is as tall as its pretty layout', () => {
    render(<Host start="" />);
    const box = screen.getByLabelText('Payload') as HTMLTextAreaElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '{"a":1,"b":2,"c":3}' } });
    expect(box.value).toBe('{"a":1,"b":2,"c":3}'); // as typed while in the field
    const typing = box.rows;
    expect(typing).toBe(5); // the pretty layout's five lines
    fireEvent.blur(box);
    expect(box.value).toBe('{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}');
    expect(box.rows).toBe(typing);
  });
  it('shows the value pretty, as tall as its lines', () => {
    render(<Host start='{"a":1}' />);
    const box = screen.getByLabelText('Payload') as HTMLTextAreaElement;
    expect(box.value).toBe('{\n  "a": 1\n}');
    expect(box.rows).toBe(3);
  });
});
