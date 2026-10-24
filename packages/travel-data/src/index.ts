// @tkb/travel-data — owner M3 (D01-D04, D07, D08): provider adapters, fixture provider, usage limits.
// D02 (call limits, cancellation, data policy), D03 (places, without photos) and D04 (routes) are implemented;
// D07 (guides: Wikipedia text and licensed Commons photos) is implemented; D08 is not yet.
export const PACKAGE_STATUS = 'not_implemented' as const;
export * from './policy/index.ts';
export * from './places/index.ts';
export * from './guides/index.ts';
export * from './routes/index.ts';
