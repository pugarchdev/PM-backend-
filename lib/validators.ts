import { z } from 'zod';

export const TaskCreateSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(120, 'Title cannot exceed 120 characters'),
    phaseId: z.string().min(1, 'Phase is required'),
    assigneeId: z.string().nullable().optional(),
    priority: z.enum(['Low', 'Normal', 'High']).default('Normal'),
    plannedStart: z.string().or(z.date()),
    plannedEnd: z.string().or(z.date()),
    plannedHours: z.coerce.number().int('Hours must be an integer').min(0, 'Min hours is 0').max(999, 'Max hours is 999'),
    dependsOn: z.string().nullable().optional(),
  })
  .refine(
    (data) => {
      const start = new Date(data.plannedStart).getTime();
      const end = new Date(data.plannedEnd).getTime();
      return end >= start;
    },
    {
      message: 'Planned end date cannot precede planned start date',
      path: ['plannedEnd'],
    }
  );

export const TaskUpdateSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(120, 'Title cannot exceed 120 characters').optional(),
  phaseId: z.string().min(1, 'Phase is required').optional(),
  assigneeId: z.string().nullable().optional(),
  priority: z.enum(['Low', 'Normal', 'High']).optional(),
  plannedStart: z.string().or(z.date()).optional(),
  plannedEnd: z.string().or(z.date()).optional(),
  plannedHours: z.coerce.number().int().min(0).max(999).optional(),
  actualHours: z.coerce.number().int().min(0).optional(),
  state: z.enum(['Not started', 'In progress', 'Blocked', 'Completed']).optional(),
  dependsOn: z.string().nullable().optional(),
  hasRiskFlag: z.boolean().optional(),
  riskFlagReason: z.string().nullable().optional(),
});

export const PhaseCreateSchema = z
  .object({
    name: z.string().trim().min(1, 'Phase name is required').max(100, 'Phase name cannot exceed 100 characters'),
    plannedStart: z.string().or(z.date()),
    plannedEnd: z.string().or(z.date()),
    order: z.coerce.number().int().optional(),
  })
  .refine(
    (data) => {
      const start = new Date(data.plannedStart).getTime();
      const end = new Date(data.plannedEnd).getTime();
      return end >= start;
    },
    {
      message: 'Planned end date cannot precede planned start date',
      path: ['plannedEnd'],
    }
  );

export const PhaseRenameSchema = z.object({
  name: z.string().trim().min(1, 'Phase name is required').max(100, 'Phase name cannot exceed 100 characters'),
});

export const IssueCreateSchema = z.object({
  projectId: z.string().min(1, 'Project is required'),
  taskId: z.string().nullable().optional(),
  title: z.string().trim().min(1, 'Title is required').max(150, 'Title cannot exceed 150 characters'),
  severity: z.enum(['Minor', 'Major', 'Critical']),
  detail: z.string().trim().min(1, 'Detail is required'),
});

export const IssueUpdateSchema = z.object({
  title: z.string().trim().min(1).max(150).optional(),
  severity: z.enum(['Minor', 'Major', 'Critical']).optional(),
  detail: z.string().trim().min(1).optional(),
  state: z.enum(['Open', 'In progress', 'Closed']).optional(),
  reopenComment: z.string().trim().optional(),
});

export const RiskCreateSchema = z.object({
  projectId: z.string().min(1, 'Project is required'),
  taskId: z.string().nullable().optional(),
  description: z.string().trim().min(1, 'Description is required').max(250, 'Description cannot exceed 250 characters'),
  severity: z.enum(['Low', 'Medium', 'High']).default('Medium'),
  mitigation: z.string().trim().optional(),
});

export const RiskUpdateSchema = z.object({
  description: z.string().trim().min(1).max(250).optional(),
  severity: z.enum(['Low', 'Medium', 'High']).optional(),
  mitigation: z.string().trim().optional(),
  closed: z.boolean().optional(),
});

export const MilestoneCreateSchema = z
  .object({
    projectId: z.string().min(1, 'Project is required'),
    title: z.string().trim().min(1, 'Title is required').max(120),
    baselineDate: z.string().or(z.date()),
    forecastDate: z.string().or(z.date()),
  });

export const ProjectCreateSchema = z
  .object({
    name: z.string().trim().min(1, 'Project name is required').max(150, 'Name cannot exceed 150 characters'),
    goal: z.string().trim().min(1, 'Goal is required'),
    sponsor: z.string().trim().min(1, 'Sponsor is required'),
    startDate: z.string().or(z.date()),
    endDate: z.string().or(z.date()),
    ownerId: z.string().min(1).optional(),
    plannedBudget: z.coerce.number().min(0, 'Budget must be positive').max(100000000).optional().default(0),
    contingency: z.coerce.number().min(0, 'Contingency must be positive').max(100000000).optional().default(0),
  })
  .refine(
    (data) => {
      const start = new Date(data.startDate).getTime();
      const end = new Date(data.endDate).getTime();
      return end >= start;
    },
    {
      message: 'Project end date cannot precede start date',
      path: ['endDate'],
    }
  );

export const ProjectCharterUpdateSchema = z
  .object({
    name: z.string().trim().min(1, 'Project name is required').max(150).optional(),
    goal: z.string().trim().min(1, 'Goal is required').optional(),
    sponsor: z.string().trim().min(1, 'Sponsor is required').optional(),
    startDate: z.string().or(z.date()).optional(),
    endDate: z.string().or(z.date()).optional(),
    ownerId: z.string().min(1).optional(),
  })
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        const start = new Date(data.startDate).getTime();
        const end = new Date(data.endDate).getTime();
        return end >= start;
      }
      return true;
    },
    {
      message: 'Project end date cannot precede start date',
      path: ['endDate'],
    }
  );

export const ApprovalRequestCreateSchema = z.object({
  projectId: z.string().min(1, 'Project is required'),
  type: z.enum(['Budget', 'Timeline', 'Scope']),
  summary: z.string().trim().min(1, 'Summary is required').max(150),
  detail: z.string().trim().min(1, 'Detail is required'),
  impact: z.string().trim().optional(),
  requestedAmount: z.coerce.number().min(0).optional().default(0),
  movesBaselinedMilestone: z.boolean().optional().default(false),
  payload: z.any().optional(),
});

export const StatusOverrideSchema = z.object({
  status: z.enum(['ON_TRACK', 'AT_RISK', 'OFF_TRACK']),
  reason: z.string().trim().min(5, 'Reason must be at least 5 characters'),
});
