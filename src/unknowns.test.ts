import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyIntent } from './verify.js';

/**
 * The five things the capability reference listed as "untested, not claimed".
 *
 * They were honest unknowns rather than known gaps, which is a worse state to
 * leave them in: an unknown gets quietly assumed one way or the other the
 * moment anyone plans against it. Each is now pinned to whatever the tool
 * ACTUALLY does — including where that behaviour is a limitation, since a
 * documented limitation is a decision and an undocumented one is a surprise.
 */
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudsynth-unknowns-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function fixture(templates: Record<string, unknown>, intentBody: string) {
  const base = join(dir, `u${seq++}`);
  const out = join(base, 'cdk.out');
  mkdirSync(out, { recursive: true });
  for (const [name, template] of Object.entries(templates)) {
    writeFileSync(join(out, name), JSON.stringify(template));
  }
  const intentPath = join(base, 'cloudsynth.intent.yml');
  writeFileSync(intentPath, intentBody);
  return { intentPath, templatePath: out };
}

const run = (templates: Record<string, unknown>, intentBody: string) =>
  verifyIntent({ ...fixture(templates, intentBody), now: new Date('2026-08-30T12:00:00Z') });

const ENCRYPTED = `version: 1
checks:
  - id: buckets-encrypted
    description: Buckets encrypt at rest
    select: AWS::S3::Bucket
    assert:
      BucketEncryption: present
`;

describe('CloudFormation Conditions', () => {
  /**
   * ANSWER: a conditional resource is judged as though it exists.
   *
   * `Condition` is not read at all — the resource is in `Resources`, so it is
   * selected. That is the conservative reading and almost certainly the one
   * you want (a resource that might be created must still be correct), but it
   * means a check can fail on a resource this deployment will never make.
   *
   * Evaluating conditions properly would mean resolving parameter values the
   * template does not carry, which is CloudFormation's job at deploy time and
   * not something a static reader can do honestly.
   */
  it('judges a conditionally-created resource as if it exists', () => {
    const r = run(
      {
        'App.template.json': {
          Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
          Resources: {
            Uploads: { Type: 'AWS::S3::Bucket', Condition: 'IsProd', Properties: {} },
          },
        },
      },
      ENCRYPTED,
    );
    expect(r.passed).toBe(false);
    expect(r.outcomes[0]!.subjects).toBe(1);
  });

  it('counts it toward coverage too, consistently', () => {
    const r = run(
      {
        'App.template.json': {
          Conditions: { IsProd: {} },
          Resources: {
            Uploads: {
              Type: 'AWS::S3::Bucket',
              Condition: 'IsProd',
              Properties: { BucketEncryption: {} },
            },
          },
        },
      },
      ENCRYPTED,
    );
    expect(r.coverage.byType['AWS::S3::Bucket']).toEqual({ total: 1, examined: 1 });
  });
});

describe('Parameters and pseudo-parameters', () => {
  /**
   * ANSWER: an unresolved intrinsic is a VALUE, not an absence.
   *
   * `present` holds on `{ Ref: ... }`, and an equality check against a literal
   * fails. Both are correct — the tool reads the template it was given and
   * that template genuinely does not say what the region is — but the second
   * is the sharp edge: `assert: { BucketName: my-bucket }` fails on a
   * parameterised name, and the failure message shows the intrinsic, which is
   * at least self-explanatory.
   */
  it('treats an unresolved Ref as present', () => {
    const r = run(
      {
        'App.template.json': {
          Parameters: { KeyArn: { Type: 'String' } },
          Resources: {
            Uploads: { Type: 'AWS::S3::Bucket', Properties: { BucketEncryption: { Ref: 'KeyArn' } } },
          },
        },
      },
      ENCRYPTED,
    );
    expect(r.passed).toBe(true);
  });

  it('cannot equate an intrinsic to a literal, and says what it found', () => {
    const r = run(
      {
        'App.template.json': {
          Resources: {
            Uploads: {
              Type: 'AWS::S3::Bucket',
              Properties: { BucketName: { Ref: 'AWS::StackName' } },
            },
          },
        },
      },
      `version: 1
checks:
  - id: bucket-name
    description: The bucket is named uploads
    select: AWS::S3::Bucket
    assert:
      BucketName: uploads
`,
    );
    expect(r.passed).toBe(false);
    expect(r.outcomes[0]!.reason).toContain('Ref');
  });
});

