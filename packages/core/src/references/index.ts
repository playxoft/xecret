export {
  escapeTemplateText,
  formatReference,
  MAX_INHERITANCE_DEPTH,
  MAX_REFERENCE_DEPTH,
  MAX_REFERENCES_PER_SECRET,
  parseTemplate,
  referenceKey,
  sameReferenceSet,
  templateReferences,
  TemplateSyntaxError,
} from './template';
export type { SecretReference, TemplateSegment } from './template';

export {
  checkEnvironment,
  environmentView,
  inheritanceChain,
  lookupInView,
  resolveEnvironment,
  ResolutionError,
  walkReferences,
} from './resolve';
export type {
  DeclaredReference,
  GraphEnvironment,
  GraphSecret,
  ReferenceGraph,
  ReferenceTarget,
  ResolutionErrorKind,
  ValuedSecret,
  VisitedSecret,
} from './resolve';

export {
  affectedContexts,
  checkContexts,
  contextsReferencing,
  descendantsOf,
  planResolution,
  withParent,
  withSecret,
} from './checks';
export type { ResolutionPlan } from './checks';
