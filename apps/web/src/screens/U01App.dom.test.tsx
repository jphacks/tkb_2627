// @vitest-environment jsdom
// DOM test environment (jsdom + Testing Library), approved by M1 on #9. Other tests keep the node environment.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { U01App } from './U01App.tsx';

// jsdom has no layout, so window.scrollTo (called on screen changes) is not implemented there.
beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const tabBar = () => within(screen.getByRole('navigation', { name: 'メインメニュー' }));

describe('U01App (DOM)', () => {
  it('shows the mock trips, then the condition form after clicking the 新規作成 tab', async () => {
    render(<U01App />);
    expect(await screen.findByText('金沢 1泊2日（fixture）')).toBeTruthy();
    fireEvent.click(tabBar().getByRole('button', { name: '新規作成' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '旅の条件を入力' })).toBeTruthy());
    expect(tabBar().getByRole('button', { name: '新規作成' }).getAttribute('aria-current')).toBe('page');
    expect(tabBar().getByRole('button', { name: '旅程' }).getAttribute('aria-current')).toBeNull();
  });

  it('the empty scenario offers 旅程を新規作成する without confusing the tab buttons', async () => {
    render(<U01App initialScenario="empty" />);
    const create = await screen.findByRole('button', { name: '旅程を新規作成する' });
    fireEvent.click(create);
    await waitFor(() => expect(screen.getByRole('heading', { name: '旅の条件を入力' })).toBeTruthy());
  });
});
