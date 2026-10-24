/** Per-user guard for K05: one request at a time and a daily cap (in memory, resets on restart). */
export interface UserLimiter {
  /** A release function, or the reason it was refused. */
  acquire(userId: string): (() => void) | 'busy' | 'daily';
}

export function createUserLimiter(opts: { perDay: number; now?: () => number }): UserLimiter {
  const now = opts.now ?? Date.now;
  const active = new Set<string>();
  let day = '';
  const counts = new Map<string, number>();
  return {
    acquire(userId) {
      const today = new Date(now()).toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        counts.clear();
      }
      if (active.has(userId)) return 'busy';
      const n = counts.get(userId) ?? 0;
      if (n >= opts.perDay) return 'daily';
      counts.set(userId, n + 1);
      active.add(userId);
      return () => void active.delete(userId);
    },
  };
}
