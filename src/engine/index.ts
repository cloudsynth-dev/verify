export { parseIntentFile, parseIntentDocument, IntentFileError } from './parse.js';
export { explainIssues, duplicateCheckIds, nearestField } from './diagnose.js';
export {
  evaluateCheck,
  selectSubjects,
  selectedResourceIds,
  resolvePath,
  satisfies,
  matchesGlob,
  type CheckEvaluation,
  type CheckFailure,
  type AppliedExemption,
  type EvaluateOptions,
  type Subject,
  type TemplateJson,
} from './evaluate.js';
export type {
  IntentCheck,
  IntentExemption,
  CoverageRequirement,
  IntentFile,
  IntentExpectation,
  IntentPredicate,
  IntentQuantifier,
  IntentSource,
} from '../contract/intent.js';
