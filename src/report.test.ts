import { describe, expect, it } from 'vitest';
import { ReportSchema } from './contract/report.js';
import type { Report } from './contract/report.js';
import { verifyIntent } from './verify.js';
import { buildReport, render } from './report.js';

/**
 * ReportV1 is a CONTRACT, so this file pins it rather than exercising it.
 *
 * The future server-side `--report` POSTs this exact object, so a change here
 * is a change to somebody's ingestion. The snapshot makes that a deliberate
 * edit with a diff to review rather than a side effect of touching a renderer.
 *
 * Additive-only policy: new OPTIONAL fields may appear at reportVersion 1;
 * renaming, removing, or changing the meaning of one needs reportVersion 2.
 *
 * The fixture is checked in, not written to a temp directory — the report
 * carries real paths, and a temp directory made this snapshot differ on every
 * run. Relative paths are also what a user actually types.
 */
const INTENT = 'src/__fixtures__/contract/cloudsynth.intent.yml';
const TEMPLATES = 'src/__fixtures__/contract/cdk.out';

/** `durationMs` is genuinely variable and `startedAt` is a wall clock, so both
 *  are normalised here and asserted separately below. Pinning a duration would
 *  make this test fail on a slow runner and teach everyone to re-record it. */
function pinned(): Report {
  const raw = report();
  return { ...raw, durationMs: 0 };
}

const report = (): Report =>
  buildReport(
    verifyIntent({
      intentPath: INTENT,
      templatePath: TEMPLATES,
      now: new Date('2026-08-30T12:00:00.000Z'),
    }),
    { intentPath: INTENT, toolVersion: '0.0.0-test' },
  );

describe('the report contract', () => {
  it('is exactly this shape', () => {
    expect(pinned()).toMatchInlineSnapshot(`
      {
        "checks": [
          {
            "description": "Table encrypts at rest",
            "exempted": [],
            "failures": [],
            "id": "table-encrypted",
            "outcome": "pass",
            "severity": "error",
            "source": "local",
            "subjects": 1,
          },
          {
            "description": "Table uses provisioned billing",
            "exempted": [],
            "failures": [
              {
                "expected": "PROVISIONED",
                "found": "PAY_PER_REQUEST",
                "hint": "Pass billingMode: BillingMode.PROVISIONED.",
                "logicalId": "Table",
                "path": "BillingMode",
                "stack": "DbStack",
              },
            ],
            "id": "provisioned-billing",
            "outcome": "fail",
            "severity": "error",
            "source": "local",
            "subjects": 1,
          },
          {
            "description": "Every function pins a runtime",
            "exempted": [],
            "failures": [
              {
                "expected": "python3.12",
                "found": "nodejs22.x",
                "logicalId": "Fn",
                "path": "Runtime",
                "stack": "AppStack",
              },
            ],
            "id": "functions-have-a-runtime",
            "outcome": "warn",
            "severity": "warning",
            "source": "local",
            "subjects": 1,
          },
        ],
        "coverage": {
          "byType": {
            "AWS::DynamoDB::Table": {
              "examined": 1,
              "total": 1,
            },
            "AWS::Lambda::Function": {
              "examined": 1,
              "total": 1,
            },
          },
          "examinedResources": 2,
          "required": [],
          "totalResources": 2,
          "violations": [],
        },
        "durationMs": 0,
        "reportVersion": 1,
        "startedAt": "2026-08-30T12:00:00.000Z",
        "summary": {
          "exitCode": 1,
          "failed": 1,
          "passed": 1,
          "warnings": 1,
        },
        "templates": [
          {
            "path": "AppStack",
            "resourceCount": 1,
          },
          {
            "path": "DbStack",
            "resourceCount": 1,
          },
        ],
        "tool": {
          "name": "cloudsynth",
          "version": "0.0.0-test",
        },
      }
    `);
  });

  it('reports a real duration, even though the snapshot pins it to zero', () => {
    const d = report().durationMs;
    expect(typeof d).toBe('number');
    expect(d).toBeGreaterThanOrEqual(0);
  });

  /** The schema and the builder are written separately; this is the only thing
   *  keeping them describing the same object. */
  it('validates against the published schema', () => {
    const parsed = ReportSchema.safeParse(report());
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it('round-trips through JSON unchanged', () => {
    const r = report();
    expect(ReportSchema.parse(JSON.parse(render(r, 'json')))).toEqual(r);
  });

  it('exit code in the summary matches what the binary would return', () => {
    const r = report();
    expect(r.summary.exitCode).toBe(r.summary.failed > 0 ? 1 : 0);
  });
});

describe('every format is a projection of the same report', () => {
  /**
   * The regression this exists to catch. `--format json` used to build its own
   * object inside the renderer, so a field could be visible in `text` and
   * absent from the machine-readable output with nothing to notice.
   */
  it('shows the same failures in text and github', () => {
    const r = report();
    const text = render(r, 'text');
    const github = render(r, 'github');
    for (const c of r.checks.filter((x) => x.outcome !== 'pass')) {
      expect(text).toContain(c.id);
      expect(github).toContain(c.id);
    }
    // github is text plus annotations, so the human-readable half is identical.
    expect(github.endsWith(text)).toBe(true);
  });

  it('renders structured failures rather than a pre-baked sentence', () => {
    const failure = report().checks.find((c) => c.outcome === 'fail')!.failures[0]!;
    expect(failure.stack).toBe('DbStack');
    expect(failure.logicalId).toBe('Table');
    expect(failure.path).toBe('BillingMode');
    expect(failure.found).toBe('PAY_PER_REQUEST');
  });

  it('reports a warning-severity failure as warn, not fail', () => {
    const r = report();
    expect(r.checks.find((c) => c.severity === 'warning')!.outcome).toBe('warn');
    expect(r.summary.warnings).toBe(1);
    expect(render(r, 'text')).toContain('1 warning(s) — reported, not failing the build.');
  });
});
