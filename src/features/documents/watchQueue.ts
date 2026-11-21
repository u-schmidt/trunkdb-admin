/**
 * Watch calls per session, each after the one before, so a stop and a start
 * made in order reach the backend in order, whatever the timing of the
 * requests.
 */
const watchQueues = new Map<string, Promise<unknown>>();

/** Queues `call` behind the watch calls already made for `sessionId`. */
export function queueWatch(sessionId: string, call: () => Promise<unknown>): void {
  const previous = watchQueues.get(sessionId) ?? Promise.resolve();
  // A call that fails leaves the queue going: a refused watch shows nothing.
  watchQueues.set(
    sessionId,
    previous.then(call).catch(() => undefined),
  );
}
