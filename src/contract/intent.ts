import { z } from 'zod';

/**
 * `cloudsynth.intent.yml` — v1.
 *
 * This is a CONTRACT, not a playground detail. The same file is meant to sit at
 * a repo root and be read by the future `cloudsynth verify` GitHub Action, so
 * nothing playground-shaped belongs in here: no preset ids, no lesson ids, no
 * UI hints beyond the prose a human reads. A check says what the stack must do;
 * who is running it is not the file's business.
 *
 * It lives in src/contract rather than in the engine because three tiers
 * need the same vocabulary — the engine evaluates checks, the web tier renders
 * and edits them, and a future CLI parses them — and a second definition in any
 * one of those is precisely the drift a versioned contract exists to stop.
 *
 * ── On the operator set ──────────────────────────────────────────────────────
 * The first draft had only scalar-equals / present / absent, applied as a
 * conjunction over every resource of one type. Measured against the twelve
 * shipped presets that expressed 10 of 21 real checks. The other 11 all needed
 * one of the same four things, and every operator below exists because a real
 * check demanded it — none was added speculatively:
 *
 *   not          "no policy statement grants Action *"   (most security intent
 *                is a PROHIBITION; a schema that cannot say "no" cannot express
 *                the majority of what people actually want to assert)
 *   any-of       "KMS key OR SQS-managed SSE"            (two valid ways to be
 *                encrypted; asserting either one alone is simply wrong)
 *   at-least     "password minimum length >= 8"          (thresholds)
 *   quantifier   "at least one queue has a DLQ"          (every / any / none)
 *   select[]     SSH-from-anywhere lives in TWO places   (inline ingress rules
 *   + items      on a security group, and standalone ingress resources)
 *   where        "every non-OPTIONS method needs auth"   (scope by property,
 *                which a logical-id glob cannot do)
 *
 * See explainer/intent-file-migration.md for the per-check derivation.
 */

/** kebab-case, unique within a file. Used as the stable identity of a check
 *  across runs, so renaming one is a real change, not a cosmetic edit. */
const CheckId = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'check id must be kebab-case (a-z, 0-9, single hyphens)');

/** A CloudFormation resource type, e.g. AWS::S3::Bucket. Deliberately validated
 *  by shape only — the engine must not carry a registry of every AWS type, and
 *  a stack may legitimately contain custom or brand-new resource types. */
const ResourceType = z.string().regex(
  // Two segments or more, not exactly three. CloudFormation custom resources
  // are two — `Custom::CDKBucketDeployment` is what a CDK BucketDeployment
  // actually synthesizes to — and third-party modules are four. Requiring
  // three made every custom resource unexpressible, which surfaced the first
  // time this schema was pointed at real lesson content rather than at
  // AWS-native fixtures.
  /^[A-Za-z0-9]+(::[A-Za-z0-9]+)+$/,
  'select must be a CloudFormation resource type, e.g. AWS::S3::Bucket or Custom::MyResource',
);

/** A bare value: matched by deep equality, or — if the property at that path is
 *  an array — by order-independent inclusion. */
const ScalarExpectation = z.union([
  z.literal('present'),
  z.literal('absent'),
  z.boolean(),
  z.number(),
  z.string(),
]);

/** One operator per object, so `{ not: X, at-least: 2 }` is a schema error
 *  rather than a silent precedence question. Combine with a list instead. */
const OperatorExpectation = z.union([
  z.object({ not: ScalarExpectation }).strict(),
  z.object({ 'at-least': z.number() }).strict(),
  z.object({ 'at-most': z.number() }).strict(),
]);

const SingleExpectation = z.union([ScalarExpectation, OperatorExpectation]);

/** A list means every element must hold — the way to say "set, and not OFF":
 *  `MfaConfiguration: [present, { not: OFF }]`. */
export const IntentExpectationSchema = z.union([
  SingleExpectation,
  z.array(SingleExpectation).min(1),
]);

export type IntentExpectation = z.infer<typeof IntentExpectationSchema>;

/** Dot-path -> expectation. ALL entries must hold. */
export const IntentPredicateSchema = z
  .record(z.string().min(1), IntentExpectationSchema)
  .refine((m) => Object.keys(m).length > 0, 'a predicate must contain at least one expectation');

export type IntentPredicate = z.infer<typeof IntentPredicateSchema>;

