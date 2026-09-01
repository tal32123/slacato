/** Stable fused identity and score, intentionally independent of evidence payloads. */
export type RankedId = Readonly<{ id: string; score: number }>;

/** One ranked candidate list plus the share of fused mass it is allowed to contribute. */
export type WeightedRankedList = Readonly<{ ids: readonly string[]; weight: number }>;

/** Combines weighted ranked lists deterministically while counting each ID only once per list.
 *
 * Plain RRF gives every list an equal vote. That is the right default when the lists are
 * independent retrievals of the SAME question, and the wrong one here: the hybrid plan runs the
 * caller's query alongside six fixed section queries, so an unweighted fusion lets the fixed
 * queries outvote the question that was actually asked. Weights make that ratio explicit and
 * reviewable instead of an accident of how many section queries the plan happens to declare. */
export function weightedReciprocalRankFusion(
  lists: readonly WeightedRankedList[],
  k = 60
): RankedId[] {
  if (!Number.isInteger(k) || k <= 0) throw new Error('RRF k must be a positive integer');
  if (lists.some((list) => !Number.isFinite(list.weight) || list.weight < 0))
    throw new Error('RRF list weight must be a non-negative finite number');
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.ids.forEach((id, index) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + list.weight / (k + index + 1));
    });
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

/** Combines ranked evidence lists deterministically while counting each ID only once per list. */
export function reciprocalRankFusion(lists: readonly (readonly string[])[], k = 60): RankedId[] {
  return weightedReciprocalRankFusion(
    lists.map((ids) => ({ ids, weight: 1 })),
    k
  );
}
