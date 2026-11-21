/**
 * The secrets that may be used to check what comes in: the current one, and the previous one
 * until its time has passed. Plain code, no clock of its own: the caller passes `now`.
 * A previous secret with no end time is not valid (a key is never kept open without a limit).
 */
export function activeSecrets(
  current: string,
  prev: string | null,
  prevUntil: Date | null,
  now: Date,
): string[] {
  if (prev && prevUntil && prevUntil.getTime() > now.getTime()) return [current, prev];
  return [current];
}
