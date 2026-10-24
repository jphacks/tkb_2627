// @vitest-environment jsdom
// DOM test environment (jsdom + Testing Library), approved by M1 on #9. Other tests keep the node environment.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TabBar } from './TabBar.tsx';

afterEach(() => cleanup());

describe('TabBar (DOM)', () => {
  it('marks the active tab and calls onSelect with the clicked tab', () => {
    const onSelect = vi.fn();
    render(<TabBar active="trips" onSelect={onSelect} />);
    const nav = within(screen.getByRole('navigation', { name: 'メインメニュー' }));
    expect(nav.getByRole('button', { name: '旅程' }).getAttribute('aria-current')).toBe('page');
    expect(nav.getByRole('button', { name: '新規作成' }).getAttribute('aria-current')).toBeNull();
    fireEvent.click(nav.getByRole('button', { name: '新規作成' }));
    expect(onSelect).toHaveBeenCalledWith('new');
  });
});
