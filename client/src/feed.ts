import type { Activity } from '../../server/domain/types.ts';
export function mergeActivities(
  existing: Activity[],
  incoming: Activity[],
  maximum = 500,
): Activity[] {
  const byId = new Map(existing.map((event) => [event.id, event]));
  // Live replays do not overwrite a read toggle already applied in this tab.
  for (const event of incoming) if (!byId.has(event.id)) byId.set(event.id, event);
  return [...byId.values()]
    .sort((a, b) =>
      BigInt(a.sequence) > BigInt(b.sequence)
        ? -1
        : BigInt(a.sequence) < BigInt(b.sequence)
          ? 1
          : 0,
    )
    .slice(0, maximum);
}
