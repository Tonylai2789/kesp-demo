import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useLocation, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronDown, ChevronRight, FileText, Check, AlertCircle, AlertTriangle, CheckCircle, XCircle, MinusCircle, HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fetchCall, fetchFeedback } from '@/services/firestore';
import type { Call, Feedback, RubricScorecardSection, RubricScorecardSubsection, RubricV2Section, RubricV2Group, RubricV2Criterion, RubricV2Status } from '@/types';
import { cn } from '@/lib/utils';
import { detectFeedbackVersion } from '@/lib/feedbackVersion';
import { RUBRIC_REFERENCE_AVAILABLE, SECTION_DESCRIPTIONS, GROUP_DESCRIPTIONS, CRITERION_DESCRIPTIONS, SECTION_SUBAGENT } from '@/lib/rubricV2Descriptions';
import { appendReturnTo, getReturnToFromSearch } from '@/lib/returnTo';

// ── SessionStorage helpers for accordion state persistence ──────────────────

function loadSessionSet<T extends string | number>(key: string, parse: (v: string) => T): Set<T> {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return new Set();
    return new Set((JSON.parse(raw) as string[]).map(parse));
  } catch { return new Set(); }
}

/** Documents the saveSessionSet behavior. */
function saveSessionSet<T>(key: string, set: Set<T>): void {
  sessionStorage.setItem(key, JSON.stringify([...set]));
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function getScoreColor(earned: number, max: number): string {
  if (max === 0) return 'text-muted-foreground';
  const pct = (earned / max) * 100;
  if (pct >= 90) return 'text-green-600';
  if (pct >= 70) return 'text-blue-600';
  if (pct >= 50) return 'text-amber-600';
  return 'text-red-600';
}

/** Documents the getScoreBarColor behavior. */
function getScoreBarColor(earned: number, max: number): string {
  if (max === 0) return 'bg-muted';
  const pct = (earned / max) * 100;
  if (pct >= 90) return 'bg-green-500';
  if (pct >= 70) return 'bg-blue-500';
  if (pct >= 50) return 'bg-amber-500';
  return 'bg-red-500';
}

// ── V2 Status Badge ─────────────────────────────────────────────────────────

const statusConfig: Record<RubricV2Status, { icon: typeof CheckCircle; label: string; className: string }> = {
  "Cumple": { icon: CheckCircle, label: "Cumple", className: "text-green-600 bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800" },
  "No cumple": { icon: XCircle, label: "No cumple", className: "text-red-600 bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800" },
  "No aplica": { icon: MinusCircle, label: "N/A", className: "text-gray-500 bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700" },
  "No observable": { icon: HelpCircle, label: "N/O", className: "text-gray-400 bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700" },
};

/** Renders the StatusBadge component. */
function StatusBadge({ status }: { status: RubricV2Status }) {
  const config = statusConfig[status] ?? statusConfig["No observable"];
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={cn('text-xs px-1.5 py-0.5 gap-1', config.className)}>
      <Icon className="h-3 w-3" />
      {config.label}
    </Badge>
  );
}

// ── V2 Criterion Row ────────────────────────────────────────────────────────

