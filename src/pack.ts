import { BASELINE_ENTRIES } from './catalog.js';

/** Where the generated pack file lives, relative to the pack package root. */
export const PACK_INTENT_PATH = 'cloudsynth.intent.yml';

/**
 * The baseline pack's YAML, rendered from the catalog.
 *
 * Kept beside the catalog rather than in the pack package so there is exactly
 * one definition of these checks in the repository. The pack package holds the
 * generated result, checked in, because a file that becomes other people's
 * policy should be reviewable in a diff.
 */
export function renderBaselinePack(): string {
  return `# cloudsynth-pack-baseline
#
# GENERATED from the check catalog in the cloudsynth CLI — edit that, not this.
# The pack and \`cloudsynth init\` propose overlapping rules, and maintaining
# them as two lists is how one of them quietly falls behind.
#
# A small set of checks that are defensible on almost any AWS account, meant to
# be extended and argued with rather than adopted silently:
#
#   extends:
#     - cloudsynth-pack-baseline
#
# Every check was run against a real 765-resource CDK app before inclusion, and
# anything that produced a false failure on correct infrastructure was cut
# rather than softened. A baseline that cries wolf gets switched off entirely.
#
# Every positive check sets \`on-empty: pass\`: a pack cannot know whether the
# repo adopting it has any queues, and "No AWS::SQS::Queue in this stack" is not
# a finding. Those report \`subjects: 0\`, so a vacuous pass stays visible rather
# than looking like a real result.
#
# Disagreeing with one of these is normal. Override the id in your own file and
# the rest of the pack stays live, or exempt it with a reason. Both leave a
# record; deleting the pack does not.
version: 1
checks:
${BASELINE_ENTRIES.map((e) => e.yaml).join('\n')}`;
}