describe('Nested stacks', () => {
  /**
   * ANSWER: nested templates ARE picked up, because CDK writes them as
   * `<id>.nested.template.json` and the scan matches on the `.template.json`
   * suffix. So a check reaches resources inside a nested stack without anyone
   * having done anything about it.
   *
   * The parent's AWS::CloudFormation::Stack resource is also read as an
   * ordinary resource, which is why it shows up in coverage as a type nothing
   * checks rather than being followed as a pointer.
   */
  it('reads resources inside a nested stack template', () => {
    const r = run(
      {
        'Parent.template.json': {
          Resources: {
            Child: {
              Type: 'AWS::CloudFormation::Stack',
              Properties: { TemplateURL: 'https://s3/child.json' },
            },
          },
        },
        'ParentChild123.nested.template.json': {
          Resources: { Uploads: { Type: 'AWS::S3::Bucket', Properties: {} } },
        },
      },
      ENCRYPTED,
    );
    expect(r.templatesChecked).toContain('ParentChild123.nested');
    // The bucket is only in the nested file, and it is judged.
    expect(r.passed).toBe(false);
    expect(r.outcomes[0]!.subjects).toBe(1);
  });

  /** The brief's specific worry: a nested template is a separate file AND is
   *  referenced from the parent, so it could plausibly be read twice. */
  it('does not double-count resources in a nested template', () => {
    const r = run(
      {
        'Parent.template.json': {
          Resources: {
            Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
          },
        },
        'ParentChild123.nested.template.json': {
          Resources: { Uploads: { Type: 'AWS::S3::Bucket', Properties: { BucketEncryption: {} } } },
        },
      },
      ENCRYPTED,
    );
    expect(r.outcomes[0]!.subjects).toBe(1);
    expect(r.coverage.byType['AWS::S3::Bucket']).toEqual({ total: 1, examined: 1 });
  });

  it('treats the parent Stack resource as a resource, not a pointer to follow', () => {
    const r = run(
      {
        'Parent.template.json': {
          Resources: {
            Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
          },
        },
      },
      ENCRYPTED,
    );
    expect(r.coverage.byType).toEqual({ 'AWS::CloudFormation::Stack': { total: 1, examined: 0 } });
  });
});

describe('Templates that did not come from the CDK', () => {
  /**
   * ANSWER: they work. Nothing in the reader is CDK-specific — it is
   * CloudFormation JSON in, judgement out — and SAM's own resource types
   * satisfy the type regex because it requires two-or-more segments rather
   * than exactly three.
   */
  it('judges a hand-written SAM template', () => {
    const r = run(
      {
        'sam.template.json': {
          Transform: 'AWS::Serverless-2016-10-31',
          Resources: {
            Api: {
              Type: 'AWS::Serverless::Function',
              Properties: { Runtime: 'python3.12', Tracing: 'Active' },
            },
          },
        },
      },
      `version: 1
checks:
  - id: functions-trace
    description: Serverless functions have tracing on
    select: AWS::Serverless::Function
    assert:
      Tracing: Active
`,
    );
    expect(r.passed).toBe(true);
    expect(r.outcomes[0]!.subjects).toBe(1);
  });
});

describe('Hand-written CloudFormation', () => {
  /** Nothing in the reader is CDK-specific. Proving it on a template no tool
   *  generated is what makes "works with any CloudFormation, CDK not required"
   *  a claimable sentence rather than an assumption. */
  it('judges a template nobody generated', () => {
    const r = run(
      {
        'handwritten.template.json': {
          AWSTemplateFormatVersion: '2010-09-09',
          Description: 'Written by a person in an editor',
          Resources: {
            MyBucket: {
              Type: 'AWS::S3::Bucket',
              Properties: { BucketName: 'my-bucket', BucketEncryption: { on: true } },
            },
          },
        },
      },
      ENCRYPTED,
    );
    expect(r.passed).toBe(true);
    expect(r.outcomes[0]!.subjects).toBe(1);
  });
});

describe('Very large apps', () => {
  /**
   * ANSWER: linear and fast. 10,000 resources across 50 templates — the shape
   * that matters, since every check rescans every template — measured through
   * the built bundle below the 2s budget with an order of magnitude to spare.
   *
   * Worth pinning rather than assuming: selection is a scan per check per
   * template, so the cost is checks x resources. A bound here is what makes it
   * safe to tell somebody to run this on a monorepo-scale app, and it is the
   * kind of claim that quietly stops being true when a future operator does
   * something quadratic.
   */
  it('handles 50 templates and 10,000 resources inside the budget', () => {
    const templates: Record<string, unknown> = {};
    for (let t = 0; t < 50; t++) {
      const Resources: Record<string, unknown> = {};
      for (let i = 0; i < 200; i++) {
        Resources[`Bucket${i}`] = {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketEncryption: { on: true } },
        };
      }
      templates[`Big${t}.template.json`] = { Resources };
    }
    const started = Date.now();
    const r = run(templates, ENCRYPTED);
    const elapsed = Date.now() - started;

    expect(r.passed).toBe(true);
    expect(r.outcomes[0]!.subjects).toBe(10_000);
    expect(r.coverage.totalResources).toBe(10_000);
    // 2s, per the brief. Measured at ~0.2s locally including JSON parsing, so
    // this catches an order-of-magnitude regression without failing on a
    // loaded CI runner.
    expect(elapsed).toBeLessThan(2_000);
  });
});
