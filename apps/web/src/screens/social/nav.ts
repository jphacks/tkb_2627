/** U08 screen flow: a pure reducer (no React, no I/O). */
import type { CopyResult } from '@tkb/contracts';

export type SocialTab = 'feed' | 'compose' | 'groups';

export type SocialScreen =
  | { name: 'feed' }
  | { name: 'post'; postId: string; mine: boolean }
  | { name: 'compose' }
  | { name: 'groups' }
  | { name: 'invite'; token: string }
  | { name: 'copied'; result: CopyResult };

export interface SocialNav {
  screen: SocialScreen;
  history: SocialScreen[];
}

export type SocialNavAction =
  | { type: 'tab'; tab: SocialTab }
  | { type: 'openPost'; postId: string; mine: boolean }
  | { type: 'copied'; result: CopyResult }
  | { type: 'posted'; postId: string }
  | { type: 'joined' }
  | { type: 'back' };

export const initialNav = (inviteToken: string | null = null): SocialNav => ({
  screen: inviteToken ? { name: 'invite', token: inviteToken } : { name: 'feed' },
  history: [],
});

export function tabOf(screen: SocialScreen): SocialTab {
  if (screen.name === 'compose') return 'compose';
  if (screen.name === 'groups' || screen.name === 'invite') return 'groups';
  return 'feed';
}

export function navReducer(state: SocialNav, action: SocialNavAction): SocialNav {
  switch (action.type) {
    case 'tab':
      return { screen: { name: action.tab }, history: [] };
    case 'openPost':
      return { screen: { name: 'post', postId: action.postId, mine: action.mine }, history: [...state.history, state.screen] };
    case 'copied':
      return { screen: { name: 'copied', result: action.result }, history: [...state.history, state.screen] };
    case 'posted':
      // The finished compose flow is replaced: 戻る from the new post goes to the feed.
      return { screen: { name: 'post', postId: action.postId, mine: true }, history: [{ name: 'feed' }] };
    case 'joined':
      return { screen: { name: 'groups' }, history: [] };
    case 'back': {
      const prev = state.history[state.history.length - 1];
      return prev ? { screen: prev, history: state.history.slice(0, -1) } : state;
    }
  }
}
