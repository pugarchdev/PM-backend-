import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';
import {
  getUserHierarchyContext,
  getLeaveApprover,
  canViewLeaveRequest,
  canDecideLeaveRequest,
  canWithdrawLeaveRequest,
  getVisibleLeaveUserIds,
  getSharedProjectUserIds,
} from '../services/authorizationService.js';
import { dispatchLeaveSubmissionEmails } from '../services/emailService.js';

const router = Router();

const LEAVE_TYPES = ['Annual Leave', 'Sick Leave', 'Personal Leave', 'Unpaid Leave', 'Other'];
const DAY_TYPES = ['Full day', 'Half day'];

// ─── GET /api/leave ─────────────────────────────────────────────────────────
// Dynamic Scoping:
// - Executives see all organization leave requests.
// - Managers see their own requests plus all subordinate requests in their reporting line.
// - Employees/Interns see their own requests.
// - scope=team / availability allows viewing approved leaves of colleagues on shared authorized projects (with private reasons sanitized).
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);
    const { status, scope, startDate, endDate, search, page, limit } = req.query;

    const where: Prisma.LeaveRequestWhereInput = {};

    if (scope === 'mine') {
      where.requestedBy = user.id;
    } else if (scope === 'subordinates' || scope === 'pending_review') {
      if (!ctx.isExecutive) {
        if (ctx.allSubordinateIds.length > 0) {
          where.requestedBy = { in: ctx.allSubordinateIds };
        } else {
          where.requestedBy = { in: [] };
        }
      }
    } else if (scope === 'team' || scope === 'availability') {
      if (!ctx.isExecutive) {
        const sharedIds = await getSharedProjectUserIds(ctx);
        const subordinateSet = new Set([user.id, ...ctx.allSubordinateIds, ...sharedIds]);
        where.requestedBy = { in: Array.from(subordinateSet) };
      }
    } else {
      // Default:
      if (!ctx.isExecutive) {
        if (ctx.allSubordinateIds.length > 0) {
          where.requestedBy = { in: [user.id, ...ctx.allSubordinateIds] };
        } else {
          where.requestedBy = user.id;
        }
      }
    }

    if (status && typeof status === 'string' && status !== 'ALL') {
      where.status = status;
    } else if (scope === 'pending_review') {
      where.status = 'Pending';
    }

    if (startDate || endDate) {
      if (startDate) where.endDate = { gte: new Date(String(startDate)) };
      if (endDate) where.startDate = { lte: new Date(String(endDate)) };
    }

    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim();
      where.OR = [
        { reason: { contains: term, mode: 'insensitive' } },
        { leaveType: { contains: term, mode: 'insensitive' } },
        { requester: { name: { contains: term, mode: 'insensitive' } } },
      ];
    }

    const selectProjection = {
      id: true,
      requestedBy: true,
      startDate: true,
      endDate: true,
      dayType: true,
      leaveType: true,
      reason: true,
      status: true,
      reviewedBy: true,
      reviewedAt: true,
      reviewNote: true,
      createdAt: true,
      updatedAt: true,
      requester: {
        select: {
          id: true,
          name: true,
          role: true,
          department: true,
          avatarUrl: true,
          roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
        },
      },
      reviewer: {
        select: {
          id: true,
          name: true,
          role: true,
          roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
        },
      },
    };

    const isPaginated = page !== undefined || limit !== undefined;
    const pageNum = Math.max(1, parseInt(String(page || '1'), 10) || 1);
    const take = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10) || 50)) : 50;
    const skip = (pageNum - 1) * take;

    const [total, requests] = await Promise.all([
      prisma.leaveRequest.count({ where }),
      prisma.leaveRequest.findMany({
        where,
        select: selectProjection,
        orderBy: { createdAt: 'desc' },
        ...(isPaginated ? { skip, take } : {}),
      }),
    ]);

    // PRIVACY ENFORCEMENT:
    // If request belongs to a colleague who is NOT a subordinate and user is NOT an executive:
    // - Only APPROVED requests may be viewed (for team availability).
    // - The 'reason' and 'reviewNote' fields are sanitized to protect sensitive medical or personal privacy.
    const sanitizedRequests = requests
      .filter((reqItem) => {
        const isSelf = reqItem.requestedBy === ctx.userId;
        const isSubordinate = ctx.allSubordinateIds.includes(reqItem.requestedBy);
        if (isSelf || isSubordinate || ctx.isExecutive) {
          return true;
        }
        // Colleague on shared project: only approved leaves can be seen for scheduling
        return reqItem.status === 'Approved';
      })
      .map((reqItem) => {
        const isSelf = reqItem.requestedBy === ctx.userId;
        const isSubordinate = ctx.allSubordinateIds.includes(reqItem.requestedBy);
        const hasFullAccess = isSelf || isSubordinate || ctx.isExecutive;

        if (!hasFullAccess) {
          return {
            ...reqItem,
            reason: null, // Sanitized for peer privacy
            reviewNote: null,
          };
        }
        return reqItem;
      });

    res.setHeader('X-Total-Count', String(total));

    if (isPaginated) {
      const totalPages = Math.ceil(total / take) || 1;
      return res.json({
        leaveRequests: sanitizedRequests,
        pagination: {
          total,
          page: pageNum,
          limit: take,
          totalPages,
        },
      });
    }

    res.json(sanitizedRequests);
  } catch (error) {
    console.error('Failed to get leave requests:', error);
    res.status(500).json({ error: 'Failed to retrieve leave requests' });
  }
});

