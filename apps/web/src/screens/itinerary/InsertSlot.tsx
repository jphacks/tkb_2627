/**
 * Placeholder for M3's insert UI (U11 #213 leaves the slot; M3 builds the UI in this file).
 * Rendered by the edit table before the first stay, between stays and after the last stay. Renders nothing for now.
 */
export interface InsertSlotProps {
  position: 'before-first' | 'between' | 'after-last';
  onAdd(item: { title: string; start?: string; end?: string }): void;
  disabled?: boolean;
}

export function InsertSlot(_props: InsertSlotProps): React.ReactNode {
  return null;
}
