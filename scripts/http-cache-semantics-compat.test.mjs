import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compatRoot = path.join(root, 'third_party', 'http-cache-semantics-compat');
const packageJson = require(path.join(root, 'package.json'));
const packageLock = require(path.join(root, 'package-lock.json'));
const provenance = require(
  path.join(
    root,
    'third_party',
    'provenance',
    'http-cache-semantics-4.2.0-compat.json',
  ),
);

const NOW = Date.parse('2026-10-03T12:00:00.000Z');

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function cut(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThan(0);
  expect(source.indexOf(startMarker, start + 1), startMarker).toBe(-1);
  const end = source.indexOf(endMarker, start);
  expect(end, endMarker).toBeGreaterThan(start);
  return { start, end };
}

/**
 * Rebuilds the upstream http-cache-semantics 4.2.0 `index.js` by reverting
 * exactly the two Nexus patches. The caller proves the result is
 * byte-identical to the npm tarball, so the patches are provably nothing
 * more than these hunks.
 */
function upstreamIndexSource() {
  let source = fs.readFileSync(path.join(compatRoot, 'index.js'), 'utf8');

  // Patch 1: the evaluateRequest() gate (plus its trailing blank line)...
  let span = cut(
    source,
    '        // Nexus security patch (GHSA-ch52-4w7c-c8xp): request directives',
    '        if (!this._requestMatches(req, false)) {',
  );
  source = source.slice(0, span.start) + source.slice(span.end);

  // ...and the _requiresRevalidation() predicate it calls.
  span = cut(
    source,
    '    /**\n     * Nexus security patch (GHSA-ch52-4w7c-c8xp / CVE-2026-93748).',
    '    /**\n     * Possibly outdated value of applicable max-age',
  );
  source = source.slice(0, span.start) + source.slice(span.end);

  // Patch 2: _varyMatches() back to the 4.2.0 wildcard/field comparison.
  const lastLine =
    '            if (req.headers[name] !== this._reqHeaders[name]) return false;\n';
  span = cut(
    source,
    '        // Nexus security patch (GHSA-f27v-pv5m-c5g6',
    lastLine,
  );
  const upstreamVary = [
    '        // A Vary header field-value of "*" always fails to match',
    "        if (this._resHeaders.vary === '*') {",
    '            return false;',
    '        }',
    '',
    '        const fields = this._resHeaders.vary',
    '            .trim()',
    '            .toLowerCase()',
    '            .split(/\\s*,\\s*/);',
    '        for (const name of fields) {',
    '            if (req.headers[name] !== this._reqHeaders[name]) return false;',
    '',
  ].join('\n');
  source =
    source.slice(0, span.start) +
    upstreamVary +
    source.slice(span.end + lastLine.length);
  return source;
}

function clockedFactory(CachePolicy) {
  let now = NOW;
  class ClockedPolicy extends CachePolicy {
    now() {
      return now;
    }
  }
  return {
    create: (req, res, options) => new ClockedPolicy(req, res, options),
    advance: (seconds) => {
      now += seconds * 1_000;
    },
  };
}

const httpDate = (offsetSeconds) =>
  new Date(NOW + offsetSeconds * 1_000).toUTCString();

function request(headers = {}, extra = {}) {
  return {
    method: 'GET',
    url: '/artifact',
    headers: { host: 'cache.example', ...headers },
    ...extra,
  };
}

function response(headers, status = 200) {
  return { status, headers: { date: httpDate(0), ...headers } };
}

/** Builds a policy at NOW, ages it, and evaluates `next` against it. */
function evaluate(CachePolicy, { req = request(), res, options, age = 0, next }) {
  const clock = clockedFactory(CachePolicy);
  const policy = clock.create(req, res, options);
  clock.advance(age);
  const result = policy.evaluateRequest(next);
  return {
    policy,
    satisfies: policy.satisfiesWithoutRevalidation(next),
    hit: Boolean(result.response),
    revalidation: result.revalidation ?? null,
    headers: result.response?.headers ?? null,
  };
}