/**
 * Where the objects being checked come from.
 *
 * `items` descends into an array property and checks its ELEMENTS instead of
 * the resource itself — an inline security-group ingress rule and an IAM policy
 * statement are both real subjects of intent that are not resources of their
 * own. A list of sources unions them, which is what lets one check cover the
 * two places an ingress rule can live.
 */
const SourceSchema = z
  .object({
    type: ResourceType,
    /** Dot-path to an array property. Absent = the resource's own properties. */
    items: z.string().min(1).optional(),
    /** Logical-id glob (`*` only), applied to the RESOURCE, before `items`. */
    match: z
      .string()
      .min(1)
      .optional()
      .describe('Logical-id glob (* only), narrowing the selection by resource name.'),
  })
  .strict();

export type IntentSource = z.infer<typeof SourceSchema>;

const SelectSchema = z.union([ResourceType, z.array(SourceSchema).min(1)]);

/**
 * every — all selected objects must satisfy the predicate (the default)
 * any   — at least one must
 * none  — none may (a prohibition)
 *
 * Empty selection: `every` and `any` FAIL, because silence about missing
 * infrastructure would let an empty stack read as passing intent. `none`
 * PASSES, because a prohibition over nothing is satisfied — reporting "no
 * security group allows SSH from 0.0.0.0/0" as a failure on a stack with no
 * security groups would be simply untrue.
 */
const QuantifierSchema = z.enum(['every', 'any', 'none']);

export type IntentQuantifier = z.infer<typeof QuantifierSchema>;


/**
 * An exemption — a named, reasoned carve-out for ONE resource.
 *
 * The difference between a tool a team adopts and one they delete after the
 * first false positive. The shape matters as much as the existence: this
 * excludes a *resource* from a check, not the check from the run. "This bucket
 * is public by design" is a statement about that bucket; switching the whole
 * rule off to say it discards the protection for every other bucket, which is
 * how one legacy exception quietly becomes an unguarded fleet.
 *
 * Three properties, each closing a way exemptions rot:
 *
 *   reason   REQUIRED. Silence is the failure mode exemptions must not have.
 *            An exemption without one is a deletion with extra steps, and the
 *            field is what lets `git log` answer "why is this off".
 *   until    Optional, and it BITES. Past the date the exemption is ignored
 *            entirely, the resource is judged again, and an unfixed violation
 *            fails the run. Expiry that does not bite is decoration.
 *   match    Exempted resources are still counted and reported — "11
 *            resources, 1 exempted" — so a carve-out shows up in every run
 *            rather than only to someone reading the file.
 *
 * A `match` that matches nothing is warned about, not ignored: a stale
 * exemption naming a resource that no longer exists is a lie the file is
 * telling, and a run that mentions it is the only moment anyone would notice.
 */
