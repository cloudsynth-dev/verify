import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyIntent, VerifyInputError } from './verify.js';
import { buildReport, render } from './report.js';

/**
 * Coverage is the denominator that stops "48 checks green" from being
 * decorative. The canonical case it exists for: a check described as "every
 * Lambda writes to a log group with explicit retention" that selects
 * AWS::Logs::LogGroup examines the log groups that exist, says nothing about
 * the functions without one, and passes.
 */
let dir: string;

const TEMPLATE = {
  Resources: {
    Uploads: { Type: 'AWS::S3::Bucket', Properties: { BucketEncryption: { on: true } } },
    Assets: { Type: 'AWS::S3::Bucket', Properties: { BucketEncryption: { on: true } } },
    Groups: { Type: 'AWS::Logs::LogGroup', Properties: { RetentionInDays: 30 } },
    Api: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'nodejs22.x' } },
    Worker: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'nodejs22.x' } },
  },
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudsynth-cov-'));
  mkdirSync(join(dir, 'cdk.out'));
  writeFileSync(join(dir, 'cdk.out', 'App.template.json'), JSON.stringify(TEMPLATE));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function intent(body: string): string {
  const p = join(dir, `c${seq++}.intent.yml`);
  writeFileSync(p, body);
  return p;
}

const run = (intentPath: string) =>
  verifyIntent({ intentPath, templatePath: join(dir, 'cdk.out'), now: new Date('2026-08-30') });

/** The exact shape of the problem: a check ABOUT log groups, described as if
 *  it were about functions. */
const LOG_RETENTION = `  - id: log-retention
    description: Every Lambda writes to a log group with explicit retention
    select: AWS::Logs::LogGroup
    assert:
      RetentionInDays: present
`;

describe('coverage accounting is always on', () => {
  it('counts total and examined per resource type', () => {
    const c = run(intent(`version: 1\nchecks:\n${LOG_RETENTION}`)).coverage;
    expect(c.totalResources).toBe(5);
    expect(c.examinedResources).toBe(1);
    expect(c.byType).toEqual({
      'AWS::S3::Bucket': { total: 2, examined: 0 },
      'AWS::Logs::LogGroup': { total: 1, examined: 1 },
      'AWS::Lambda::Function': { total: 2, examined: 0 },
    });
  });

  it('shows the summary line in text output', () => {
    const p = intent(`version: 1\nchecks:\n${LOG_RETENTION}`);
    const text = render(buildReport(run(p), { intentPath: p, toolVersion: '0' }), 'text');
    expect(text).toContain('coverage: 1/5 resources examined across 3 type(s)');
  });

  /** Restating a check must not buy coverage. */
  it('unions across checks rather than summing them', () => {
    const c = run(
      intent(`version: 1
checks:
  - id: a
    description: Buckets encrypt
    select: AWS::S3::Bucket
    assert: { BucketEncryption: present }
  - id: b
    description: Buckets still encrypt
    select: AWS::S3::Bucket
    assert: { BucketEncryption: present }
`),
    ).coverage;
    expect(c.byType['AWS::S3::Bucket']).toEqual({ total: 2, examined: 2 });
  });

  /**
   * An exempted resource counts as EXAMINED. It was consciously considered and
   * deliberately carved out with a reason, which is the opposite of nobody
   * having looked — and a coverage number that punished a documented exemption
   * would push people toward deleting the check instead.
   */
  it('counts an exempted resource as examined', () => {
    const c = run(
      intent(`version: 1
checks:
  - id: buckets-encrypted
    description: Buckets encrypt
    select: AWS::S3::Bucket
    exempt:
      - match: "Uploads"
        reason: "public by design"
    assert: { BucketEncryption: present }
`),
    ).coverage;
    expect(c.byType['AWS::S3::Bucket']).toEqual({ total: 2, examined: 2 });
  });
});

describe('coverage.require turns a gap into a failure', () => {
  const withRequire = (types: string) =>
    intent(`version: 1
coverage:
  require:
${types}
checks:
${LOG_RETENTION}`);

  /** The reference's canonical example, now executable. */
  it('fails when a required type has unexamined resources, and NAMES them', () => {
    const r = run(withRequire('    - AWS::Lambda::Function'));
    expect(r.passed).toBe(false);
    expect(r.coverage.violations).toEqual([
      { type: 'AWS::Lambda::Function', logicalIds: ['Api', 'Worker'] },
    ]);
    // Every check passed; the run still fails, because the file asked for more.
    expect(r.errorCount).toBe(0);
  });

  it('names the untouched resources in the text output', () => {
    const p = withRequire('    - AWS::Lambda::Function');
    const text = render(buildReport(run(p), { intentPath: p, toolVersion: '0' }), 'text');
    expect(text).toContain('AWS::Lambda::Function requires every resource be examined');
    expect(text).toContain('Api, Worker');
  });

  it('annotates the violation on GitHub', () => {
    const p = withRequire('    - AWS::Lambda::Function');
    const gh = render(buildReport(run(p), { intentPath: p, toolVersion: '0' }), 'github', {
      intentPath: p,
      stale: [],
      expired: [],
    });
    expect(gh).toContain('::error ');
    expect(gh).toContain('cloudsynth: coverage');
  });

  it('passes when every resource of the required type is examined', () => {
    const r = run(withRequire('    - AWS::Logs::LogGroup'));
    expect(r.coverage.violations).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('echoes the requirement into the report', () => {
    expect(run(withRequire('    - AWS::Lambda::Function')).coverage.required).toEqual([
      'AWS::Lambda::Function',
    ]);
  });

  it('requires nothing unless the file says so', () => {
    const c = run(intent(`version: 1\nchecks:\n${LOG_RETENTION}`)).coverage;
    expect(c.required).toEqual([]);
    expect(c.violations).toEqual([]);
  });

  it('rejects an empty requirement rather than silently doing nothing', () => {
    expect(() => run(intent(`version: 1\ncoverage:\n  require: []\nchecks:\n${LOG_RETENTION}`))).toThrow(
      VerifyInputError,
    );
  });

  it('rejects something that is not a resource type', () => {
    expect(() =>
      run(intent(`version: 1\ncoverage:\n  require:\n    - lambdas\nchecks:\n${LOG_RETENTION}`)),
    ).toThrow(VerifyInputError);
  });
});
