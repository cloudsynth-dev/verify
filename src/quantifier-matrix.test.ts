import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyIntent } from './verify.js';

/**
 * The quantifier semantics matrix.
 *
 * Two shipped correctness bugs were the same shape, a year apart in tool-time:
 * `none` combined existentially across templates (0.1.0 — "this app defines no
 * Lambda functions" passed against an app with 58), and `every` combined
 * existentially (0.2.0 — "every bucket is encrypted" passed with an
 * unencrypted bucket in another stack). Both were found by accident, both
 * silently reported green, and both came from reasoning about multi-template
 * combination one case at a time.
 *
 * This file exists to make that impossible a third time by enumerating the
 * class rather than the cases: every quantifier against every resource
 * distribution against every `on-empty` setting, each cell with an expected
 * verdict and the one-line reason it is that verdict. A new combination rule
 * that is wrong anywhere fails here.
 *
 * ── How to read a cell ───────────────────────────────────────────────────────
 * Distributions are described in terms of whether the check's PREDICATE holds
 * for a subject, not whether the check passes. That keeps `none` in the same
 * table as the other two: for a prohibition the predicate matching is the bad
 * outcome, so "predicate holds" flips from good to bad without the fixture
 * having to change shape.
 */
let dir: string;

/** A bucket whose `Tier` property the predicate reads. `standard` makes the
 *  predicate hold; `legacy` makes it not hold. */
const bucket = (tier: string) => ({ Type: 'AWS::S3::Bucket', Properties: { Tier: tier } });
const HOLDS = 'standard';
const BREAKS = 'legacy';

type Distribution =
  | 'single-template'
  | 'split-all-hold'
  | 'split-one-breaks'
  | 'some-templates-empty'
  | 'absent-everywhere';

/** cdk.out contents for each distribution. `Other` resources exist so that a
 *  template is never literally empty — an empty file would be a different
 *  test. */
const TEMPLATES: Record<Distribution, Record<string, unknown>> = {
  'single-template': {
    'A.template.json': { Resources: { B1: bucket(HOLDS), B2: bucket(HOLDS) } },
  },
  'split-all-hold': {
    'A.template.json': { Resources: { B1: bucket(HOLDS) } },
    'B.template.json': { Resources: { B2: bucket(HOLDS) } },
  },
  'split-one-breaks': {
    'A.template.json': { Resources: { B1: bucket(HOLDS) } },
    'B.template.json': { Resources: { B2: bucket(BREAKS) } },
  },
  'some-templates-empty': {
    'A.template.json': { Resources: { B1: bucket(HOLDS) } },
    'B.template.json': { Resources: { V: { Type: 'AWS::EC2::VPC', Properties: {} } } },
  },
  'absent-everywhere': {
    'A.template.json': { Resources: { V: { Type: 'AWS::EC2::VPC', Properties: {} } } },
    'B.template.json': { Resources: { W: { Type: 'AWS::EC2::VPC', Properties: {} } } },
  },
};

type OnEmpty = 'pass' | 'fail' | 'unset';
type Quantifier = 'every' | 'any' | 'none';

interface Cell {
  quantifier: Quantifier;
  distribution: Distribution;
  onEmpty: OnEmpty;
  expect: 'pass' | 'fail';
  /** Why this cell is that verdict. A cell whose reason cannot be written
   *  convincingly is a semantics question, not a line to fill in. */
  because: string;
}

/**
 * The table. 3 quantifiers x 5 distributions x 3 on-empty settings = 45 cells.
 *
 * Note what `on-empty` does and does not touch: it is consulted ONLY when the
 * selection is empty, so it is invariant across the first four distributions
 * by construction. Enumerating those cells anyway is the point — an
 * implementation that let `on-empty` leak into a non-empty selection would
 * fail here rather than in somebody's pipeline.
 */