/** Every observable of a policy, for the differential corpus. */
function observe(CachePolicy, scenario) {
  const { policy, ...evaluated } = evaluate(CachePolicy, scenario);
  const revalidated = policy.revalidatedPolicy(scenario.next, {
    status: 304,
    headers: { etag: scenario.res.headers.etag ?? '"v1"' },
  });
  const failed = policy.revalidatedPolicy(scenario.next, {
    status: 503,
    headers: {},
  });
  return {
    storable: policy.storable(),
    maxAge: policy.maxAge(),
    timeToLive: policy.timeToLive(),
    stale: policy.stale(),
    useStaleWhileRevalidate: policy.useStaleWhileRevalidate(),
    responseHeaders: policy.responseHeaders(),
    revalidationHeaders: policy.revalidationHeaders(scenario.next),
    serialized: JSON.stringify(policy.toObject()),
    revalidated: {
      modified: revalidated.modified,
      matches: revalidated.matches,
      maxAge: revalidated.policy.maxAge(),
    },
    failed: { modified: failed.modified, matches: failed.matches },
    reuse: evaluated,
  };
}

const RESPONSES = {
  'max-age': { 'cache-control': 'max-age=60' },
  public: { 'cache-control': 'public, max-age=60' },
  's-maxage': { 'cache-control': 's-maxage=30, max-age=60' },
  'max-age=0': { 'cache-control': 'max-age=0' },
  'expires past': { expires: httpDate(-3_600) },
  'expires future': { expires: httpDate(60) },
  heuristic: { 'last-modified': httpDate(-10 * 86_400) },
  'must-revalidate': { 'cache-control': 'max-age=60, must-revalidate' },
  'stale-while-revalidate': {
    'cache-control': 'max-age=60, stale-while-revalidate=120',
  },
  'stale-if-error': { 'cache-control': 'max-age=60, stale-if-error=300' },
  immutable: { 'cache-control': 'max-age=60, immutable' },
  etag: { 'cache-control': 'max-age=60', etag: '"v1"' },
  'last-modified validator': {
    'cache-control': 'max-age=60',
    'last-modified': httpDate(-60),
  },
  'vary accept-encoding': {
    'cache-control': 'max-age=60',
    vary: 'Accept-Encoding',
  },
  'vary list': { 'cache-control': 'max-age=60', vary: 'accept-encoding , accept-language' },
  'set-cookie public': {
    'cache-control': 'public, max-age=60',
    'set-cookie': 'sid=1',
  },
  'set-cookie immutable': {
    'cache-control': 'max-age=60, immutable',
    'set-cookie': 'sid=1',
  },
  'cargo cult': {
    'cache-control': 'no-cache, no-store, must-revalidate, pre-check=0, post-check=0',
    expires: httpDate(60),
  },
  // Reuse-restricted in shared caches (maxAge() zeroed on purpose):
  'set-cookie': { 'cache-control': 'max-age=60', 'set-cookie': 'sid=victim' },
  'proxy-revalidate': { 'cache-control': 'max-age=60, proxy-revalidate' },
  private: { 'cache-control': 'private, max-age=60' },
  'set-cookie swr': {
    'cache-control': 'max-age=0, stale-while-revalidate=600',
    'set-cookie': 'sid=victim',
  },
  'set-cookie negative age': {
    'cache-control': 'max-age=60',
    'set-cookie': 'sid=victim',
    age: '-100000',
  },
  // Reuse-restricted everywhere:
  'no-cache': { 'cache-control': 'no-cache, max-age=60' },
  'pragma no-cache': { pragma: 'no-cache' },
  'no-store': { 'cache-control': 'no-store, max-age=60' },
  'vary *': { 'cache-control': 'max-age=60', vary: '*' },
};

const STATUSES = [200, 404, 302, 500];

const NEXT_REQUESTS = {
  same: request(),
  'max-stale': request({ 'cache-control': 'max-stale' }),
  'max-stale=30': request({ 'cache-control': 'max-stale=30' }),
  'max-stale=huge': request({ 'cache-control': 'max-stale=99999999' }),
  'max-age=10': request({ 'cache-control': 'max-age=10' }),
  'min-fresh=30': request({ 'cache-control': 'min-fresh=30' }),
  'no-cache': request({ 'cache-control': 'no-cache' }),
  'pragma no-cache': request({ pragma: 'no-cache' }),
  'accept-encoding gzip': request({ 'accept-encoding': 'gzip' }),
  'accept-encoding br': request({ 'accept-encoding': 'br' }),
  head: request({}, { method: 'HEAD' }),
  'other host': { ...request(), headers: { host: 'other.example' } },
};

