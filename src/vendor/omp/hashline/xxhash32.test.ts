// Vendored from can1357/oh-my-pi@03c48d073 packages/hashline (MIT)
// NexusIDE port test: pins the pure-TS xxHash32 replacement to the reference
// XXH32 vectors so the 4-hex hashline tags stay bit-identical to the values
// Bun.hash.xxHash32 minted upstream, and sanity-checks the jsdiff/lru-cache
// stand-ins the port introduced.
import { describe, expect, it } from 'vitest';
import { computeFileHash } from './format';
import { diffArrays } from './line-diff';
import { HashlineLruCache } from './lru';
import { xxHash32 } from './xxhash32';

describe('xxHash32 reference vectors (must match Bun.hash.xxHash32)', () => {
	it('hashes the canonical XXH32 test vectors with seed 0', () => {
		expect(xxHash32('', 0)).toBe(0x02cc5d05);
		expect(xxHash32('a', 0)).toBe(0x550d7456);
		expect(xxHash32('abc', 0)).toBe(0x32d153ff);
		// 39 bytes — exercises the 16-byte stripe loop plus the 4-byte and
		// 1-byte tails.
		expect(xxHash32('Nobody inspects the spammish repetition', 0)).toBe(0xe2293b2f);
	});

	it('accepts raw bytes and hashes them identically to the equivalent string', () => {
		const bytes = new TextEncoder().encode('Nobody inspects the spammish repetition');
		expect(xxHash32(bytes, 0)).toBe(0xe2293b2f);
	});

	it('hashes multi-byte UTF-8 input over its encoded bytes', () => {
		const text = 'ação já 🚀';
		expect(xxHash32(text, 0)).toBe(xxHash32(new TextEncoder().encode(text), 0));
	});

	it('folds the seed in per the XXH32 spec', () => {
		// Different seeds must diverge; seed 0 must stay canonical.
		expect(xxHash32('abc', 1)).not.toBe(xxHash32('abc', 0));
		expect(xxHash32('abc', 0xffffffff)).not.toBe(xxHash32('abc', 0));
	});
});

describe('computeFileHash tag parity fixtures', () => {
	it('derives the 4-hex tag from the low 16 bits of xxHash32(text, 0)', () => {
		// 0x02CC5D05 & 0xffff = 0x5D05, etc. These are the exact tags the
		// upstream Bun-backed implementation minted for the same content.
		expect(computeFileHash('')).toBe('5D05');
		expect(computeFileHash('a')).toBe('7456');
		expect(computeFileHash('abc')).toBe('53FF');
		expect(computeFileHash('Nobody inspects the spammish repetition')).toBe('3B2F');
	});

	it('normalizes trailing whitespace and CR before hashing', () => {
		expect(computeFileHash('abc  ')).toBe('53FF');
		expect(computeFileHash('abc\t')).toBe('53FF');
		expect(computeFileHash('a \nabc')).toBe(computeFileHash('a\nabc'));
		expect(computeFileHash('a\r\nabc')).toBe(computeFileHash('a\nabc'));
	});
});

describe('diffArrays stand-in (jsdiff diffArrays contract)', () => {
	it('reports a pure equality as one unchanged run', () => {
		expect(diffArrays(['a', 'b'], ['a', 'b'])).toEqual([{ value: ['a', 'b'] }]);
	});

	it('aligns an insertion between unchanged runs', () => {
		expect(diffArrays(['a', 'c'], ['a', 'b', 'c'])).toEqual([
			{ value: ['a'] },
			{ value: ['b'], added: true },
			{ value: ['c'] },
		]);
	});

	it('aligns a deletion between unchanged runs', () => {
		expect(diffArrays(['a', 'b', 'c'], ['a', 'c'])).toEqual([
			{ value: ['a'] },
			{ value: ['b'], removed: true },
			{ value: ['c'] },
		]);
	});

	it('emits removed before added for a same-region replacement', () => {
		expect(diffArrays(['a', 'x', 'c'], ['a', 'y', 'c'])).toEqual([
			{ value: ['a'] },
			{ value: ['x'], removed: true },
			{ value: ['y'], added: true },
			{ value: ['c'] },
		]);
	});

	it('handles disjoint rewrites and empty sides', () => {
		expect(diffArrays([], ['a'])).toEqual([{ value: ['a'], added: true }]);
		expect(diffArrays(['a'], [])).toEqual([{ value: ['a'], removed: true }]);
		expect(diffArrays([], [])).toEqual([]);
	});

	it('preserves every unchanged line mapping on a scattered edit', () => {
		const before = ['h1', 'h2', 'k1', 'x', 'k2', 'y', 'k3', 't1'];
		const after = ['h1', 'h2', 'NEW', 'k1', 'k2', 'z', 'k3', 't1'];
		const changes = diffArrays(before, after);
		// Every change is a coherent partition of both arrays.
		const oldJoined = changes.filter(c => !c.added).flatMap(c => c.value);
		const newJoined = changes.filter(c => !c.removed).flatMap(c => c.value);
		expect(oldJoined).toEqual(before);
		expect(newJoined).toEqual(after);
		// The shared skeleton survives as unchanged runs.
		const unchanged = changes.filter(c => !c.added && !c.removed).flatMap(c => c.value);
		expect(unchanged).toContain('k1');
		expect(unchanged).toContain('k2');
		expect(unchanged).toContain('k3');
	});
});

describe('HashlineLruCache stand-in (lru-cache contract subset)', () => {
	it('evicts least-recently-used entries beyond max', () => {
		const cache = new HashlineLruCache<string, string[]>({
			max: 2,
			maxSize: 1_000,
			sizeCalculation: value => value.length + 1,
		});
		cache.set('a', ['1']);
		cache.set('b', ['2']);
		expect(cache.get('a')).toEqual(['1']); // refreshes `a`
		cache.set('c', ['3']);
		expect(cache.get('b')).toBeUndefined();
		expect(cache.get('a')).toEqual(['1']);
		expect(cache.get('c')).toEqual(['3']);
	});

	it('enforces the maxSize budget by evicting old entries', () => {
		const cache = new HashlineLruCache<string, string>({
			max: 100,
			maxSize: 10,
			sizeCalculation: value => value.length,
		});
		cache.set('a', 'aaaaa');
		cache.set('b', 'bbbbb');
		cache.set('c', 'cc');
		expect(cache.get('a')).toBeUndefined();
		expect(cache.get('b')).toBe('bbbbb');
		expect(cache.get('c')).toBe('cc');
	});

	it('does not store an entry larger than maxSize', () => {
		const cache = new HashlineLruCache<string, string>({
			max: 10,
			maxSize: 4,
			sizeCalculation: value => value.length,
		});
		cache.set('big', 'aaaaaaaa');
		expect(cache.get('big')).toBeUndefined();
	});
});
