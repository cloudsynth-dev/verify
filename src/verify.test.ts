import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyIntent, collectTemplates, VerifyInputError } from './verify.js';
import { buildReport, render, type ReportFormat } from './report.js';

/**
 * The multi-stack semantics are the whole risk surface here.
 *
 * A real CDK app synthesizes many templates, and most of them contain none of
 * the resource any given check is about. Combine that wrongly and the tool
 * reports confidently wrong answers — which for a correctness product is worse
 * than not shipping it.
 */
let dir: string;

const TABLE = {
  Resources: {
    Table: {
      Type: 'AWS::DynamoDB::Table',
      Properties: { BillingMode: 'PAY_PER_REQUEST', SSESpecification: { SSEEnabled: true } },
    },
  },
};
const LAMBDA = {
  Resources: { Fn: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'nodejs22.x' } } },
};
const EMPTY = { Resources: {} };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudsynth-cli-'));
  mkdirSync(join(dir, 'cdk.out'));
  writeFileSync(join(dir, 'cdk.out', 'DbStack.template.json'), JSON.stringify(TABLE));
  writeFileSync(join(dir, 'cdk.out', 'AppStack.template.json'), JSON.stringify(LAMBDA));
  writeFileSync(join(dir, 'cdk.out', 'NetStack.template.json'), JSON.stringify(EMPTY));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function intent(body: string): string {
  const p = join(dir, `${Math.abs(hash(body))}.intent.yml`);
  writeFileSync(p, body);
  return p;
}
function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}
const out = (intentPath: string) =>
  verifyIntent({ intentPath, templatePath: join(dir, 'cdk.out') });

/** Renderers take a Report and nothing else, so a test renders through the
 *  same projection the binary does. The version is pinned so these assertions
 *  do not move when the package version does. */
const shown = (intentPath: string, format: ReportFormat) =>
  render(buildReport(out(intentPath), { intentPath, toolVersion: '0.0.0-test' }), format);

describe('existential checks across a multi-stack app', () => {
  // The table lives in ONE stack. Requiring every stack to have it would fail
  // every real app on its first run.
  it('passes when the resource is satisfied in any one template', () => {
    const r = out(
      intent(`version: 1
checks:
  - id: table-encrypted
    description: Table encrypts at rest
    select: AWS::DynamoDB::Table
    assert:
      SSESpecification.SSEEnabled: true
`),
    );
    expect(r.passed).toBe(true);
    expect(r.outcomes[0]!.templateName).toBe('DbStack');
  });

  // "No AWS::DynamoDB::Table in this stack" is true of two of the three stacks
  // and is never why the check failed.
  it('reports the property mismatch, not another stack’s absence', () => {
    const r = out(
      intent(`version: 1
checks:
  - id: provisioned-billing
    description: Table uses provisioned billing
    select: AWS::DynamoDB::Table
    assert:
      BillingMode: PROVISIONED
`),
    );
    expect(r.passed).toBe(false);
    expect(r.outcomes[0]!.reason).toContain('DbStack');
    expect(r.outcomes[0]!.reason).toContain('PAY_PER_REQUEST');
    expect(r.outcomes[0]!.reason).not.toContain('No AWS::DynamoDB::Table');
  });
});

describe('universal checks across a multi-stack app', () => {
  /**
   * The bug this pins, and it shipped in 0.2.0.
   *
   * `every` was combined EXISTENTIALLY — passing as soon as any one template
   * passed. Two stacks, one with an encrypted table and one without, and the
   * compliant stack satisfied "every table is encrypted" while the
   * unencrypted one was never reported. Silent, in the DEFAULT quantifier.
   *
   * The reasoning that produced it conflated two things: "a stack containing
   * none of the resource should not fail the check" (true, and why a
   * universal combination cannot simply require all templates) with "one
   * passing stack is enough" (false).
   */
  it('FAILS when one template holds it and another violates it', () => {
    writeFileSync(
      join(dir, 'cdk.out', 'OtherDbStack.template.json'),
      JSON.stringify({
        Resources: {
          Sloppy: { Type: 'AWS::DynamoDB::Table', Properties: { BillingMode: 'PAY_PER_REQUEST' } },
        },
      }),
    );
    const r = out(
      intent(`version: 1
checks:
  - id: tables-encrypted
    description: Every table encrypts at rest
    select: AWS::DynamoDB::Table
    assert:
      SSESpecification.SSEEnabled: true
`),
    );
    expect(r.passed).toBe(false);
    expect(r.outcomes[0]!.reason).toContain('OtherDbStack');
    rmSync(join(dir, 'cdk.out', 'OtherDbStack.template.json'));
  });

  /** The case the existential rule was reaching for, which must keep working:
   *  a template containing none of the resource abstains rather than failing. */
  it('lets a template with none of the resource abstain', () => {
    const r = out(
      intent(`version: 1
checks:
  - id: tables-encrypted
    description: Every table encrypts at rest
    select: AWS::DynamoDB::Table
    assert:
      SSESpecification.SSEEnabled: true
`),
    );
    // AppStack and NetStack contain no tables; DbStack's is encrypted.
    expect(r.passed).toBe(true);
    expect(r.outcomes[0]!.templateName).toBe('DbStack');
  });

  /** `any` is genuinely existential and must not be tightened by the fix. */
  it('keeps `any` satisfied by a single template', () => {
    writeFileSync(
      join(dir, 'cdk.out', 'OtherDbStack.template.json'),
      JSON.stringify({
        Resources: { Sloppy: { Type: 'AWS::DynamoDB::Table', Properties: {} } },
      }),
    );
    const r = out(
      intent(`version: 1
checks:
  - id: some-table-encrypted
    description: At least one table encrypts at rest
    select: AWS::DynamoDB::Table
    quantifier: any
    assert:
      SSESpecification.SSEEnabled: true
`),
    );
    expect(r.passed).toBe(true);
    rmSync(join(dir, 'cdk.out', 'OtherDbStack.template.json'));
  });
});