const MATRIX: Cell[] = [];
for (const onEmpty of ['pass', 'fail', 'unset'] as OnEmpty[]) {
  const empty = onEmpty === 'pass';

  MATRIX.push(
    // ── every ───────────────────────────────────────────────────────────────
    {
      quantifier: 'every', distribution: 'single-template', onEmpty, expect: 'pass',
      because: 'all subjects hold and they are all in the one template there is',
    },
    {
      quantifier: 'every', distribution: 'split-all-hold', onEmpty, expect: 'pass',
      because: 'every subject across the union of templates holds',
    },
    {
      quantifier: 'every', distribution: 'split-one-breaks', onEmpty, expect: 'fail',
      because:
        'a violation ANYWHERE fails `every` — the 0.2.0 bug was passing here because ' +
        'template A satisfied it on its own',
    },
    {
      quantifier: 'every', distribution: 'some-templates-empty', onEmpty, expect: 'pass',
      because:
        'a template containing none of the resource abstains; requiring it to hold there ' +
        'would fail every multi-stack app on its first run',
    },
    {
      quantifier: 'every', distribution: 'absent-everywhere', onEmpty, expect: empty ? 'pass' : 'fail',
      because: empty
        ? '`on-empty: pass` makes the claim conditional — "IF this stack has buckets"'
        : 'silence about missing infrastructure would let an empty stack read as passing intent',
    },

    // ── any ─────────────────────────────────────────────────────────────────
    {
      quantifier: 'any', distribution: 'single-template', onEmpty, expect: 'pass',
      because: 'at least one subject holds',
    },
    {
      quantifier: 'any', distribution: 'split-all-hold', onEmpty, expect: 'pass',
      because: 'at least one subject holds; which template it is in does not matter',
    },
    {
      quantifier: 'any', distribution: 'split-one-breaks', onEmpty, expect: 'pass',
      because:
        'B2 breaking is irrelevant to an existential claim — B1 still holds. This is the ' +
        'cell that shows `any` and `every` are genuinely different, not a naming choice',
    },
    {
      quantifier: 'any', distribution: 'some-templates-empty', onEmpty, expect: 'pass',
      because: 'a template with no subjects cannot satisfy or refute an existential claim',
    },
    {
      quantifier: 'any', distribution: 'absent-everywhere', onEmpty, expect: empty ? 'pass' : 'fail',
      because: empty
        ? '`on-empty: pass` opts out of the "there must be one" half of the claim'
        : '"at least one queue has a DLQ" is false when there are no queues',
    },

    // ── none ────────────────────────────────────────────────────────────────
    // For a prohibition the predicate matching is the FORBIDDEN outcome, so the
    // distributions read inverted: "holds" means the banned thing is present.
    {
      quantifier: 'none', distribution: 'single-template', onEmpty, expect: 'fail',
      because: 'the forbidden shape is present, so the prohibition is violated',
    },
    {
      quantifier: 'none', distribution: 'split-all-hold', onEmpty, expect: 'fail',
      because: 'violated in both templates; a prohibition must hold in every one',
    },
    {
      quantifier: 'none', distribution: 'split-one-breaks', onEmpty, expect: 'fail',
      because:
        'B2 not matching does not excuse B1 matching — the 0.1.0 bug was passing here ' +
        'because most templates in a real app contain none of the resource and each ' +
        'satisfied the prohibition alone',
    },
    {
      quantifier: 'none', distribution: 'some-templates-empty', onEmpty, expect: 'fail',
      because: 'the template that has the resource violates it; the empty one cannot absolve it',
    },
    {
      quantifier: 'none', distribution: 'absent-everywhere', onEmpty, expect: 'pass',
      because:
        'a prohibition over nothing is satisfied — "no security group allows SSH from ' +
        '0.0.0.0/0" is TRUE of a stack with no security groups, and `on-empty` is ' +
        'deliberately not consulted here: reporting that as a failure would be untrue. ' +
        'A file wanting "there must be some, and none may match" writes two checks',
    },
  );
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudsynth-matrix-'));
  for (const [distribution, files] of Object.entries(TEMPLATES)) {
    const out = join(dir, distribution);
    mkdirSync(out, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(out, name), JSON.stringify(body));
    }
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(cell: Cell) {
  const onEmptyLine = cell.onEmpty === 'unset' ? '' : `    on-empty: ${cell.onEmpty}\n`;
  const intentPath = join(dir, `${cell.quantifier}-${cell.distribution}-${cell.onEmpty}.yml`);
  writeFileSync(
    intentPath,
    `version: 1
checks:
  - id: tier-is-standard
    description: Buckets are on the standard tier
    select: AWS::S3::Bucket
    quantifier: ${cell.quantifier}
${onEmptyLine}    assert:
      Tier: ${HOLDS}
`,
  );
  return verifyIntent({ intentPath, templatePath: join(dir, cell.distribution) });
}

describe('quantifier x distribution x on-empty', () => {
  it('enumerates the whole class — 45 cells, none skipped', () => {
    expect(MATRIX).toHaveLength(3 * 5 * 3);
    // Every cell carries a reason. A blank one would mean a verdict nobody
    // could justify, which is the thing this file exists to prevent.
    expect(MATRIX.filter((c) => c.because.trim().length < 20)).toEqual([]);
  });

  for (const cell of MATRIX) {
    const name = `${cell.quantifier} · ${cell.distribution} · on-empty:${cell.onEmpty} -> ${cell.expect}`;
    it(name, () => {
      const report = run(cell);
      expect(report.outcomes[0]!.passed, cell.because).toBe(cell.expect === 'pass');
    });
  }
});

describe('the invariants the matrix encodes', () => {
  /** `on-empty` is consulted only for an empty selection. If it ever leaked
   *  into a non-empty one, these three would disagree. */
  it('on-empty changes nothing when the selection is non-empty', () => {
    for (const distribution of [
      'single-template',
      'split-all-hold',
      'split-one-breaks',
      'some-templates-empty',
    ] as Distribution[]) {
      for (const quantifier of ['every', 'any', 'none'] as Quantifier[]) {
        const verdicts = (['pass', 'fail', 'unset'] as OnEmpty[]).map(
          (onEmpty) => run({ quantifier, distribution, onEmpty, expect: 'pass', because: 'probe' })
            .outcomes[0]!.passed,
        );
        expect(new Set(verdicts).size, `${quantifier}/${distribution}`).toBe(1);
      }
    }
  });

  /** The asymmetry that is easy to get wrong and was got wrong twice: `every`
   *  is universal over templates that have the resource, `any` is existential,
   *  and they diverge on exactly one distribution. */
  it('every and any diverge only where one subject breaks', () => {
    const differing = (['single-template', 'split-all-hold', 'split-one-breaks',
      'some-templates-empty', 'absent-everywhere'] as Distribution[]).filter((distribution) => {
      const e = run({ quantifier: 'every', distribution, onEmpty: 'unset', expect: 'pass', because: 'probe' });
      const a = run({ quantifier: 'any', distribution, onEmpty: 'unset', expect: 'pass', because: 'probe' });
      return e.outcomes[0]!.passed !== a.outcomes[0]!.passed;
    });
    expect(differing).toEqual(['split-one-breaks']);
  });
});