// ─── GET /api/leave/approver ────────────────────────────────────────────────
// Resolves the current user's designated leave approver in the reporting hierarchy.
router.get('/approver', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const approver = await getLeaveApprover(user.id);
    res.json({ approver });
  } catch (error) {
    console.error('Failed to get designated approver:', error);
    res.status(500).json({ error: 'Failed to resolve leave approver' });
  }
});

// ─── GET /api/leave/summary ────────────────────────────────────────────────
// Aggregated leave metrics and team availability indicators scoped to user permissions.
router.get('/summary', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const now = new Date();

    const [myLeaves, teamLeavesData] = await Promise.all([
      prisma.leaveRequest.findMany({
        where: { requestedBy: user.id },
        select: { status: true, startDate: true, endDate: true },
      }),
      (ctx.isExecutive || ctx.allSubordinateIds.length > 0)
        ? (async () => {
            const subordinateIds = ctx.isExecutive
              ? (await prisma.user.findMany({ select: { id: true } })).map((u) => u.id).filter((id) => id !== user.id)
              : ctx.allSubordinateIds;

            const leaves = await prisma.leaveRequest.findMany({
              where: { requestedBy: { in: subordinateIds } },
              select: { status: true, startDate: true, endDate: true },
            });

            return { subordinateIds, leaves };
          })()
        : Promise.resolve(null),
    ]);

    const myApproved = myLeaves.filter((l) => l.status === 'Approved');
    const myPending = myLeaves.filter((l) => l.status === 'Pending');
    const currentlyOnLeave = myApproved.some(
      (l) => new Date(l.startDate) <= now && new Date(l.endDate) >= now
    );

    let teamSummary: any = null;
    if (teamLeavesData) {
      const { subordinateIds, leaves } = teamLeavesData;
      const teamPending = leaves.filter((l) => l.status === 'Pending');
      const teamApproved = leaves.filter((l) => l.status === 'Approved');
      const teamCurrentlyOnLeave = teamApproved.filter(
        (l) => new Date(l.startDate) <= now && new Date(l.endDate) >= now
      );

      teamSummary = {
        totalSubordinatesCount: subordinateIds.length,
        pendingApprovalsCount: teamPending.length,
        currentlyOnLeaveCount: teamCurrentlyOnLeave.length,
        totalApprovedLeavesCount: teamApproved.length,
      };
    }

    res.json({
      mySummary: {
        totalSubmitted: myLeaves.length,
        pendingCount: myPending.length,
        approvedCount: myApproved.length,
        currentlyOnLeave,
      },
      teamSummary,
      canApproveLeaves: ctx.isExecutive || ctx.allSubordinateIds.length > 0,
    });
  } catch (error) {
    console.error('Failed to get leave summary:', error);
    res.status(500).json({ error: 'Failed to retrieve leave summary' });
  }
});

