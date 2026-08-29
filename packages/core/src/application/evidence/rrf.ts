/** Stable fused identity and score, intentionally independent of evidence payloads. */
export type RankedId = Readonly<{ id: string; score: number }>;

/** Combines ranked evidence lists deterministically while counting each ID only once per list. */
export function reciprocalRankFusion(lists: readonly (readonly string[])[], k = 60): RankedId[] {
  if (!Number.isInteger(k) || k <= 0) throw new Error('RRF k must be a positive integer');
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((id, index) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}