const ExemptionSchema = z
  .object({
    /** Logical-id glob, same syntax and semantics as a source's `match`. */
    match: z.string().min(1),
    reason: z.string().trim().min(1, 'an exemption must say why'),
    /** YYYY-MM-DD, inclusive: holds through the end of that day. Compared
     *  lexicographically against the run date in UTC — exact for this format,
     *  and it avoids a timezone question the file never asked. */
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'until must be a YYYY-MM-DD date')
      .refine((d) => {
        const parsed = new Date(`${d}T00:00:00Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
      }, 'until must be a real calendar date')
      .optional(),
  })
  .strict();

export type IntentExemption = z.infer<typeof ExemptionSchema>;

const IntentCheckObject = z
  .object({
    id: CheckId.describe('Stable kebab-case identity for this check. Renaming one is a real change: reports, exemptions and overrides all key off it.'),
    /** A human sentence, shown verbatim in the UI. Written as the thing that
     *  SHOULD be true, so it reads correctly next to both PASS and FAIL. */
    description: z
      .string()
      .min(1)
      .describe('A human sentence, shown verbatim. Write it as the thing that SHOULD be true, so it reads correctly next to both PASS and FAIL.'),
    /**
     * Optional prose shown INSTEAD of a generated diagnostic when the check
     * fails — the "and here is what to do about it" half.
     *
     * Optional on purpose, and the split matters. A file authored in someone's
     * repo for CI will almost never set this, and shouldn't have to: the
     * generated diagnostic ("Uploads...: expected BucketEncryption to be
     * present, found nothing") is exactly what a build log wants. Our own
     * curated presets do set it, because a teaching surface needs "use
     * BlockPublicAccess.BLOCK_ALL", not a dot-path dump.
     *
     * This is metadata, not an expectation operator — it cannot change whether
     * a check passes.
     */
    hint: z
      .string()
      .min(1)
      .optional()
      .describe('Shown instead of the generated diagnostic when the check fails. Write the fix, imperatively: "Set blockPublicAccess: BlockPublicAccess.BLOCK_ALL."'),
    severity: z
      .enum(['error', 'warning'])
      .default('error')
      .describe('error fails the build; warning is reported and does not.'),
    select: SelectSchema.describe('What the check is about: a CloudFormation resource type, or a list of sources to draw subjects from several places at once.'),
    /** Logical-id glob, for the shorthand string form of `select`. */
    match: z.string().min(1).optional(),
    /** Narrows the selection by property before the quantifier applies —
     *  "every method EXCEPT OPTIONS must require authorization". */
    where: IntentPredicateSchema.optional().describe('Narrows the selection by property before the quantifier applies — "every method EXCEPT OPTIONS".'),
    quantifier: QuantifierSchema.default('every').describe('every: all selected subjects must satisfy. any: at least one must. none: a prohibition, none may.'),
    /**
     * What an empty selection means for `every` and `any`. Default `fail`,
     * unchanged from v1's behaviour.
     *
     * Added because distributing a pack made the gap obvious in a way a
     * single-repo file never could. "Every SQS queue is encrypted" is exactly
     * right in a repo that has queues, and a false failure in one that has
     * none — and a pack cannot know which it is being adopted into. The first
     * run of cloudsynth-pack-baseline against this repo's own 765 resources
     * failed on precisely that, reporting "No AWS::SQS::Queue in this stack"
     * as a problem.
     *
     * `fail` stays the default because the original reasoning holds for a file
     * you wrote about infrastructure you have: silence about missing
     * infrastructure would let an empty stack read as passing intent. `pass`
     * is for the conditional case — "IF this stack has queues, they must be
     * encrypted" — and it is opt-in and visible in the file rather than
     * inferred from where the check came from, because a rule that means
     * different things depending on which file it lives in would be far worse
     * than the problem it solves.
     *
     * A check that passes this way reports `subjects: 0`, so a vacuous pass is
     * still distinguishable from a real one in the output and in any aggregate.
     */
    'on-empty': z
      .enum(['pass', 'fail'])
      .default('fail')
      .describe('What an empty selection means for every/any. pass makes the check conditional — "IF this stack has queues" — which is what a portable pack needs.'),
    /** Conjunction: every entry must hold. */
    assert: IntentPredicateSchema.optional().describe('Conjunction: every dot-path expectation must hold. Use this or any-of, not both.'),
    /** Disjunction: at least one of these predicates must hold. */
    'any-of': z
      .array(IntentPredicateSchema)
      .min(2)
      .optional()
      .describe('Disjunction: at least one predicate must hold — for a resource with two legitimate shapes, like a queue encrypted by KMS or by SQS-managed SSE.'),
    /** Named carve-outs for individual resources. See ExemptionSchema. */
    exempt: z
      .array(ExemptionSchema)
      .min(1)
      .optional()
      .describe('Named carve-outs for individual resources. Excuses a resource, not the check.'),
  })
  .strict();

export const IntentCheckSchema = IntentCheckObject.refine(
  (c) => (c.assert === undefined) !== (c['any-of'] === undefined),
  'a check needs exactly one of `assert` or `any-of`',
).refine(
  (c) => typeof c.select === 'string' || c.match === undefined,
  '`match` belongs on each source when `select` is a list',
);

export type IntentCheck = z.infer<typeof IntentCheckSchema>;

/**
 * Resource types every resource of which must be examined by some check.
 *
 * What turns "48 checks green" from decorative into meaningful, and a list of
 * TYPES rather than a percentage on purpose. A ratio is gameable and
 * unactionable in the same breath: this repo has 145 AWS::ApiGateway::Method
 * resources, so one check about methods moves any percentage by nineteen
 * points while saying nothing about the other sixty types — and the resulting
 * number tells nobody which resource to go and look at.
 *
 * A required type with unexamined resources fails the run and NAMES the
 * untouched logical ids. The canonical case: a check described as "every
 * Lambda writes to a log group with explicit retention" that selects
 * AWS::Logs::LogGroup examines the 8 groups that exist and says nothing about
 * the other 72 functions — and passes. Listing AWS::Lambda::Function here
 * turns that gap from a footnote into a failure.
 *
 * Declared in the file, never a flag, so it is reviewed in the pull request
 * that changes it.
 */
const CoverageRequirementSchema = z.array(ResourceType).min(1);

export type CoverageRequirement = z.infer<typeof CoverageRequirementSchema>;

const IntentFileObject = z
  .object({
    version: z.literal(1).describe('The intent file format version. Stays 1; the format grows additively.'),
    /**
     * Files this one builds on, nearest-wins.
     *
     * Each entry is either a path (starting `.` or `/`) or a package name,
     * resolved to `node_modules/<name>/cloudsynth.intent.yml`. A pack is
     * therefore just a package containing an intent file — it needs no
     * JavaScript, no entry point, and nothing that could execute.
     *
     * The merge rule is that a check id defined here REPLACES an inherited one
     * of the same id. That is the whole point: a team adopts a baseline and
     * disagrees with one rule, and the alternative to overriding it is forking
     * the pack, which means never getting an update again.
     *
     * Resolution happens in the CLI rather than here, because it needs the
     * filesystem and this schema is also parsed in the browser.
     */
    extends: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Files or packs to build on, nearest-wins. A pack name resolves to node_modules/<name>/cloudsynth.intent.yml.'),
    /** Check ids removed AFTER the merge — how a repo drops an inherited rule
     *  it does not want, without forking the pack that ships it. Applied after
     *  merging so it can name a check from any depth. */
    disable: z
      .array(CheckId)
      .min(1)
      .optional()
      .describe('Check ids removed after the merge — how to drop an inherited rule without forking the pack.'),
    /**
     * Adjust an inherited check without copying it.
     *
     * The narrow fix for a real friction: a team that wants a pack's rule as a
     * warning rather than an error had only two options, and both were bad.
     * Redefining the check locally forfeits every future update to it —
     * defeating the entire point of `extends` — and `disable` throws the rule
     * away rather than demoting it.
     *
     * `severity` is the ONLY overridable field, deliberately. Everything else
     * changes what a check MEANS, and a check that means something different
     * from what the pack published under that id is a different check — for
     * which local redefinition is the honest mechanism and the loss of updates
     * is the honest cost. Severity alone changes what a run DOES about the
     * finding, not what the finding is.
     */
    overrides: z
      .record(CheckId, z.object({ severity: z.enum(['error', 'warning']) }).strict())
      .optional()
      .describe('Adjust an inherited check without copying it. severity is the only overridable field.'),
    /** File-level settings. Policy belongs in the file, never in a CLI flag —
     *  a requirement that lives in the pipeline is invisible to review and
     *  outlives whoever set it. Nearest wins over an inherited one. */
    coverage: z
      .object({ require: CoverageRequirementSchema })
      .strict()
      .optional()
      .describe('Resource types every resource of which must be examined by some check. A gap fails the run, naming the untouched logical ids.'),
    /** Optional only when `extends` supplies them — a file that adopts a pack
     *  wholesale and adds nothing is a legitimate and probably common shape. */
    checks: z
      .array(IntentCheckSchema)
      .default([])
      .describe('The checks this file asserts. Optional only when `extends` supplies them.'),
  })
  .strict();

export const IntentFileSchema = IntentFileObject.refine(
  (f) => new Set(f.checks.map((c) => c.id)).size === f.checks.length,
  'check ids must be unique within a file',
).refine(
  (f) => f.checks.length > 0 || (f.extends?.length ?? 0) > 0,
  'a file must define `checks` or `extends` something that does',
);

/**
 * The valid field names, read back off the schemas rather than retyped.
 *
 * Used to answer "did you mean?" on an unknown field. A hand-kept list would
 * be a second definition of the schema surface, and it would be wrong the
 * first time somebody adds a field without remembering it exists — which is
 * exactly the failure a suggestion feature must not have, since a confidently
 * wrong suggestion is worse than none.
 */
export const INTENT_CHECK_FIELDS = Object.keys(IntentCheckObject.shape);
export const INTENT_FILE_FIELDS = Object.keys(IntentFileObject.shape);

export type IntentFile = z.infer<typeof IntentFileSchema>;

export const INTENT_FILE_NAME = 'cloudsynth.intent.yml';
export const INTENT_FILE_VERSION = 1;
