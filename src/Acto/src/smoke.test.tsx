import { render, screen } from '@testing-library/react';
import { it, expect } from 'vitest';
import { App } from './App';
import { fakeApi } from './board/testApi';
import { liveStub } from './test/liveStub';
import { memoryStorage } from './test/memoryStorage';

it('renders Acto', () => {
  render(<App api={fakeApi()} live={liveStub()} storage={memoryStorage()} />);
  expect(screen.getByText('Acto')).toBeInTheDocument();
});
