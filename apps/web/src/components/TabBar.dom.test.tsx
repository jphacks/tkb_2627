// @vitest-environment jsdom
// DOM test environment (jsdom + Testing Library), approved by M1 on #9. Other tests keep the node environment.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { U01App } from '../screens/U01App.tsx';
import { TabBar } from './TabBar.tsx';

// jsdom has no layout, so window.scrollTo (called on screen changes) is not implemented there.
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;

afterEach(() => cleanup());

describe('TabBar (DOM)', () => {
  it('marks the active tab and calls onSelect with the clicked tab', () => {
    const onSelect = vi.fn();
    render(<TabBar active="trips" onSelect={onSelect} />);
    expect(screen.getByRole('button', { name: /旅程/ }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: /新規作成/ }));
    expect(onSelect).toHaveBeenCalledWith('new');
  });
});

describe('U01App (DOM)', () => {
  it('shows the mock trips, then the condition form after clicking 新規作成', async () => {
    render(<U01App />);
    expect(await screen.findByText('金沢 1泊2日（fixture）')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /新規作成/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '旅の条件を入力' })).toBeTruthy());
  });
});
