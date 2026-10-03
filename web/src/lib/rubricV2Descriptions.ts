/** Static reference policy is not distributed, including in authenticated browser bundles. */
export interface RubricDescription {
  id: string;
  title: string;
  description: string;
}

export const RUBRIC_REFERENCE_AVAILABLE = false;
export const SECTION_DESCRIPTIONS: Record<string, RubricDescription> = {};
export const GROUP_DESCRIPTIONS: Record<string, RubricDescription> = {};
export const CRITERION_DESCRIPTIONS: Record<string, RubricDescription> = {};

/** Subagent ownership — maps section ID to the responsible subagent task name */
export const SECTION_SUBAGENT: Record<string, string> = {
  A: "rubric_analysis_A",
  B: "rubric_analysis_B",
  C: "rubric_analysis_C",
  D: "rubric_analysis_D",
};

/**
 * Returns a human-readable hierarchy path for a criterion.
 */
export function buildCriterionPath(sectionId: string, criterionId: string): string {
  const section = SECTION_DESCRIPTIONS[sectionId];
  const groupId = criterionId.split(".")[0]; // "A1.1" → "A1"
  const group = GROUP_DESCRIPTIONS[groupId];
  const criterion = CRITERION_DESCRIPTIONS[criterionId];

  const parts = [
    section?.title ?? sectionId,
    group?.title ?? groupId,
    criterion?.title ?? criterionId,
  ];
  return parts.join(" > ");
}
