/** Pending (unsaved) edit list for the U06 edit screen. Nothing is sent until the user picks a candidate. */
import type { TripOperation } from '@tkb/contracts';

export const MAX_PENDING = 50;

export interface PendingState { ops: TripOperation[] }
export type PendingAction =
  | { type: 'push'; op: TripOperation }
  | { type: 'undo' }
  | { type: 'clear' };

export const initialPending: PendingState = { ops: [] };

export function pendingReducer(state: PendingState, action: PendingAction): PendingState {
  switch (action.type) {
    case 'push': return state.ops.length >= MAX_PENDING ? state : { ops: [...state.ops, action.op] };
    case 'undo': return state.ops.length === 0 ? state : { ops: state.ops.slice(0, -1) };
    case 'clear': return state.ops.length === 0 ? state : initialPending;
  }
}

export function describeOp(op: TripOperation, titleOf: (id: string) => string): string {
  switch (op.op) {
    case 'add': return `追加: ${op.item.type === 'activity' ? op.item.title : '移動区間'}（${op.dayIndex + 1}日目）`;
    case 'remove': return `削除: ${titleOf(op.itemId)}`;
    case 'move': return `移動: ${titleOf(op.itemId)}（${op.toDayIndex + 1}日目の${op.toPosition + 1}番目）`;
    case 'update': return `更新: ${titleOf(op.itemId)}`;
    case 'set_title': return `題名変更: ${op.title}`;
  }
}
