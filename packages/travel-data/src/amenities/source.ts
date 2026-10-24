import type { AmenitySourceDescriptor } from './types.ts';

export const GSI_SHELTER_SOURCE: AmenitySourceDescriptor = {
  id: 'gsi-shelters',
  name: '国土地理院 指定緊急避難場所・指定避難所データ',
  region: '日本国内',
  attribution: '出典: 国土地理院「指定緊急避難場所データ・指定避難所データ」（利用条件は公式ページで確認すること）',
  url: 'https://hinanmap.gsi.go.jp/',
  liveImplemented: false,
};

/** Rough bounds of Japan including the islands. Used to tell "unsupported region" from "no data here". */
export const JAPAN_BOUNDS = { south: 20, west: 122, north: 46, east: 154 } as const;
