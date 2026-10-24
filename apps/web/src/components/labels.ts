import type { JobStage, JobState, ValidationState, Visibility } from '@tkb/contracts';
import type { MockScenario } from '../mocks/index.ts';

/** Shown instead of a value that is null/unknown. Never 0 (R11). */
export const UNKNOWN_LABEL = '未取得';

export const VALIDATION_LABEL: Record<ValidationState, string> = {
  valid: '検証済み',
  needs_review: '要確認',
  needs_revalidation: '再検証が必要',
  invalid: '無効',
};

export const JOB_STATE_LABEL: Record<JobState, string> = {
  queued: '順番待ち',
  running: '生成中',
  succeeded: '完了',
  failed: '失敗',
  cancelled: '取消済み',
};

export const JOB_STAGE_LABEL: Record<JobStage, string> = {
  queued: '受付済み',
  collecting_context: '地点・移動情報の収集',
  generating: '候補の生成',
  validating: '条件の検証',
  saving: '保存中',
  saved: '保存済み',
  done: '完了',
};

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: '非公開',
  group: 'グループ',
  public: '公開',
};

export const TRANSPORT_LABEL = { transit: '公共交通', car: '車' } as const;

export const SCENARIO_LABEL: Record<MockScenario, string> = {
  normal: '通常',
  empty: '空（旅程なし）',
  error: 'エラー',
  slow: '低速',
  budgetUnknown: '予算なし・費用未取得',
};

export const SCENARIOS: readonly MockScenario[] = ['normal', 'empty', 'error', 'slow', 'budgetUnknown'];