function V2CriterionRow({
  criterion,
  isSelected,
  onSelect,
  onNavigate,
}: {
  criterion: RubricV2Criterion;
  isSelected: boolean;
  onSelect: () => void;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const displayStatus = criterion.state ?? criterion.status;
  const isExcluded = criterion.credit === null && (displayStatus === "No aplica" || displayStatus === "No observable");
  const pct = criterion.max_points > 0 && !isExcluded ? (criterion.earned_points / criterion.max_points) * 100 : 0;
  const hasCritiques = (criterion.good_critiques?.length ?? 0) > 0 || (criterion.bad_critiques?.length ?? 0) > 0;
  const hasDetailContent =
    !!criterion.justification ||
    !!criterion.breakdown ||
    (criterion.evidence?.length ?? 0) > 0 ||
    hasCritiques ||
    !!criterion.criterion_improvement_tip;
  const isPartial = !isExcluded && criterion.max_points > 0 && criterion.earned_points > 0 && criterion.earned_points < criterion.max_points;

  const handleClick = /** Handles the handleClick interaction. */ () => {
    onSelect();
    if (hasDetailContent) {
      onNavigate();
    }
  };

  return (
    <div
      className={cn(
        'pl-12 pr-4 py-2.5 border-b cursor-pointer transition-colors',
        isExcluded && 'opacity-60',
        isSelected ? 'bg-blue-50 dark:bg-blue-950 border-l-4 border-l-blue-500' : 'hover:bg-muted border-l-4 border-l-transparent'
      )}
      onClick={handleClick}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-muted-foreground">{criterion.id}</span>
            <span className="font-medium text-sm">{criterion.title}</span>
            <StatusBadge status={displayStatus} />
            {isExcluded && (
              <Badge
                variant="outline"
                className="text-xs px-1.5 py-0.5 text-gray-500 bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700"
                title={t('scorecard.excludedHint')}
              >
                {t('scorecard.excluded', 'Excluido')}
              </Badge>
            )}
            {isPartial && (
              <Badge
                variant="outline"
                className="text-xs px-1.5 py-0.5 text-amber-700 bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800"
              >
                {t('scorecard.partial', 'Parcial')}
              </Badge>
            )}
          </div>
          {criterion.justification && (
            <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
              {criterion.justification}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 ml-2 mt-0.5 flex-shrink-0">
          {isExcluded ? (
            <span className="text-xs text-muted-foreground w-[5.5rem] text-right">—</span>
          ) : (
            <>
              <div className="w-20 h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={cn('h-full rounded-full transition-all', getScoreBarColor(criterion.earned_points, criterion.max_points))}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className={cn('font-semibold text-xs w-14 text-right', getScoreColor(criterion.earned_points, criterion.max_points))}>
                {criterion.earned_points.toFixed(1)}/{criterion.max_points.toFixed(1)}
              </span>
            </>
          )}
          {hasDetailContent && (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </div>
    </div>
  );
}

// ── V2 Group Row ────────────────────────────────────────────────────────────

function V2GroupRow({
  group,
  sectionId,
  isExpanded,
  selectedCriterionId,
  onToggle,
  onSelectCriterion,
  onNavigateCriterion,
}: {
  group: RubricV2Group;
  sectionId: string;
  isExpanded: boolean;
  selectedCriterionId: string | null;
  onToggle: () => void;
  onSelectCriterion: (criterionId: string) => void;
  onNavigateCriterion: (sectionId: string, criterionId: string) => void;
}) {
  const pct = group.max_points > 0 ? (group.earned_points / group.max_points) * 100 : 0;

  return (
    <div>
      <div
        className="pl-8 pr-4 py-2.5 border-b cursor-pointer transition-colors hover:bg-muted/50 flex items-center gap-2"
        onClick={onToggle}
      >
        <Button variant="ghost" size="sm" className="p-0 h-5 w-5" onClick={/** Handles the onClick interaction. */ (e) => { e.stopPropagation(); onToggle(); }}>
          {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground">{group.id}</span>
            <span className="font-medium text-sm">{group.title}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', getScoreBarColor(group.earned_points, group.max_points))}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className={cn('font-semibold text-sm w-16 text-right', getScoreColor(group.earned_points, group.max_points))}>
            {group.earned_points.toFixed(1)}/{group.max_points.toFixed(1)}
          </span>
        </div>
      </div>

      {isExpanded && group.criteria.map(/** Handles the callback for this operation. */(criterion) => (
        <V2CriterionRow
          key={criterion.id}
          criterion={criterion}
          isSelected={selectedCriterionId === criterion.id}
          onSelect={/** Handles the onSelect interaction. */ () => onSelectCriterion(criterion.id)}
          onNavigate={/** Handles the onNavigate interaction. */ () => onNavigateCriterion(sectionId, criterion.id)}
        />
      ))}
    </div>
  );
}

// ── V2 Section Row ──────────────────────────────────────────────────────────

function V2SectionRow({
  section,
  isExpanded,
  expandedGroups,
  selectedCriterionId,
  allGroupsExpanded,
  onToggle,
  onToggleGroup,
  onSelectCriterion,
  onNavigateCriterion,
  onExpandAllGroups,
  onCollapseAllGroups,
}: {
  section: RubricV2Section;
  isExpanded: boolean;
  expandedGroups: Set<string>;
  selectedCriterionId: string | null;
  allGroupsExpanded: boolean;
  onToggle: () => void;
  onToggleGroup: (groupId: string) => void;
  onSelectCriterion: (criterionId: string) => void;
  onNavigateCriterion: (sectionId: string, criterionId: string) => void;
  onExpandAllGroups: () => void;
  onCollapseAllGroups: () => void;
}) {
  const { t } = useTranslation();
  const pct = section.max_points > 0 ? (section.earned_points / section.max_points) * 100 : 0;
  const subagent = SECTION_SUBAGENT[section.id];

  return (
    <div>
      {/* Section Header */}
      <div
        className="px-4 py-3 bg-muted border-b cursor-pointer transition-colors flex items-center gap-2 hover:bg-muted/80"
        onClick={onToggle}
      >
        <Button variant="ghost" size="sm" className="p-0 h-6 w-6" onClick={/** Handles the onClick interaction. */ (e) => { e.stopPropagation(); onToggle(); }}>
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{section.id}. {section.title}</span>
            {subagent && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground border-muted-foreground/30">
                {subagent}
              </Badge>
            )}
            {isExpanded && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground h-5 px-1.5"
                onClick={/** Handles the onClick interaction. */ (e) => {
                  e.stopPropagation();
                  if (allGroupsExpanded) {
                    onCollapseAllGroups();
                  } else {
                    onExpandAllGroups();
                  }
                }}
              >
                {allGroupsExpanded ? t('scorecard.collapseGroups') : t('scorecard.expandGroups')}
              </Button>
            )}
          </div>
          <div className="text-xs text-muted-foreground">{t('scorecard.weight')}: {section.weight_percent}%</div>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-32 h-3 bg-muted rounded-full overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', getScoreBarColor(section.earned_points, section.max_points))}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className={cn('font-bold w-20 text-right', getScoreColor(section.earned_points, section.max_points))}>
            {section.earned_points.toFixed(1)} / {section.max_points}
          </span>
        </div>
      </div>

      {/* Groups */}
      {isExpanded && section.groups.map(/** Handles the callback for this operation. */(group) => (
        <V2GroupRow
          key={group.id}
          group={group}
          sectionId={section.id}
          isExpanded={expandedGroups.has(group.id)}
          selectedCriterionId={selectedCriterionId}
          onToggle={/** Handles the onToggle interaction. */ () => onToggleGroup(group.id)}
          onSelectCriterion={onSelectCriterion}
          onNavigateCriterion={onNavigateCriterion}
        />
      ))}
    </div>
  );
}

// ── V2 Right Panel: Full Rubric Reference ───────────────────────────────────

const SECTION_IDS = ['A', 'B', 'C', 'D'] as const;

/** Renders the V2RubricReferencePanel component. */
function V2RubricReferencePanel({ selectedId }: { selectedId: string | null }) {
  const { t } = useTranslation();
  const criterionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(/** Handles the callback for this operation. */() => {
    if (selectedId && selectedId.includes('.') && criterionRefs.current[selectedId]) {
      criterionRefs.current[selectedId]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [selectedId]);

  return (
    <div className="h-full overflow-auto p-5 space-y-6">
      <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
        {t('scorecard.rubricReference')}
      </div>

      {!RUBRIC_REFERENCE_AVAILABLE && <p className="text-sm text-muted-foreground">{t('scorecard.referenceUnavailable')}</p>}
      {RUBRIC_REFERENCE_AVAILABLE && SECTION_IDS.map(/** Handles the callback for this operation. */(sectionId) => {
        const section = SECTION_DESCRIPTIONS[sectionId];
        const groups = Object.entries(GROUP_DESCRIPTIONS)
          .filter(/** Handles the callback for this operation. */([id]) => id.startsWith(sectionId))
          .sort(/** Handles the callback for this operation. */([a], [b]) => a.localeCompare(b));

        return (
          <div key={sectionId} className="space-y-3">
            {/* Section header */}
            <div className="p-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono text-sm text-blue-600 dark:text-blue-400">{sectionId}</span>
                <span className="font-semibold text-blue-900 dark:text-blue-100">{section?.title}</span>
              </div>
              <p className="text-xs text-blue-700 dark:text-blue-300">{section?.description}</p>
            </div>

            {/* Groups */}
            {groups.map(/** Handles the callback for this operation. */([groupId, groupDesc]) => {
              const criteria = Object.entries(CRITERION_DESCRIPTIONS)
                .filter(/** Handles the callback for this operation. */([id]) => id.startsWith(groupId + '.'))
                .sort(/** Handles the callback for this operation. */([a], [b]) => a.localeCompare(b));

              return (
                <div key={groupId} className="ml-3 space-y-2">
                  {/* Group sub-header */}
                  <div className="p-3 rounded-lg border border-border bg-card">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-mono text-xs text-muted-foreground">{groupId}</span>
                      <span className="text-sm font-medium">{groupDesc.title}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{groupDesc.description}</p>
                  </div>

                  {/* Criteria */}
                  {criteria.map(/** Handles the callback for this operation. */([criterionId, criterionDesc]) => {
                    const isSelected = selectedId === criterionId;
                    return (
                      <div
                        key={criterionId}
                        ref={/** Documents the ref behavior. */ (el) => { criterionRefs.current[criterionId] = el; }}
                        className={cn(
                          'ml-3 p-3 rounded-lg border transition-all duration-300',
                          isSelected
                            ? 'ring-2 ring-blue-500 border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950'
                            : 'border-border bg-card/50'
                        )}
                      >
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-mono text-xs text-muted-foreground">{criterionId}</span>
                          <span className="text-sm font-medium">{criterionDesc.title}</span>
                        </div>
                        <p className="text-xs text-muted-foreground italic">
                          &ldquo;{criterionDesc.description}&rdquo;
                        </p>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ── Legacy Right Panel (replaces PDF) ───────────────────────────────────────

function LegacyRubricReferencePanel({ selectedRef }: { selectedRef: { section_path: string; subsection_text: string } | null }) {
  const { t } = useTranslation();

  if (!selectedRef) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <FileText className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <p>{t('scorecard.selectSection')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-5">
      <div className="p-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950">
        <p className="text-xs text-blue-700 dark:text-blue-300 font-medium mb-2">
          {selectedRef.section_path}
        </p>
        <p className="text-sm text-blue-900 dark:text-blue-100 italic leading-relaxed">
          &ldquo;{selectedRef.subsection_text}&rdquo;
        </p>
      </div>
    </div>
  );
}

// ── Legacy Sub-components (unchanged from before) ───────────────────────────

function LegacySubsectionRow({ subsection, isSelected, isExpanded, hasCritiques, onSelect, onToggleExpand, onNavigate }: {
  subsection: RubricScorecardSubsection;
  isSelected: boolean;
  isExpanded: boolean;
  hasCritiques: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const pct = subsection.max_points > 0 ? (subsection.earned_points / subsection.max_points) * 100 : 0;

  const handleClick = /** Handles the handleClick interaction. */ () => {
    if (hasCritiques) {
      onNavigate();
    } else {
      onToggleExpand();
      onSelect();
    }
  };

  return (
    <div
      className={cn(
        'pl-8 pr-4 py-3 border-b cursor-pointer transition-colors',
        isSelected ? 'bg-blue-50 dark:bg-blue-950 border-l-4 border-l-blue-500' : 'hover:bg-muted border-l-4 border-l-transparent'
      )}
      onClick={handleClick}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="font-medium text-sm">{subsection.title}</div>
          {subsection.justification && (
            <div className={cn('text-xs text-muted-foreground mt-1', hasCritiques ? 'line-clamp-2' : (!isExpanded && 'line-clamp-2'))}>
              {subsection.justification}
            </div>
          )}
          {!hasCritiques && subsection.justification && (
            <span className="text-xs text-blue-600 mt-1 inline-block">
              {isExpanded ? t('scorecard.viewLess') : t('scorecard.viewMore')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 ml-4 mt-0.5">
          <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', getScoreBarColor(subsection.earned_points, subsection.max_points))}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className={cn('font-semibold text-sm w-16 text-right', getScoreColor(subsection.earned_points, subsection.max_points))}>
            {subsection.earned_points.toFixed(1)} / {subsection.max_points.toFixed(1)}
          </span>
          {hasCritiques && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>
    </div>
  );
}

/** Renders the LegacySectionRow component. */
function LegacySectionRow({ section, sectionIndex, isExpanded, selectedSubsection, expandedSubsections, onToggle, onSelectSubsection, onSelectSection, onToggleSubsectionExpand, onNavigateSubsection }: {
  section: RubricScorecardSection;
  sectionIndex: number;
  isExpanded: boolean;
  selectedSubsection: RubricScorecardSubsection | null;
  expandedSubsections: Set<string>;
  onToggle: () => void;
  onSelectSubsection: (sub: RubricScorecardSubsection) => void;
  onSelectSection: () => void;
  onToggleSubsectionExpand: (key: string) => void;
  onNavigateSubsection: (sectionIndex: number, subsectionIndex: number) => void;
}) {
  const { t } = useTranslation();
  const pct = section.max_points > 0 ? (section.earned_points / section.max_points) * 100 : 0;
  const isSectionSelected = selectedSubsection === null;

  return (
    <div>
      <div
        className={cn(
          'px-4 py-3 bg-muted border-b cursor-pointer transition-colors flex items-center gap-2',
          isSectionSelected && isExpanded ? 'ring-2 ring-blue-500 ring-inset' : ''
        )}
        onClick={onToggle}
      >
        <Button variant="ghost" size="sm" className="p-0 h-6 w-6" onClick={/** Handles the onClick interaction. */ (e) => { e.stopPropagation(); onToggle(); }}>
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </Button>
        <div className="flex-1">
          <div className="font-semibold">{section.title}</div>
          <div className="text-xs text-muted-foreground">{t('scorecard.weight')}: {section.weight_percent}%</div>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-32 h-3 bg-muted rounded-full overflow-hidden">
            <div className={cn('h-full rounded-full transition-all', getScoreBarColor(section.earned_points, section.max_points))} style={{ width: `${pct}%` }} />
          </div>
          <span className={cn('font-bold w-20 text-right', getScoreColor(section.earned_points, section.max_points))}>
            {section.earned_points.toFixed(1)} / {section.max_points}
          </span>
        </div>
      </div>
      {isExpanded && section.subsections && (
        <div>
          <div
            className={cn(
              'pl-8 pr-4 py-2 border-b cursor-pointer text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors',
              isSectionSelected ? 'bg-blue-50 dark:bg-blue-950' : ''
            )}
            onClick={onSelectSection}
          >
            <FileText className="h-4 w-4 inline mr-2" />
            {t('scorecard.viewSectionRef')}
          </div>
          {section.subsections.map(/** Handles the callback for this operation. */(sub, idx) => {
            const subKey = `${sectionIndex}-${idx}`;
            const hasCritiques = (sub.good_critiques && sub.good_critiques.length > 0) || (sub.bad_critiques && sub.bad_critiques.length > 0);
            return (
              <LegacySubsectionRow
                key={idx}
                subsection={sub}
                isSelected={selectedSubsection === sub}
                isExpanded={expandedSubsections.has(subKey)}
                hasCritiques={!!hasCritiques}
                onSelect={/** Handles the onSelect interaction. */ () => onSelectSubsection(sub)}
                onToggleExpand={/** Handles the onToggleExpand interaction. */ () => onToggleSubsectionExpand(subKey)}
                onNavigate={/** Handles the onNavigate interaction. */ () => onNavigateSubsection(sectionIndex, idx)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main ScorecardPage ──────────────────────────────────────────────────────

export function ScorecardPage() {
  const { t } = useTranslation();
  const { id: callId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const [call, setCall] = useState<Call | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // SessionStorage key prefix for accordion state persistence across navigation
  const storagePrefix = `scorecard:${callId}`;

  // Shared expand/select state — restored from sessionStorage on remount
  const [expandedSections, setExpandedSections] = useState<Set<number>>(
    /** Handles the callback for this operation. */
    () => {
      const saved = loadSessionSet(`${storagePrefix}:sections`, Number);
      return saved.size > 0 ? saved : new Set([0]);
    }
  );

  // Legacy-specific state
  const [expandedSubsections, setExpandedSubsections] = useState<Set<string>>(new Set());
  const [selectedRef, setSelectedRef] = useState<{ section_path: string; subsection_text: string } | null>(null);

  // V2-specific state — restored from sessionStorage on remount
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    /** Handles the callback for this operation. */
    () => loadSessionSet(`${storagePrefix}:groups`, String)
  );
  const [selectedV2Id, setSelectedV2Id] = useState<string | null>(
    /** Handles the callback for this operation. */
    () => sessionStorage.getItem(`${storagePrefix}:selectedV2Id`) ?? null
  );
  const returnTo = getReturnToFromSearch(location.search);

  const feedbackVersion = useMemo(/** Handles the callback for this operation. */() => detectFeedbackVersion(feedback), [feedback]);

  // Persist accordion state to sessionStorage so it survives navigation round-trips
  useEffect(/** Handles the callback for this operation. */() => { saveSessionSet(`${storagePrefix}:sections`, expandedSections); }, [expandedSections, storagePrefix]);
  useEffect(/** Handles the callback for this operation. */() => { saveSessionSet(`${storagePrefix}:groups`, expandedGroups); }, [expandedGroups, storagePrefix]);
  useEffect(/** Handles the callback for this operation. */() => {
    if (selectedV2Id) sessionStorage.setItem(`${storagePrefix}:selectedV2Id`, selectedV2Id);
    else sessionStorage.removeItem(`${storagePrefix}:selectedV2Id`);
  }, [selectedV2Id, storagePrefix]);

  // Load data
  useEffect(/** Handles the callback for this operation. */() => {
    /** Documents the loadData behavior. */
    async function loadData() {
      if (!callId) { setError('No call ID provided'); setLoading(false); return; }
      try {
        const [callData, feedbackData] = await Promise.all([fetchCall(callId), fetchFeedback(callId)]);
        if (!callData) { setError('Call not found'); setLoading(false); return; }
        setCall(callData);
        setFeedback(feedbackData);

        // Auto-select for legacy
        if (feedbackData?.rubric_scorecard?.sections?.[0]?.rubric_ref) {
          setSelectedRef(feedbackData.rubric_scorecard.sections[0].rubric_ref);
        }
      } catch (err) {
        console.error('Error loading scorecard data:', err);
        setError('Error loading data');
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [callId]);

  // Toggle helpers
  const toggleSection = useCallback(/** Handles the callback for this operation. */(index: number) => {
    setExpandedSections(/** Handles the callback for this operation. */(prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const toggleSubsectionExpand = useCallback(/** Handles the callback for this operation. */(key: string) => {
    setExpandedSubsections(/** Handles the callback for this operation. */(prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const toggleGroup = useCallback(/** Handles the callback for this operation. */(groupId: string) => {
    setExpandedGroups(/** Handles the callback for this operation. */(prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const collapseAll = useCallback(/** Handles the callback for this operation. */() => {
    setExpandedSections(new Set());
    setExpandedGroups(new Set());
  }, []);

  const expandSectionGroups = useCallback(/** Handles the callback for this operation. */(sectionIdx: number, groupIds: string[]) => {
    setExpandedSections(/** Handles the callback for this operation. */(prev) => new Set(prev).add(sectionIdx));
    setExpandedGroups(/** Handles the callback for this operation. */(prev) => {
      const next = new Set(prev);
      groupIds.forEach(/** Handles the callback for this operation. */(id) => next.add(id));
      return next;
    });
  }, []);

  const collapseSectionGroups = useCallback(/** Handles the callback for this operation. */(groupIds: string[]) => {
    setExpandedGroups(/** Handles the callback for this operation. */(prev) => {
      const next = new Set(prev);
      groupIds.forEach(/** Handles the callback for this operation. */(id) => next.delete(id));
      return next;
    });
  }, []);

  // Legacy callbacks
  const selectSectionRef = useCallback(/** Handles the callback for this operation. */(section: RubricScorecardSection) => {
    if (section.rubric_ref) setSelectedRef(section.rubric_ref);
  }, []);

  const selectSubsectionRef = useCallback(/** Handles the callback for this operation. */(sub: RubricScorecardSubsection) => {
    if (sub.rubric_ref) setSelectedRef(sub.rubric_ref);
  }, []);

  const navigateToSubsection = useCallback(/** Handles the callback for this operation. */(sectionIdx: number, subsectionIdx: number) => {
    if (callId) {
      navigate(appendReturnTo(`/calls/${callId}/scorecard/${sectionIdx}/${subsectionIdx}`, returnTo));
    }
  }, [callId, navigate, returnTo]);

  // V2 callbacks
  const navigateToCriterion = useCallback(/** Handles the callback for this operation. */(sectionId: string, criterionId: string) => {
    if (callId) {
      navigate(appendReturnTo(`/calls/${callId}/scorecard/v2/${sectionId}/${criterionId}`, returnTo));
    }
  }, [callId, navigate, returnTo]);

  const scorecard = feedback?.rubric_scorecard;
  const scorecardV2 = feedback?.rubric_scorecard_v2;
  const hasPartialCredit = useMemo(/** Handles the callback for this operation. */() => {
    if (!scorecardV2) return false;
    for (const section of scorecardV2.sections ?? []) {
      for (const group of section.groups ?? []) {
        for (const criterion of group.criteria ?? []) {
          if (
            criterion.max_points > 0 &&
            criterion.earned_points > 0 &&
            criterion.earned_points < criterion.max_points
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }, [scorecardV2]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <AlertCircle className="h-12 w-12 text-red-500" />
        <p className="text-red-600">{error}</p>
        <Button onClick={/** Handles the onClick interaction. */ () => navigate(callId ? appendReturnTo(`/calls/${callId}`, returnTo) : (returnTo ?? '/calls'))}>{t('common.back')}</Button>
      </div>
    );
  }

  const hasAnyScorecard = !!scorecard || !!scorecardV2;

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-card border-b">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={/** Handles the onClick interaction. */ () => navigate(callId ? appendReturnTo(`/calls/${callId}`, returnTo) : (returnTo ?? '/calls'))}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('common.back')}
          </Button>
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-muted-foreground" />
            <span className="font-medium">{t('scorecard.title')}</span>
            {call?.name && <span className="text-muted-foreground text-sm">- {call.name}</span>}
          </div>
        </div>
        {feedback && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{t('scorecard.totalScore')}:</span>
            <span className={cn('text-2xl font-bold', getScoreColor(feedback.overall_score, 100))}>
              {feedback.overall_score}
            </span>
            <span className="text-muted-foreground">/ 100</span>
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel */}
        <div className="w-1/2 border-r overflow-auto">
          {!hasAnyScorecard ? (
            <div className="p-8 text-center text-muted-foreground">
              <AlertCircle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <p>{t('scorecard.noData')}</p>
              <p className="text-sm mt-2">{t('scorecard.noDataHint')}</p>
            </div>
          ) : feedbackVersion === "v2" && scorecardV2 ? (
            /* ── V2 Scorecard ── */
            <div className="divide-y">
              <div className="p-4 bg-card">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{t('scorecard.sections')}</span>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Button variant="ghost" size="sm" className="text-xs text-muted-foreground h-6 px-2" onClick={collapseAll}>
                      {t('scorecard.collapseAll')}
                    </Button>
                    <Check className="h-4 w-4 text-green-500" />
                    <span>{scorecardV2.earned_points.toFixed(1)} / {scorecardV2.total_points} {t('scorecard.points')}</span>
                  </div>
                </div>
                {scorecardV2.low_confidence && (
                  <div className="mt-2 p-2 rounded-md bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0" />
                    <span className="text-xs text-amber-700 dark:text-amber-300">{t('scorecard.lowConfidenceHint')}</span>
                  </div>
                )}
                {scorecardV2.scorable_weight_percent != null && scorecardV2.scorable_weight_percent < 100 && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t('scorecard.scorableWeight', { percent: scorecardV2.scorable_weight_percent })}
                  </div>
                )}
                {hasPartialCredit && (
                  <div className="mt-2 text-xs text-muted-foreground flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0.5 text-amber-700 bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800"
                    >
                      {t('scorecard.partial', 'Parcial')}
                    </Badge>
                    <span>{t('scorecard.partialHint', 'Indica que el criterio recibi\u00F3 cr\u00E9dito parcial.')}</span>
                  </div>
                )}
              </div>
              {scorecardV2.sections.map(/** Handles the callback for this operation. */(section, idx) => {
                const groupIds = section.groups.map(/** Handles the callback for this operation. */ g => g.id);
                const allGroupsExpanded = section.groups.length > 0 && section.groups.every(/** Handles the callback for this operation. */ g => expandedGroups.has(g.id));
                return (
                  <V2SectionRow
                    key={section.id}
                    section={section}
                    isExpanded={expandedSections.has(idx)}
                    expandedGroups={expandedGroups}
                    selectedCriterionId={selectedV2Id}
                    allGroupsExpanded={allGroupsExpanded}
                    onToggle={/** Handles the onToggle interaction. */ () => toggleSection(idx)}
                    onToggleGroup={toggleGroup}
                    onSelectCriterion={/** Handles the onSelectCriterion interaction. */ (criterionId) => setSelectedV2Id(criterionId)}
                    onNavigateCriterion={navigateToCriterion}
                    onExpandAllGroups={/** Handles the onExpandAllGroups interaction. */ () => expandSectionGroups(idx, groupIds)}
                    onCollapseAllGroups={/** Handles the onCollapseAllGroups interaction. */ () => collapseSectionGroups(groupIds)}
                  />
                );
              })}
            </div>
          ) : scorecard ? (
            /* ── Legacy TMK Scorecard ── */
            <div className="divide-y">
              <div className="p-4 bg-card">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{t('scorecard.sections')}</span>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Check className="h-4 w-4 text-green-500" />
                    <span>{scorecard.earned_points.toFixed(1)} / {scorecard.total_points} {t('scorecard.points')}</span>
                  </div>
                </div>
              </div>
              {scorecard.sections.map(/** Handles the callback for this operation. */(section, idx) => (
                <LegacySectionRow
                  key={idx}
                  section={section}
                  sectionIndex={idx}
                  isExpanded={expandedSections.has(idx)}
                  selectedSubsection={
                    selectedRef?.subsection_text && section.subsections?.find(/** Handles the callback for this operation. */(s) => s.rubric_ref?.subsection_text === selectedRef?.subsection_text) || null
                  }
                  expandedSubsections={expandedSubsections}
                  onToggle={/** Handles the onToggle interaction. */ () => toggleSection(idx)}
                  onSelectSubsection={selectSubsectionRef}
                  onSelectSection={/** Handles the onSelectSection interaction. */ () => selectSectionRef(section)}
                  onToggleSubsectionExpand={toggleSubsectionExpand}
                  onNavigateSubsection={navigateToSubsection}
                />
              ))}
            </div>
          ) : null}
        </div>

        {/* Right Panel */}
        <div className="w-1/2 bg-muted">
          {feedbackVersion === "v2" ? (
            <V2RubricReferencePanel selectedId={selectedV2Id} />
          ) : (
            <LegacyRubricReferencePanel selectedRef={selectedRef} />
          )}
        </div>
      </div>
    </div>
  );
}

export default ScorecardPage;
