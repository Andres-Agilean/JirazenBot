/**
 * Per-key serialization so overlapping activities for the same conversation cannot interleave
 * (review findings: Important 1 & 2). `resolveSlots` reads the binding store at entry and `ask()`
 * writes it back only after `answerFn` returns -- seconds later, in production. Two concrete
 * failures follow from that gap: (a) a `voltar` arriving while an earlier `ask` for the same
 * conversation is still in flight can delete a personal slot that the in-flight `ask` then
 * resurrects with a stale write, contradicting what the bot just told the user; (b) two people
 * asking against the same shared binding concurrently both read the same `history` and one
 * exchange is lost to a last-write-wins race. Neither is fixable by touching `bindings.ts` alone
 * -- the store itself is not the problem, the overlap in *callers* is.
 *
 * `runExclusive` chains calls sharing a key onto one promise so the pipeline for a given
 * conversation runs start-to-finish before the next one begins. This trades a little latency --
 * a second person's message waits for the first person's answer to finish being stored -- for
 * correctness, which is the right trade inside a single thread: nobody expects two overlapping
 * answers to a shared card to race each other.
 */

const chains = new Map<string, Promise<void>>();

/**
 * Runs `fn` only after every previously-scheduled `runExclusive` call for the same `key` has
 * settled (whether it resolved or rejected), so calls for one key never execute concurrently.
 * Calls for different keys are completely independent and run as soon as they are invoked.
 *
 * The map entry for `key` is removed once its chain drains back to empty, so a long-running bot
 * process does not accumulate one entry per conversation ever seen.
 */
export function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(fn, fn);

  // What the NEXT call for this key waits on: settles only after `result` settles, and never
  // itself rejects, so `previous` above is always a fulfilled promise for every caller.
  const waitable = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, waitable);
  waitable.finally(() => {
    // Only the most recent scheduled call for this key can equal the current map entry; an
    // earlier call's `waitable` was already overwritten by whatever came after it, so this
    // guard is what makes the drained-chain deletion safe under concurrent keys.
    if (chains.get(key) === waitable) chains.delete(key);
  });

  return result;
}
