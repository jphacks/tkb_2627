import type { ApiError, ErrorCode, GroupRole, Visibility } from '@tkb/contracts';
import type { z } from 'zod';
import { CONTRACT_MISMATCH } from './api.ts';

/** K14/K16: an invisible post and a missing post are the same answer (404). */
export const NOT_VISIBLE = '見つからないか閲覧権限がありません';

const BY_CODE: Partial<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: 'ログインが必要です。ログインしてからもう一度お試しください。',
  FORBIDDEN: 'この操作の権限がありません。',
  NOT_FOUND: `${NOT_VISIBLE}（削除されたか、公開範囲が変わった可能性があります）。`,
  REVISION_CONFLICT: 'ほかの操作で内容が更新されました。読み込み直してからやり直してください。',
  ALREADY_COMMITTED: 'すでに使用済みです。同じ確認画面や招待は2回使えません。',
  EXPIRED: '有効期限が切れました。最初からやり直してください。',
  VALIDATION_FAILED: '入力内容を確認してください。',
  RATE_LIMITED: '操作が多すぎます。しばらく待ってからお試しください。',
  UNAVAILABLE: 'サーバーに接続できません。しばらくしてからお試しください。',
  INTERNAL: 'サーバーでエラーが発生しました。',
};

/**
 * Japanese message for an API error. Client-side errors (requestId starting with `client_`) keep their own
 * Japanese text (e.g. the contract mismatch); server messages are English and are replaced.
 */
export function errorText(error: ApiError, overrides: Partial<Record<ErrorCode, string>> = {}): string {
  if (overrides[error.code]) return overrides[error.code]!;
  if (error.requestId.startsWith('client_') && error.message !== '' && !error.message.startsWith('HTTP ')) return error.message;
  return BY_CODE[error.code] ?? `エラーが発生しました（${error.code}）。`;
}

export { CONTRACT_MISMATCH };

export const VISIBILITY_HELP: Record<Visibility, string> = {
  private: '自分だけが見られます。フィードの「公開」「グループ」には出ません。',
  group: '選んだグループの現在のメンバーだけが見られます。',
  public: 'ログインしていない人も含めて、誰でも見られます。',
};

export const ROLE_LABEL: Record<z.infer<typeof GroupRole>, string> = {
  owner: '作成者',
  admin: '管理者',
  member: 'メンバー',
};

/** Labels for K12 redactedFields. Unknown names are shown as they are (never hidden). */
export const REDACTED_LABEL: Record<string, string> = {
  homeAddress: '自宅の住所',
  preciseCurrentLocation: '現在地の詳しい位置',
  privateNotes: '私的なメモ',
  budget: '予算',
  departure: '出発地',
  return: '帰着地',
  mustVisit: '必ず行きたい場所の指定',
  preferences: '好み・条件の指定',
  homeActivities: '自宅での予定',
  homeLegs: '自宅との間の移動',
  placeReference: '公開できない地点の参照',
  legProviderData: '転載できない経路情報（時刻・路線など）',
  placeProviderData: '転載できない地点の情報',
};

export const redactedLabel = (field: string): string => REDACTED_LABEL[field] ?? field;
