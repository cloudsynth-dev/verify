# Changelog

## 0.4.0

Pre-adoption hardening. No new product surface — this release is about the
things that decide whether a stranger keeps a tool that blocks their deploys:
what it says when it refuses, whether it runs on their machine, and whether
their editor understands the file.

### Changed — read this one

- **Exit code `2` for usage and input errors.** Previously everything that was
  not a pass returned `1`. `if verify; then` is unaffected; a script branching
  on `$? == 1` to mean "a check failed" would now miss an input error, which is
  the point. Conflating "your stack is wrong" with "I could not read your file"
  is what makes a gating tool untrustworthy.
- **YAML anchors and aliases now work.** They were banned outright
  (`maxAliasCount: 0`); the billion-laughs defense never required a ban, only a
  bound, and it is now 100 with a test proving a nested expansion is still
  refused. Merge keys (`<<: *base`) work too — the specific thing anchors are
  wanted for.

### Added

- **`overrides`** — adjust an inherited check without copying it:

  ```yaml
  overrides:
    buckets-enforce-ssl:
      severity: warning
  ```

  `severity` is the only overridable field. Everything else changes what a
  check MEANS, for which local redefinition is the honest mechanism and losing
  pack updates is the honest cost. Provenance keeps both halves: `source:
  <pack>@<version>` plus `overridden: ['severity']`.
- **A JSON Schema for the intent file**, generated from the same definition the
  parser uses, served at `https://www.cloudsynth.dev/schema/intent-v1.json` and
  shipped in the package at `cloudsynth/schema/intent-v1.json`. `init` writes
  the modeline that turns VS Code into an authoring tool with completion and
  inline docs.
- **Twenty more catalog rules**, 14 → 34: CloudFront, Cognito, Secrets Manager,
  KMS, VPC flow logs, WAF, SNS, ALB, ECS, EFS, ElastiCache, Kinesis, Step
  Functions. Each with a fixture pair where the failing template is the passing
  one with exactly the asserted property broken. 23 are in
  `cloudsynth-pack-baseline@0.2.0`.
- **`--quiet`**, failures and the summary only.
- **A friendly refusal on Node below 20**, rather than a syntax error from a
  language feature in a bundled file.

### Fixed

- **Schema errors are readable.** "`quantifer` is not a field — did you mean
  `quantifier`? (check `x`)" rather than `checks.0: Unrecognized key(s)`. The
  valid-field list is read off the schema so a suggestion cannot go stale, and
  a whole-file refinement is suppressed when a concrete error explains it.
- **Duplicate check ids name both positions.**
- **Invalid expectations list the five allowed forms** instead of dumping every
  union branch that was tried.
- **Four distinct input errors** where there was one: a missing path, an empty
  directory, a directory of non-template JSON, and unreadable JSON each need a
  different next action.
- **`any-of` failures list the alternatives tried** — the hardest failure in
  the tool to act on, because there is no single failing path.
- **`init` and `verify` can no longer disagree.** `init` had its own copy of
  the multi-template combination rule, and it was the pre-0.3.0 existential
  `every` — so it wrote files it called passing that `verify` then failed,
  breaking the one guarantee `init` makes. The rule now exists once.
- **Generated files have pinned line endings.** Git on Windows checked the
  baseline pack out with CRLF while the generator emits LF, failing the
  byte-for-byte drift guard on every Windows runner.
- **Coverage violations cap the named ids at ten** plus a count.

### Verification

- A 45-cell matrix pins multi-template quantifier semantics — every quantifier
  against every resource distribution against every `on-empty` setting, each
  cell with the reason it is that verdict. Two shipped releases had a
  correctness bug in this exact area; a third instance was found in `init`
  during this release.
- Corpus diff against 0.3.0: zero verdict changes.
- 272 CLI tests, 113 engine tests.

## 0.3.0

**Fixes a silent false pass in the default quantifier. Upgrading may turn a
green build red — correctly.** A minor rather than a patch bump for exactly
that reason: nothing about your file changed, but what it means did.

### Fixed

