// The mock tools' notion of "today". Dates in the mock data are written
// relative to it (an order due in three days, a code valid for a year) so the
// demo doesn't go stale, and a test can pin it to a fixed day instead of
// depending on when it happens to run. Everything is UTC and whole days.
export const systemClock = () => new Date();

export function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