const INITIAL_REQUESTS = {
  anonymous: request({ 'accept-encoding': 'gzip' }),
  authorized: request({ 'accept-encoding': 'gzip', authorization: 'Bearer t' }),
};

const OPTIONS = {
  shared: undefined,
  private: { shared: false },
  'ignore cargo cult': { ignoreCargoCult: true },
};

const AGES = [0, 30, 90, 700];

/** Cartesian product of the given axes, as arrays of [name, value]. */
function product(axes) {
  return axes.reduce(
    (combos, axis) => combos.flatMap((combo) => axis.map((entry) => [...combo, entry])),
    [[]],
  );
}

function* scenarios() {
  const axes = [
    Object.entries(RESPONSES),
    STATUSES.map((status) => [String(status), status]),
    Object.entries(INITIAL_REQUESTS),
    Object.entries(OPTIONS),
    AGES.map((age) => [`age ${age}`, age]),
    Object.entries(NEXT_REQUESTS),
  ];
  for (const combo of product(axes)) {
    const [[, headers], [, status], [, req], [, options], [, age], [, next]] = combo;
    yield {
      label: combo.map(([name]) => name).join('/'),
      req,
      res: response(headers, status),
      options,
      age,
      next,
    };
  }
}

describe('http-cache-semantics 4.2.1-nexus.1 security build', () => {
  let upstreamDir;
  let Upstream;
  let Patched;

  beforeAll(() => {
    const source = upstreamIndexSource();
    const indexEntry = provenance.files.find((file) => file.originalPath === 'index.js');
    expect(sha256(source)).toBe(indexEntry.originalSha256);
    upstreamDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-http-cache-semantics-4.2.0-'),
    );
    fs.writeFileSync(path.join(upstreamDir, 'index.js'), source);
    Upstream = require(path.join(upstreamDir, 'index.js'));
    Patched = require(path.join(compatRoot, 'index.js'));
  });

  afterAll(() => {
    if (upstreamDir) fs.rmSync(upstreamDir, { recursive: true, force: true });
  });

  it('keeps the copied files byte-for-byte and the patched file pinned', () => {
    expect(provenance.npmPackage).toBe('http-cache-semantics@4.2.0');
    expect(provenance.nexusVersion).toBe('4.2.1-nexus.1');
    for (const file of provenance.files) {
      const actual = sha256(fs.readFileSync(path.join(root, file.nexusPath)));
      if (file.type === 'patched') {
        expect(file.originalPath).toBe('index.js');
        expect(actual, file.nexusPath).toBe(file.nexusSha256);
        expect(actual, file.nexusPath).not.toBe(file.originalSha256);
        expect(file.changeSummary).toContain('GHSA-ch52-4w7c-c8xp');
        expect(file.changeSummary).toContain('GHSA-f27v-pv5m-c5g6');
      } else {
        expect(file.type, file.nexusPath).toBe('copied');
        expect(actual, file.nexusPath).toBe(file.originalSha256);
      }
    }
    expect(
      fs.readFileSync(path.join(root, provenance.licenseFile), 'utf8'),
    ).toBe(fs.readFileSync(path.join(compatRoot, 'LICENSE'), 'utf8'));
  });

  it('keeps every provenance payload visible to a clean Git checkout', () => {
    for (const nexusPath of [
      ...provenance.files.map((file) => file.nexusPath),
      'third_party/http-cache-semantics-compat/package.json',
      'third_party/http-cache-semantics-compat/NOTICE.md',
      provenance.licenseFile,
    ]) {
      const result = spawnSync(
        'git',
        ['check-ignore', '--no-index', '--quiet', '--', nexusPath],
        { cwd: root, encoding: 'utf8', timeout: 5_000 },
      );
      expect(result.error, nexusPath).toBeUndefined();
      expect(result.status, nexusPath).toBe(1);
    }
  });

  describe('GHSA-ch52-4w7c-c8xp: max-stale cannot reuse prohibited responses', () => {
    const victim = request({ cookie: 'sid=victim' });
    const restricted = {
      'shared Set-Cookie without public': {
        res: response({ 'cache-control': 'max-age=3600', 'set-cookie': 'sid=victim' }),
      },
      'shared Set-Cookie, no Cache-Control': {
        res: response({ 'set-cookie': 'sid=victim', 'last-modified': httpDate(-86_400) }),
      },
      'shared proxy-revalidate': {
        res: response({ 'cache-control': 'max-age=3600, proxy-revalidate' }),
      },
      'no-cache': { res: response({ 'cache-control': 'no-cache, max-age=3600' }) },
      'Pragma: no-cache': { res: response({ pragma: 'no-cache' }) },
      'shared private': { res: response({ 'cache-control': 'private, max-age=3600' }) },
      'shared Authorization request': {
        req: request({ authorization: 'Bearer victim' }),
        res: response({ 'cache-control': 'max-age=3600' }),
      },
      'no-store': { res: response({ 'cache-control': 'no-store, max-age=3600' }) },
    };

    for (const [name, scenario] of Object.entries(restricted)) {
      it(`refuses ${name} to a request with a large max-stale`, () => {
        for (const maxStale of ['max-stale', 'max-stale=99999999']) {
          const attacker = request({ 'cache-control': maxStale });
          const input = { req: scenario.req ?? victim, res: scenario.res, age: 10, next: attacker };

          // Positive control: upstream 4.2.0 serves the cached response.
          const before = evaluate(Upstream, input);
          expect(before.policy.maxAge(), name).toBe(0);
          expect(before.satisfies, `${name} upstream`).toBe(true);
          expect(before.hit, `${name} upstream`).toBe(true);

          const after = evaluate(Patched, input);
          expect(after.policy.maxAge(), name).toBe(0);
          expect(after.policy._requiresRevalidation(), name).toBe(true);
          expect(after.satisfies, `${name} patched`).toBe(false);
          expect(after.hit, `${name} patched`).toBe(false);
          expect(after.revalidation?.synchronous, name).toBe(true);
        }
      });
    }

    it('never hands the victim cookie to the attacker', () => {
      const input = {
        req: victim,
        res: response({ 'cache-control': 'max-age=3600', 'set-cookie': 'sid=victim' }),
        age: 10,
        next: request({ 'cache-control': 'max-stale=99999999' }),
      };
      expect(evaluate(Upstream, input).headers?.['set-cookie']).toBe('sid=victim');
      expect(evaluate(Patched, input).headers).toBeNull();
    });

    it('closes the sibling hits of the same entries in evaluateRequest()', () => {
      const swr = {
        res: response({
          'cache-control': 'max-age=0, stale-while-revalidate=600',
          'set-cookie': 'sid=victim',
        }),
        age: 10,
        next: request(),
      };
      expect(evaluate(Upstream, swr)).toMatchObject({ hit: true, satisfies: false });
      expect(evaluate(Patched, swr)).toMatchObject({ hit: false, satisfies: false });

      const negativeAge = {
        res: response({
          'cache-control': 'max-age=3600',
          'set-cookie': 'sid=victim',
          age: '-100000',
        }),
        age: 10,
        next: request(),
      };
      expect(evaluate(Upstream, negativeAge)).toMatchObject({ hit: true, satisfies: true });
      expect(evaluate(Patched, negativeAge)).toMatchObject({ hit: false, satisfies: false });
    });

    it('treats ordinary expiry as reusable stale, exactly like upstream', () => {
      for (const headers of [
        { 'cache-control': 'max-age=0' },
        { 'cache-control': 'max-age=60' },
        { 'cache-control': 'public, max-age=60', 'set-cookie': 'sid=1' },
        { 'cache-control': 'max-age=60, immutable', 'set-cookie': 'sid=1' },
        { expires: httpDate(-3_600) },
      ]) {
        const input = {
          res: response(headers),
          age: 600,
          next: request({ 'cache-control': 'max-stale' }),
        };
        const label = JSON.stringify(headers);
        expect(evaluate(Patched, input).policy._requiresRevalidation(), label).toBe(false);
        expect(evaluate(Patched, input), label).toMatchObject({ hit: true, satisfies: true });
        expect(evaluate(Upstream, input), label).toMatchObject({ hit: true, satisfies: true });
      }
    });

    it('keeps private caches (shared: false) as in upstream', () => {
      for (const headers of [
        { 'cache-control': 'max-age=60', 'set-cookie': 'sid=1' },
        { 'cache-control': 'max-age=60, proxy-revalidate' },
        { 'cache-control': 'private, max-age=60' },
      ]) {
        const input = {
          res: response(headers),
          options: { shared: false },
          age: 600,
          next: request({ 'cache-control': 'max-stale' }),
        };
        const label = JSON.stringify(headers);
        expect(evaluate(Patched, input), label).toMatchObject({ hit: true, satisfies: true });
        expect(evaluate(Upstream, input), label).toMatchObject({ hit: true, satisfies: true });
      }
    });
  });

  describe('GHSA-f27v-pv5m-c5g6: Vary wildcards and inherited field names', () => {
    // Field names are lowercased before lookup, so only the all-lowercase
    // Object.prototype members (`constructor`, `__proto__`) can match through
    // the prototype chain.
    for (const vary of [' *', '* ', '*,', 'accept, *', '* , accept', 'constructor', 'Constructor', '__proto__']) {
      it(`never matches Vary: ${JSON.stringify(vary)}`, () => {
        const input = {
          res: response({ 'cache-control': 'max-age=60', vary }),
          age: 5,
          next: request(),
        };
        // Positive control: upstream 4.2.0 reuses the response.
        expect(evaluate(Upstream, input).satisfies, vary).toBe(true);
        expect(evaluate(Patched, input).satisfies, vary).toBe(false);
      });
    }

    it('still matches and splits ordinary Vary values like upstream', () => {
      const cases = [
        ['Accept-Encoding', { 'accept-encoding': 'gzip' }, { 'accept-encoding': 'gzip' }, true],
        ['Accept-Encoding', { 'accept-encoding': 'gzip' }, { 'accept-encoding': 'br' }, false],
        ['Accept-Encoding', {}, {}, true],
        ['Accept-Encoding', { 'accept-encoding': 'gzip' }, {}, false],
        ['accept-encoding , accept-language', { 'accept-language': 'pt' }, { 'accept-language': 'pt' }, true],
        ['accept-encoding , accept-language', { 'accept-language': 'pt' }, { 'accept-language': 'en' }, false],
        // Lowercased to `tostring`, which neither request carries: a match.
        ['toString', {}, {}, true],
        ['*', {}, {}, false],
      ];
      for (const [vary, first, second, expected] of cases) {
        const input = {
          req: request(first),
          res: response({ 'cache-control': 'max-age=60', vary }),
          age: 5,
          next: request(second),
        };
        const label = `${vary} ${JSON.stringify(first)} -> ${JSON.stringify(second)}`;
        expect(evaluate(Upstream, input).satisfies, label).toBe(expected);
        expect(evaluate(Patched, input).satisfies, label).toBe(expected);
      }
    });
  });

  it('matches upstream 4.2.0 on every observable outside the two fixes', () => {
    let total = 0;
    let restrictedHitsClosed = 0;
    for (const scenario of scenarios()) {
      total += 1;
      const before = observe(Upstream, scenario);
      const after = observe(Patched, scenario);
      const probe = evaluate(Patched, scenario).policy;
      const restricted = probe._requiresRevalidation();

      if (restricted) {
        // Only ever narrowed: maxAge() was already zero and the patched reuse
        // decision can only be a miss.
        expect(before.maxAge, scenario.label).toBe(0);
        expect(after.reuse.hit, scenario.label).toBe(false);
        expect(after.reuse.satisfies, scenario.label).toBe(false);
        expect(after.reuse.revalidation?.synchronous, scenario.label).toBe(true);
        if (before.reuse.hit) restrictedHitsClosed += 1;
        const { reuse: _beforeReuse, ...beforeRest } = before;
        const { reuse: _afterReuse, ...afterRest } = after;
        expect(afterRest, scenario.label).toEqual(beforeRest);
      } else {
        expect(after, scenario.label).toEqual(before);
      }
    }
    expect(total).toBe(
      Object.keys(RESPONSES).length *
        STATUSES.length *
        Object.keys(INITIAL_REQUESTS).length *
        Object.keys(OPTIONS).length *
        AGES.length *
        Object.keys(NEXT_REQUESTS).length,
    );
    // The corpus really exercises the vulnerable paths it closes.
    expect(restrictedHitsClosed).toBeGreaterThan(100);
  });

  it('keeps fresh/stale/must-revalidate/public max-stale decisions unchanged', () => {
    const table = [
      ['fresh hit', { 'cache-control': 'max-age=60' }, 30, request(), true],
      ['stale miss', { 'cache-control': 'max-age=60' }, 90, request(), false],
      ['must-revalidate fresh', { 'cache-control': 'max-age=60, must-revalidate' }, 30, request(), false],
      ['must-revalidate + max-stale', { 'cache-control': 'max-age=60, must-revalidate' }, 90, request({ 'cache-control': 'max-stale' }), false],
      ['public + max-stale', { 'cache-control': 'public, max-age=60' }, 90, request({ 'cache-control': 'max-stale' }), true],
      ['public + max-stale=60 within', { 'cache-control': 'public, max-age=60' }, 90, request({ 'cache-control': 'max-stale=60' }), true],
      ['public + max-stale=10 exceeded', { 'cache-control': 'public, max-age=60' }, 90, request({ 'cache-control': 'max-stale=10' }), false],
      ['request no-cache', { 'cache-control': 'max-age=60' }, 30, request({ 'cache-control': 'no-cache' }), false],
      ['request max-age exceeded', { 'cache-control': 'max-age=60' }, 30, request({ 'cache-control': 'max-age=10' }), false],
    ];
    for (const [name, headers, age, next, expected] of table) {
      const input = { res: response(headers), age, next };
      expect(evaluate(Upstream, input).satisfies, name).toBe(expected);
      expect(evaluate(Patched, input).satisfies, name).toBe(expected);
    }

    const swr = {
      res: response({ 'cache-control': 'max-age=60, stale-while-revalidate=120' }),
      age: 90,
      next: request(),
    };
    for (const CachePolicy of [Upstream, Patched]) {
      const result = evaluate(CachePolicy, swr);
      expect(result.hit).toBe(true);
      expect(result.revalidation?.synchronous).toBe(false);
    }
  });

  it('is the http-cache-semantics that got and make-fetch-happen load', () => {
    const compatEntrypoint = fs.realpathSync(path.join(compatRoot, 'index.js'));
    for (const consumer of ['cacheable-request', 'make-fetch-happen']) {
      const consumerRoot = path.dirname(require.resolve(`${consumer}/package.json`));
      expect(
        fs.realpathSync(
          require.resolve('http-cache-semantics', { paths: [consumerRoot] }),
        ),
        consumer,
      ).toBe(compatEntrypoint);
    }

    // make-fetch-happen (used by @electron/node-gyp) wraps the policy with
    // shared: false and asks needsRevalidation() for every cached entry.
    const MakeFetchPolicy = require(
      path.join(
        path.dirname(require.resolve('make-fetch-happen/package.json')),
        'lib',
        'cache',
        'policy.js',
      ),
    );
    const headers = (entries) => new Map(Object.entries(entries));
    const fetchRequest = (entries = {}) => ({
      method: 'GET',
      url: 'https://cache.example/artifact',
      compress: true,
      headers: headers({ host: 'cache.example', ...entries }),
    });
    const policy = new MakeFetchPolicy({
      entry: null,
      request: fetchRequest(),
      response: {
        status: 200,
        headers: headers({ 'cache-control': 'max-age=60', date: new Date().toUTCString() }),
      },
      options: {},
    });
    expect(policy.storable()).toBe(true);
    expect(policy.needsRevalidation(fetchRequest())).toBe(false);
    expect(policy.needsRevalidation(fetchRequest({ 'cache-control': 'no-cache' }))).toBe(true);
  });

  it('keeps the root lock and local override coherent', () => {
    const entries = Object.entries(packageLock.packages).filter(
      ([packagePath]) =>
        packagePath === 'node_modules/http-cache-semantics' ||
        packagePath.endsWith('/node_modules/http-cache-semantics'),
    );

    expect(packageJson.devDependencies['http-cache-semantics']).toBe(
      'file:third_party/http-cache-semantics-compat',
    );
    expect(packageJson.overrides['http-cache-semantics']).toBe(
      '$http-cache-semantics',
    );
    expect(packageLock.packages[''].devDependencies['http-cache-semantics']).toBe(
      packageJson.devDependencies['http-cache-semantics'],
    );
    expect(
      packageLock.packages['third_party/http-cache-semantics-compat'],
    ).toMatchObject({
      name: 'http-cache-semantics',
      version: '4.2.1-nexus.1',
      dev: true,
      license: 'BSD-2-Clause',
    });
    expect(require(path.join(compatRoot, 'package.json'))).toMatchObject({
      name: 'http-cache-semantics',
      version: '4.2.1-nexus.1',
      private: true,
    });
    expect(entries).toEqual([
      [
        'node_modules/http-cache-semantics',
        { resolved: 'third_party/http-cache-semantics-compat', link: true },
      ],
    ]);
  });
});