// ─── POST /api/leave ─────────────────────────────────────────────────────────
// Submits a new leave request.
// Determines designated approver via dynamic hierarchy and routes notifications accordingly.
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const { startDate, endDate, dayType, leaveType, reason } = req.body;

    if (!startDate || !endDate || !leaveType) {
      return res.status(400).json({ error: 'startDate, endDate, and leaveType are required.' });
    }

    if (!LEAVE_TYPES.includes(leaveType)) {
      return res.status(400).json({ error: `Invalid leaveType. Must be one of: ${LEAVE_TYPES.join(', ')}` });
    }

    if (dayType && !DAY_TYPES.includes(dayType)) {
      return res.status(400).json({ error: `Invalid dayType. Must be 'Full day' or 'Half day'.` });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ error: 'Invalid date format.' });
    }

    // Compare date parts only (start-of-day UTC) to avoid time-of-day discrepancies
    const startMs = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    const endMs = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());

    if (endMs < startMs) {
      return res.status(400).json({ error: 'End date cannot be before start date.' });
    }

    // Prevent duplicate pending or approved requests for overlapping dates
    const overlapping = await prisma.leaveRequest.findFirst({
      where: {
        requestedBy: user.id,
        status: { in: ['Pending', 'Approved'] },
        startDate: { lte: end },
        endDate: { gte: start },
      },
    });

    if (overlapping) {
      return res.status(400).json({
        error: `You already have a ${overlapping.status.toLowerCase()} leave request for overlapping dates (${new Date(overlapping.startDate).toLocaleDateString()} – ${new Date(overlapping.endDate).toLocaleDateString()}).`,
      });
    }

    // Resolve designated approver using dynamic reporting hierarchy
    const approver = await getLeaveApprover(user.id);

    const leave = await prisma.leaveRequest.create({
      data: {
        requestedBy: user.id,
        startDate: start,
        endDate: end,
        dayType: dayType || 'Full day',
        leaveType,
        reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
        status: 'Pending',
      },
      include: {
        requester: {
          select: {
            id: true,
            name: true,
            role: true,
            department: true,
            avatarUrl: true,
            roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
          },
        },
        reviewer: {
          select: {
            id: true,
            name: true,
            role: true,
            roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
          },
        },
      },
    });

    // Notify the designated direct approver in the hierarchy (if not self)
    if (approver && approver.id !== user.id) {
      try {
        await prisma.notification.create({
          data: {
            userId: approver.id,
            title: 'New Leave Request Pending Review',
            message: `${user.name} submitted a ${leaveType} request (${dayType || 'Full day'}) for your review.`,
            type: 'LEAVE_REQUEST',
            linkUrl: '/dashboard',
          },
        });
      } catch (notifErr) {
        console.error('Failed to create leave request notification:', notifErr);
      }
    }

    // Dispatch email notifications in compliance with dynamic leave recipient rules
    try {
      await dispatchLeaveSubmissionEmails({
        leaveId: leave.id,
        requesterId: user.id,
        requesterName: user.name,
        requesterRole: (leave.requester as any)?.roleDefinition?.name || user.role,
        leaveType: leave.leaveType,
        dayType: leave.dayType,
        startDate: leave.startDate,
        endDate: leave.endDate,
        submissionDate: leave.createdAt,
        status: leave.status,
      });
    } catch (emailErr: any) {
      // Non-blocking: email delivery errors must NOT rollback or fail the saved leave request
      console.error('[LeaveAPI] Failed to dispatch leave submission emails:', emailErr.message || emailErr);
    }

    res.status(201).json({
      ...leave,
      designatedApprover: approver,
    });
  } catch (error) {
    console.error('Failed to create leave request:', error);
    res.status(500).json({ error: 'Failed to submit leave request' });
  }
});

