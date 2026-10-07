export type NotificationCount = { through: number; unread: number };

export function mergeNotificationCount(previous: NotificationCount | undefined, value: { throughSequence?: number; unread?: number }) {
  if (!Number.isSafeInteger(value.throughSequence) || value.throughSequence! < 0 || !Number.isSafeInteger(value.unread) || value.unread! < 0) return previous;
  const next = { through: value.throughSequence!, unread: value.unread! };
  // Without a new event sequence, reading and expiry can only reduce unread counts.
  return previous && (next.through < previous.through || next.through === previous.through && next.unread >= previous.unread) ? previous : next;
}