- **`every` was combined existentially across templates.** A check held as soon
  as ANY one template satisfied it, so a compliant stack could mask a violation
  in another. Two stacks, one with an encrypted bucket and one without: "every
  bucket encrypts at rest" reported PASS and never mentioned the unencrypted
  one.

  `every` is now universal over the templates that actually contain the
  resource. A template with none of it abstains — that part was always right,
  and is why the rule cannot simply require all templates — but a template that
  HAS the resource must now hold.

  `any` is unchanged and genuinely existential. `none` was already fixed in
  0.1.0 for the same class of bug; this is that bug in the default quantifier,
  which survived because the reasoning conflated "a stack with none of the
  resource should not fail" (true) with "one passing stack is enough" (false).

  Found by running a two-stack fixture through the published 0.2.0 while
  writing its own capability summary. Against CloudSynth's own 11 stacks the fix
  surfaces 4 genuinely unauthenticated API methods that 0.2.0 reported as
  passing.

- `scripts/corpus-diff.sh` aborted before printing anything, because
  `cloudsynth verify` exits 1 on a failing check and `set -o pipefail` turned
  that into a script failure. It had never run since being turned into a file.

## 0.2.0

The theme is honesty about what a green run means. 0.1.0 could tell you six
checks passed; it could not tell you those six examined 12 of your 765
resources, that one was suppressed and why, or that another came from a rule
you never wrote.

Every valid 0.1.0 intent file evaluates to identical verdicts under 0.2.0 —
proven by `scripts/corpus-diff.sh`, which builds both releases and judges all
16 pre-0.2 intent files against 765 real resources. `version` stays `1`.

### Added

- **`cloudsynth init`** — three commands from cold to gated, no YAML authored.
  It evaluates a catalog of checks against your synthesized templates: rules
  that already hold are written active, so the first `verify` is green by
  construction; rules that don't are written **commented out** with what
  currently violates them, which is your backlog in your own file. `--all`
  emits them active instead. Rules matching nothing are omitted. It never runs
  the CDK.
- **Exemptions.** `exempt` is a list of per-resource carve-outs — a logical-id
  glob, a required `reason`, an optional `until`. One bucket is excused; every
  other bucket is still judged. Exempted resources are counted and reported
  (`11 resources, 1 exempted`). `until` bites: past it the exemption is ignored
  and the unfixed violation fails the run. An exemption matching nothing is
  reported as exempting nothing. Packs cannot ship exemptions.
- **Coverage accounting**, always on: total and examined resources per type.
  `coverage.require` names resource types that must be fully examined, and a
  gap fails the run **naming the untouched logical ids** rather than quoting a
  percentage nobody can act on.
- **`extends`.** Inherit checks from a path or a pack — a package containing a
  `cloudsynth.intent.yml`, resolved through Node resolution, with no code in
  it. Nearest wins, so overriding one rule is a one-check edit, not a fork.
  `disable` drops an inherited id outright. Every check carries `source`:
  `local` or `<pack>@<version>`.
- **ReportV1** (`reportVersion: 1`) — the ingestion format a future server-side
  `--report` will POST unchanged. `text` and `github` render from it, so
  anything a human can see is something a machine can read. Structured
  `failures[]` with `stack`/`logicalId`/`path`/`expected`/`found`, per-check
  `exempted[]` and `source`, coverage by type, timings, and an exit code.
  Additive-only: new optional fields at v1; renames need `reportVersion: 2`.
- **`on-empty: pass`** — makes a positive check conditional, so a pack can say
  "*if* this stack has queues, they must be encrypted" without failing a repo
  that has none. Such a check reports `subjects: 0`.
- **`cloudsynth-pack-baseline`** — twelve checks defensible on almost any AWS
  account, generated from the same catalog `init` uses. Contains no executable
  file.

### Changed

- The npm package no longer ships `action.yml`. A composite action is only
  usable with `action.yml` at a repository root, so it was never usable from
  inside `node_modules`. The Action is distributed as its own repository and
  runs `npx cloudsynth@<pinned>`.
- `--format json` is now ReportV1. Every 0.1.0 field survives in some form;
  `passed` per check became `outcome` (`pass`/`fail`/`warn`), and the prose
  `reason` became structured `failures[]`.

### Fixed

- Nothing user-facing. 0.1.0's evaluation semantics were correct and are
  unchanged; this release adds to them.

## 0.1.0

First release. `cloudsynth verify` against `cloudsynth.intent.yml`, three
output formats, and multi-stack combination semantics that distinguish an
existential check from a prohibition.
