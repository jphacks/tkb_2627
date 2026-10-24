// @tkb/exports — owner M2 + M3 (E01, E03): print template, Maps URL, ICS.
// E03 (Maps URL, ICS) is implemented; the print template (E01) is not yet.
export const PACKAGE_STATUS = 'not_implemented' as const;
export * from './maps/index.ts';
export * from './calendar/index.ts';
