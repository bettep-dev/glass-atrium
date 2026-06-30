// Single-entry, time-keyed TTL cache for quasi-static values that are expensive
// to recompute on high-volume routes. The stored value is keyed only by elapsed
// time, NOT by the producer's arguments — on a hit within the TTL window get()
// returns the prior result and ignores its arguments, so callers passing
// per-request handles (a Prisma client, a request logger) get the cached result.

interface CacheEntry<T> {
	expiresAt: number;
	result: T;
}

export interface TtlCache<T, A extends unknown[]> {
	get(...args: A): Promise<T>;
	reset(): void;
}

export function createTtlCache<T, A extends unknown[]>(
	ttlMs: number,
	producer: (...args: A) => Promise<T>,
): TtlCache<T, A> {
	let entry: CacheEntry<T> | null = null;
	return {
		async get(...args: A): Promise<T> {
			// Single-threaded event loop — the read/expiry check and the write below
			// never interleave at an await boundary, so concurrent requests cannot
			// corrupt this; the worst case is two cold requests each computing once
			// and writing an equivalent (idempotent) result.
			if (entry !== null && Date.now() < entry.expiresAt) {
				return entry.result;
			}
			const result = await producer(...args);
			entry = { expiresAt: Date.now() + ttlMs, result };
			return result;
		},
		reset(): void {
			entry = null;
		},
	};
}
