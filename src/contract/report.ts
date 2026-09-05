import { z } from 'zod';

/**
 * `cloudsynth verify` — ReportV1.
 *
 * The org layer's ingestion format, defined now so the future server-side
 * `--report` POSTs this exact object with zero migration. That is the whole
 * reason it is frozen this early: the transport can change later, the shape
 * cannot without a version bump.
 *
 * `text` and `github` are rendered FROM this object. One evaluation result,
 * three presentations — so a field a human can see is necessarily a field a
 * machine can read, rather than that being true only while someone remembers
 * to keep two code paths in step.
 *
 * ── Additive-only policy ─────────────────────────────────────────────────────
 * New OPTIONAL fields may be added at `reportVersion: 1`. Renaming or removing
 * a field, or changing the meaning or type of one, requires
 * `reportVersion: 2`. A consumer may therefore rely on every field below
 * continuing to exist and mean this. The snapshot test in packages/cli pins the
 * full output of a fixture run, so a breaking change cannot happen quietly.
 */

export const REPORT_VERSION = 1;

/** What a check did. `warn` is a failing check at warning severity — reported,
 *  never build-failing — kept distinct from `fail` so an aggregate can count
 *  the two apart without re-deriving it from `severity`. */
export const CheckOutcomeSchema = z.enum(['pass', 'fail', 'warn']);
export type CheckOutcomeValue = z.infer<typeof CheckOutcomeSchema>;

/** One resource a check deliberately did not judge, and why. */
export const ReportExemptionSchema = z
  .object({
    logicalId: z.string().min(1),
    reason: z.string().min(1),
    until: z.string().optional(),
  })
  .strict();

export type ReportExemption = z.infer<typeof ReportExemptionSchema>;

/**
 * One concrete violation.
 *
 * Structured rather than a prose sentence because this is the field an org
 * dashboard groups by: "which stacks fail this check, on which resource, on
 * which property". A rendered string forces every consumer to parse English
 * back into those columns, and they will each do it differently.
 */
export const ReportFailureSchema = z
  .object({
    stack: z.string().min(1),
    logicalId: z.string().min(1),
    /** Dot-path to the property that did not hold, when there is one. */
    path: z.string().optional(),
    expected: z.unknown().optional(),
    found: z.unknown().optional(),
    hint: z.string().optional(),
    /** For an `any-of` check: the allowed shapes that were tried and none of
     *  which matched. Absent for every other kind of failure, which has a
     *  single `path` instead. Additive at reportVersion 1. */
    alternatives: z.array(z.string()).optional(),
  })
  .strict();

export type ReportFailure = z.infer<typeof ReportFailureSchema>;

export const ReportCheckSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    severity: z.enum(['error', 'warning']),
    outcome: CheckOutcomeSchema,
    /**
     * How many resources or array elements this check actually examined.
     *
     * The number a pass/fail record throws away, and the reason coverage
     * accounting exists at all: a green check that examined nothing looks
     * identical to one that examined 145 resources, and only one is evidence.
     */
    subjects: z.number().int().nonnegative(),
    /** Resources excluded from the quantifier by an exemption. Counted as
     *  examined for coverage — they were consciously considered. */
    exempted: z.array(ReportExemptionSchema),
    /** `local`, or `<pack>@<version>` — the audit trail for an inherited rule. */
    source: z.string().min(1),
    /** Fields the consuming file adjusted on an inherited check. A rule can be
     *  attributed to the pack that wrote it AND to the repo that demoted it,
     *  which is what keeps the audit trail honest. Additive at v1. */
    overridden: z.array(z.enum(['severity'])).optional(),
    failures: z.array(ReportFailureSchema),
  })
  .strict();

export type ReportCheck = z.infer<typeof ReportCheckSchema>;

/**
 * How much of the stack any check looks at.
 *
 * Always computed, never opt-in. "48 checks green" is decorative without a
 * denominator: measured against this repo, six passing checks examined 12 of
 * 765 resources, and nothing in a pass/fail summary hints at that.
 */
export const CoverageSchema = z
  .object({
    totalResources: z.number().int().nonnegative(),
    examinedResources: z.number().int().nonnegative(),
    byType: z.record(
      z.string(),
      z.object({ total: z.number().int().nonnegative(), examined: z.number().int().nonnegative() }).strict(),
    ),
    /** Resource types the file declared under `coverage.require`. */
    required: z.array(z.string()),
    /** A required type with resources nothing examined, named individually so
     *  the failure is actionable rather than a percentage to argue with. */
    violations: z.array(
      z.object({ type: z.string().min(1), logicalIds: z.array(z.string().min(1)) }).strict(),
    ),
  })
  .strict();

export type Coverage = z.infer<typeof CoverageSchema>;

export const ReportSchema = z
  .object({
    reportVersion: z.literal(REPORT_VERSION),
    tool: z.object({ name: z.literal('cloudsynth'), version: z.string().min(1) }).strict(),
    startedAt: z.string().min(1),
    durationMs: z.number().nonnegative(),
    templates: z.array(
      z.object({ path: z.string().min(1), resourceCount: z.number().int().nonnegative() }).strict(),
    ),
    checks: z.array(ReportCheckSchema),
    coverage: CoverageSchema,
    summary: z
      .object({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
        exitCode: z.union([z.literal(0), z.literal(1)]),
      })
      .strict(),
  })
  .strict();

export type Report = z.infer<typeof ReportSchema>;
