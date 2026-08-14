import { describe, expect, it } from 'vitest';
import { runExclusive } from '@/teams/serialize.js';

/** A deferred promise, for controlling exactly when a `runExclusive` call's `fn` resolves. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('runExclusive', () => {
  it('does not start a second call for the same key until the first has settled', async () => {
    const order: string[] = [];
    const first = deferred<void>();

    const p1 = runExclusive('k', async () => {
      order.push('first-start');
      await first.promise;
      order.push('first-end');
    });
    const p2 = runExclusive('k', async () => {
      order.push('second-start');
    });

    // Give any (incorrect) eager scheduling a chance to run before we unblock the first call.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    first.resolve();
    await p1;
    await p2;
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('runs calls for different keys concurrently', async () => {
    const order: string[] = [];
    const first = deferred<void>();

    const p1 = runExclusive('a', async () => {
      order.push('a-start');
      await first.promise;
      order.push('a-end');
    });
    const p2 = runExclusive('b', async () => {
      order.push('b-start');
      order.push('b-end');
    });

    await p2;
    // b finished completely while a is still blocked on its own deferred.
    expect(order).toEqual(['a-start', 'b-start', 'b-end']);

    first.resolve();
    await p1;
    expect(order).toEqual(['a-start', 'b-start', 'b-end', 'a-end']);
  });

  it('runs a later call even when an earlier call for the same key rejects', async () => {
    const order: string[] = [];

    const p1 = runExclusive('k', async () => {
      order.push('first');
      throw new Error('boom');
    });
    const p2 = runExclusive('k', async () => {
      order.push('second');
    });

    await expect(p1).rejects.toThrow('boom');
    await p2;
    expect(order).toEqual(['first', 'second']);
  });

  it('propagates each call result to its own caller', async () => {
    const a = await runExclusive('r', async () => 1);
    const b = await runExclusive('r', async () => 2);
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

});