describe('prohibitions across a multi-stack app', () => {
  /**
   * The bug this pins. Combined existentially, "no Lambda anywhere" passes on
   * an app full of Lambdas, because DbStack and NetStack each contain none and
   * either one satisfies it alone. A prohibition has to hold everywhere.
   */
  it('FAILS when any single template violates it', () => {
    const r = out(
      intent(`version: 1
checks:
  - id: no-lambdas
    description: This app defines no Lambda functions
    select: AWS::Lambda::Function
    quantifier: none
    assert:
      Runtime: present
`),
    );
    expect(r.passed).toBe(false);
    expect(r.outcomes[0]!.reason).toContain('AppStack');
  });

  it('passes only when every template is clean', () => {
    const r = out(
      intent(`version: 1
checks:
  - id: no-buckets
    description: This app defines no buckets
    select: AWS::S3::Bucket
    quantifier: none
    assert:
      BucketEncryption: present
`),
    );
    expect(r.passed).toBe(true);
    expect(r.outcomes[0]!.templateName).toBe('all');
  });
});

describe('severity', () => {
  it('a failing warning is reported but does not fail the run', () => {
    const r = out(
      intent(`version: 1
checks:
  - id: warn-only
    description: Table uses provisioned billing
    severity: warning
    select: AWS::DynamoDB::Table
    assert:
      BillingMode: PROVISIONED
`),
    );
    expect(r.passed).toBe(true);
    expect(r.warningCount).toBe(1);
    expect(r.errorCount).toBe(0);
  });
});

describe('inputs are refused clearly, never with a stack trace', () => {
  it('missing intent file', () => {
    expect(() => out(join(dir, 'nope.yml'))).toThrow(VerifyInputError);
  });

  it('missing template path', () => {
    expect(() =>
      verifyIntent({ intentPath: intent('version: 1\nchecks: []\n'), templatePath: '/nope' }),
    ).toThrow(VerifyInputError);
  });

  it('an invalid intent file surfaces the schema issue', () => {
    expect(() => out(intent('version: 9\nchecks: []\n'))).toThrow(/version/i);
  });

  it('a directory with no templates says what to do', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cloudsynth-empty-'));
    expect(() => collectTemplates(empty)).toThrow(/cdk synth/);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('github annotations', () => {
  it('emits one workflow command per failure, newlines escaped', () => {
    const p = intent(`version: 1
checks:
  - id: provisioned-billing
    description: Table uses provisioned billing
    hint: "Set billingMode."
    select: AWS::DynamoDB::Table
    assert:
      BillingMode: PROVISIONED
`);
    const text = shown(p, 'github');
    const commands = text.split('\n').filter((l) => l.startsWith('::'));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('::error ');
    expect(commands[0]).toContain('provisioned-billing');
    // A raw newline would truncate the annotation at the first line.
    expect(commands[0]!.includes('\n')).toBe(false);
  });

  it('uses ::warning for a warning-severity check', () => {
    const p = intent(`version: 1
checks:
  - id: warn-only
    description: Table uses provisioned billing
    severity: warning
    select: AWS::DynamoDB::Table
    assert:
      BillingMode: PROVISIONED
`);
    expect(shown(p, 'github')).toContain('::warning ');
  });
});

describe('how much each check actually examined', () => {
  /**
   * The org-layer prerequisite. A passing check proves nothing on its own: one
   * described as "every Lambda has log retention" but selecting
   * AWS::Logs::LogGroup examines the log groups that exist and says nothing
   * about functions without one — and passes. `description` is prose, so
   * nothing in the schema can catch it. Reporting the count is what lets a
   * reader, or an aggregate view, notice.
   */
  it('counts subjects across every template, not just the deciding one', () => {
    const r = out(
      intent(`version: 1
checks:
  - id: tables-encrypted
    description: Tables encrypt at rest
    select: AWS::DynamoDB::Table
    assert:
      SSESpecification.SSEEnabled: true
`),
    );
    // One table, in DbStack; the other two templates contribute none.
    expect(r.outcomes[0]!.subjects).toBe(1);
  });

  it('counts array elements when the check descends with items', () => {
    const r = out(
      intent(`version: 1
checks:
  - id: no-open-ingress
    description: No ingress rule is open to the world
    select:
      - type: AWS::Lambda::Function
        items: Layers
    quantifier: none
    assert:
      Ref: anything
`),
    );
    // AppStack's function has no Layers array, so nothing is examined — and a
    // prohibition over nothing passes. The count is what makes that visible
    // instead of looking like a real result.
    expect(r.outcomes[0]!.passed).toBe(true);
    expect(r.outcomes[0]!.subjects).toBe(0);
  });

  it('surfaces the count on a passing line, where it is otherwise invisible', () => {
    const p = intent(`version: 1
checks:
  - id: tables-encrypted
    description: Tables encrypt at rest
    select: AWS::DynamoDB::Table
    assert:
      SSESpecification.SSEEnabled: true
`);
    expect(shown(p, 'text')).toContain('(1 resource)');
  });

  it('includes the count in the json report an aggregate would consume', () => {
    const p = intent(`version: 1
checks:
  - id: tables-encrypted
    description: Tables encrypt at rest
    select: AWS::DynamoDB::Table
    assert:
      SSESpecification.SSEEnabled: true
`);
    expect(JSON.parse(shown(p, 'json')).checks[0].subjects).toBe(1);
  });
});
