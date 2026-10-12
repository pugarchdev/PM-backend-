/**
 * Calculations module for Fern & Foley — Projects
 * Enforces business rules for:
 * 1. Task progress weighting
 * 2. Baselined plan percentage (linear interpolation)
 * 3. Exact project status calculation
 * 4. Workload calculation based on 37-hour work week reference
 */

export interface TaskWeightItem {
  state: string;
  plannedHours: number;
}

export interface PhaseDateItem {
  plannedStart: Date | string;
  plannedEnd: Date | string;
  order?: number;
}

export type ProjectStatus = 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK';
export type WorkloadStatus = 'OVER' | 'BALANCED' | 'AVAILABLE';

/**
 * Task weight: plannedHours (if plannedHours is 0, weight = 1)
 * Progress = (completed task weight / total task weight) * 100
 */
export function calculateProgress(tasks: TaskWeightItem[]): number {
  if (!tasks || tasks.length === 0) {
    return 0;
  }

  let totalWeight = 0;
  let completedWeight = 0;

  for (const task of tasks) {
    const weight = task.plannedHours && task.plannedHours > 0 ? task.plannedHours : 1;
    totalWeight += weight;

    if (task.state === 'Completed' || task.state === 'DONE') {
      completedWeight += weight;
    }
  }

  if (totalWeight === 0) return 0;
  const rawProgress = (completedWeight / totalWeight) * 100;
  return Math.round(rawProgress * 10) / 10;
}

/**
 * Baseline plan percentage represents expected progress today based on
 * the project and phase dates using linear interpolation.
 */
export function calculatePlanPercentage(
  projectStart: Date | string,
  projectEnd: Date | string,
  phases: PhaseDateItem[] = [],
  asOfDate: Date = new Date()
): number {
  const pStart = new Date(projectStart).getTime();
  const pEnd = new Date(projectEnd).getTime();
  const now = asOfDate.getTime();

  if (now <= pStart) return 0;
  if (now >= pEnd) return 100;

  // If phases exist, interpolate across phases
  if (phases && phases.length > 0) {
    const sortedPhases = [...phases].sort(
      (a, b) => new Date(a.plannedStart).getTime() - new Date(b.plannedStart).getTime()
    );

    let cumulativeWeight = 0;
    const totalPhases = sortedPhases.length;
    const phaseWeight = 100 / totalPhases;

    for (const phase of sortedPhases) {
      const phStart = new Date(phase.plannedStart).getTime();
      const phEnd = new Date(phase.plannedEnd).getTime();

      if (now >= phEnd) {
        cumulativeWeight += phaseWeight;
      } else if (now > phStart && phEnd > phStart) {
        const phaseFraction = (now - phStart) / (phEnd - phStart);
        cumulativeWeight += phaseFraction * phaseWeight;
      }
    }

    const clamped = Math.min(100, Math.max(0, cumulativeWeight));
    return Math.round(clamped * 10) / 10;
  }

  // Fallback to project-level linear interpolation
  const fraction = (now - pStart) / (pEnd - pStart);
  const clamped = Math.min(100, Math.max(0, fraction * 100));
  return Math.round(clamped * 10) / 10;
}

/**
 * Exact Project Status Rule:
 * ON TRACK: progress is within 5 percentage points of plan (progress >= plan - 5)
 *           AND no Critical issue is open.
 * AT RISK: 5–15 percentage points behind plan (plan - 15 <= progress < plan - 5)
 *          OR High risk is open.
 * OFF TRACK: more than 15 percentage points behind (progress < plan - 15)
 *            OR Critical issue is open.
 * Status override by Project Owner takes precedence if provided.
 */
export function calculateProjectStatus(params: {
  progress: number;
  plan: number;
  hasCriticalIssueOpen: boolean;
  hasHighRiskOpen: boolean;
  statusOverride?: string | null;
}): ProjectStatus {
  if (params.statusOverride) {
    const override = params.statusOverride.toUpperCase();
    if (override === 'ON_TRACK' || override === 'AT_RISK' || override === 'OFF_TRACK') {
      return override as ProjectStatus;
    }
  }

  const { progress, plan, hasCriticalIssueOpen, hasHighRiskOpen } = params;

  // Off track condition: >15 points behind OR critical issue open
  if (progress < plan - 15 || hasCriticalIssueOpen) {
    return 'OFF_TRACK';
  }

  // At risk condition: 5-15 points behind OR high risk open
  if (progress < plan - 5 || hasHighRiskOpen) {
    return 'AT_RISK';
  }

  // On track
  return 'ON_TRACK';
}

/**
 * Workload Calculation:
 * workloadPercentage = (allocatedHours / 37) * 100
 * >100% = red (OVER)
 * 70–100% = amber (BALANCED)
 * <70% = green (AVAILABLE)
 */
export function calculateWorkload(allocatedHours: number, referenceHours: number = 37): {
  percentage: number;
  status: WorkloadStatus;
  statusLabel: string;
} {
  const percentage = Math.round((allocatedHours / referenceHours) * 100);
  let status: WorkloadStatus = 'AVAILABLE';
  let statusLabel = 'Available';

  if (percentage > 100) {
    status = 'OVER';
    statusLabel = 'Overallocated';
  } else if (percentage >= 70) {
    status = 'BALANCED';
    statusLabel = 'Near Capacity';
  }

  return { percentage, status, statusLabel };
}

