/**
 * How reliable this phone number has been with this store: finished orders delivered versus
 * returned. "new" until there's history.
 */
export function deliveryRisk(c: { delivered: number; returned: number }) {
  const finished = c.delivered + c.returned;
  if (finished === 0) return { level: 'new' as const, successRate: null };
  const rate = c.delivered / finished;
  const level: 'high' | 'watch' | 'good' =
    (c.returned >= 2 && rate < 0.5) || (c.returned >= 1 && c.delivered === 0) ? 'high' : rate < 0.8 ? 'watch' : 'good';
  return { level, successRate: Math.round(rate * 100) };
}