// ─── POST /api/leave/:id/decide ──────────────────────────────────────────────
// Executive or authorized manager in reporting hierarchy: Approve, Send Back, or Decline a leave request.
// Enforces self-approval prevention and hierarchical approval authority.
router.post('/:id/decide', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);
    const { action, reviewNote } = req.body;

    let normalizedAction = (action || '').toUpperCase().trim().replace(/[\s-]+/g, '_');
    if (normalizedAction === 'DECLINE' || normalizedAction === 'DECLINED') normalizedAction = 'REJECT';
    if (normalizedAction === 'APPROVED') normalizedAction = 'APPROVE';
    if (normalizedAction === 'SENT_BACK') normalizedAction = 'SEND_BACK';

    if (!['APPROVE', 'SEND_BACK', 'REJECT'].includes(normalizedAction)) {
      return res.status(400).json({ error: "action must be 'APPROVE', 'SEND_BACK', or 'REJECT'." });
    }

    const trimmedNote = typeof reviewNote === 'string' ? reviewNote.trim() : '';

    if ((normalizedAction === 'SEND_BACK' || normalizedAction === 'REJECT') && !trimmedNote) {
      return res.status(400).json({ error: 'A review note is required when sending back or declining a request.' });
    }

    const leave = await prisma.leaveRequest.findUnique({
      where: { id },
      include: {
        requester: {
          select: { id: true, name: true, role: true, department: true },
        },
      },
    });

    if (!leave) {
      return res.status(404).json({ error: 'Leave request not found.' });
    }

    // Dynamic authorization check & self-approval prevention
    const decisionAuth = canDecideLeaveRequest(ctx, leave);
    if (!decisionAuth.allowed) {
      return res.status(403).json({ error: decisionAuth.reason || 'Forbidden: Insufficient approval authority.' });
    }

    const statusMap: Record<string, string> = {
      APPROVE: 'Approved',
      SEND_BACK: 'Sent back',
      REJECT: 'Declined',
    };

    const updatedStatus = statusMap[normalizedAction];

    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: {
        status: updatedStatus,
        reviewNote: trimmedNote || (normalizedAction === 'APPROVE' ? 'Approved.' : null),
        reviewedBy: user.id,
        reviewedAt: new Date(),
      },
      include: {
        requester: {
          select: {
            id: true,
            name: true,
            role: true,
            department: true,
            avatarUrl: true,
            roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
          },
        },
        reviewer: {
          select: {
            id: true,
            name: true,
            role: true,
            roleDefinition: { select: { id: true, name: true, rank: true, isExecutive: true } },
          },
        },
      },
    });

    // Notify requester of decision
    try {
      await prisma.notification.create({
        data: {
          userId: leave.requestedBy,
          title: `Leave Request ${updatedStatus}`,
          message: `Your ${leave.leaveType} request was ${updatedStatus.toLowerCase()} by ${user.name}.`,
          type: 'LEAVE_DECISION',
          linkUrl: '/workload',
        },
      });
    } catch (notifErr) {
      console.error('Failed to create leave decision notification:', notifErr);
    }

    res.json(updated);
  } catch (error) {
    console.error('Failed to decide leave request:', error);
    res.status(500).json({ error: 'Failed to process leave decision.' });
  }
});

// ─── POST / DELETE /api/leave/:id/withdraw ───────────────────────────────────
// Employee / Intern / Requester: withdraw their own PENDING request.
const handleWithdraw = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    const ctx = await getUserHierarchyContext(user.id);

    const leave = await prisma.leaveRequest.findUnique({ where: { id } });

    if (!leave) {
      return res.status(404).json({ error: 'Leave request not found.' });
    }

    if (!canWithdrawLeaveRequest(ctx, leave)) {
      if (leave.requestedBy !== user.id) {
        return res.status(403).json({ error: 'You can only cancel or withdraw your own leave requests.' });
      }
      return res.status(400).json({
        error: `Only pending requests can be withdrawn. This request is already '${leave.status}'.`,
      });
    }

    await prisma.leaveRequest.delete({ where: { id } });

    res.json({ success: true, message: 'Leave request successfully withdrawn.' });
  } catch (error) {
    console.error('Failed to withdraw leave request:', error);
    res.status(500).json({ error: 'Failed to withdraw leave request.' });
  }
};

router.post('/:id/withdraw', requireAuth, handleWithdraw);
router.delete('/:id/withdraw', requireAuth, handleWithdraw);
router.delete('/:id', requireAuth, handleWithdraw);

export default router;