/**
 * Milestone slippage calculation:
 * forecast date - baseline date, rounded UPWARD to whole weeks.
 * If forecast is on or before baseline, slippage is 0 weeks.
 */
export function calculateMilestoneSlippage(
  baselineDate: Date | string,
  forecastDate: Date | string
): {
  days: number;
  weeks: number;
  isSlipped: boolean;
} {
  const bDate = new Date(baselineDate).getTime();
  const fDate = new Date(forecastDate).getTime();
  const diffDays = Math.round((fDate - bDate) / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) {
    return { days: diffDays, weeks: 0, isSlipped: false };
  }

  // Round upward to whole weeks: 1 day = 1 week; 8 days = 2 weeks
  const weeks = Math.ceil(diffDays / 7);
  return { days: diffDays, weeks, isSlipped: true };
}

export type ApprovalType = 'Budget' | 'Timeline' | 'Scope';

export interface ApprovalRoutingInput {
  type: ApprovalType;
  requestedAmount?: number;
  projectContingency?: number;
  movesBaselinedMilestone?: boolean;
  requesterId: string;
  requesterRole: 'Employee' | 'ProjectOwner' | 'CEO';
  projectOwnerId: string;
  ceoId: string;
  sponsorName?: string;
}

/**
 * Server-authoritative Approval Routing Logic:
 * 1. Budget within project contingency: Project Owner
 *    - If requester is the Project Owner: escalate one level to CEO.
 * 2. Budget beyond contingency OR any increase over £50,000: CEO
 * 3. Timeline change moving a baselined milestone: Sponsor / CEO
 * 4. Scope change OR cross-project resourcing: CEO
 * 5. Self-approval prevention: Nobody can approve their own request.
 */
export function determineApprovalRoute(input: ApprovalRoutingInput): {
  requiredRole: 'ProjectOwner' | 'CEO';
  designatedApproverId: string;
  escalationReason: string | null;
} {
  const {
    type,
    requestedAmount = 0,
    projectContingency = 0,
    movesBaselinedMilestone = false,
    requesterId,
    projectOwnerId,
    ceoId,
  } = input;

  let targetRole: 'ProjectOwner' | 'CEO' = 'ProjectOwner';
  let designatedId = projectOwnerId;
  let escalation: string | null = null;

  if (type === 'Scope') {
    targetRole = 'CEO';
    designatedId = ceoId;
    escalation = 'Scope changes require executive sign-off from CEO.';
  } else if (type === 'Timeline') {
    if (movesBaselinedMilestone) {
      targetRole = 'CEO';
      designatedId = ceoId;
      escalation = 'Timeline change shifts a baselined milestone (Sponsor/CEO approval required).';
    } else {
      targetRole = 'ProjectOwner';
      designatedId = projectOwnerId;
    }
  } else if (type === 'Budget') {
    const isOver50k = requestedAmount > 50000;
    const exceedsContingency = requestedAmount > projectContingency;

    if (isOver50k || exceedsContingency) {
      targetRole = 'CEO';
      designatedId = ceoId;
      escalation = isOver50k
        ? 'Budget change exceeds £50,000 threshold (CEO approval required).'
        : 'Budget change exceeds project contingency (CEO approval required).';
    } else {
      targetRole = 'ProjectOwner';
      designatedId = projectOwnerId;
    }
  }

  // SELF-APPROVAL PREVENTION RULE:
  // "Nobody can approve their own request. If the only eligible approver is the requester: escalate one level."
  if (designatedId === requesterId) {
    if (targetRole === 'ProjectOwner') {
      targetRole = 'CEO';
      designatedId = ceoId;
      escalation = escalation
        ? `${escalation} Escalate to CEO: Project Owner cannot self-approve.`
        : 'Escalated to CEO: requester cannot self-approve their own request.';
    }
  }

  return {
    requiredRole: targetRole,
    designatedApproverId: designatedId,
    escalationReason: escalation,
  };
}

/**
 * Budget Health & Alerts calculation:
 * - plannedBudget
 * - contingency
 * - spendToDate
 * - remaining = (plannedBudget + contingency) - spendToDate
 * - planMarker = timeline progress share of budget expected to be spent
 * - alert triggers when spendToDate >= 90% of plannedBudget
 */
export function calculateBudgetHealth(params: {
  plannedBudget: number;
  contingency: number;
  spendToDate: number;
  planPercent: number;
}): {
  totalBudget: number;
  remaining: number;
  plannedSpendToDate: number;
  variance: number;
  spendPercent: number;
  isOverBudget: boolean;
  isWarning90Percent: boolean;
} {
  const { plannedBudget, contingency, spendToDate, planPercent } = params;
  const totalBudget = plannedBudget + contingency;
  const remaining = Math.max(0, totalBudget - spendToDate);
  const plannedSpendToDate = Math.round(((plannedBudget * Math.min(100, Math.max(0, planPercent))) / 100) * 100) / 100;
  const variance = Math.round((spendToDate - plannedSpendToDate) * 100) / 100;
  const spendPercent = plannedBudget > 0 ? Math.round((spendToDate / plannedBudget) * 1000) / 10 : 0;
  const isOverBudget = spendToDate > totalBudget;
  const isWarning90Percent = plannedBudget > 0 && spendToDate / plannedBudget >= 0.9;

  return {
    totalBudget,
    remaining,
    plannedSpendToDate,
    variance,
    spendPercent,
    isOverBudget,
    isWarning90Percent,
  };
}
