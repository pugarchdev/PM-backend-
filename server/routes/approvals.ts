import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth } from '../auth.js';
import { determineApprovalRoute } from '../../lib/calculations.js';
import { createNotification } from '../services/notificationService.js';

const router = Router();

// GET /api/approvals — List approvals awaiting current user or requested by user
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const filter = req.query.filter as string; // 'actionable' | 'all' | 'mine'

    let whereClause: any = {};
    if (filter === 'actionable') {
      whereClause = { approverId: user.id, state: 'Pending' };
    } else if (filter === 'mine') {
      whereClause = { requestedBy: user.id };
    } else if (user.role === 'CEO') {
      whereClause = {}; // CEO sees all approvals
    } else if (user.role === 'ProjectOwner') {
      whereClause = {
        OR: [
          { approverId: user.id },
          { requestedBy: user.id },
          { project: { ownerId: user.id } },
        ],
      };
    } else {
      // Employee sees their own requests and approvals for projects they belong to
      whereClause = {
        OR: [
          { requestedBy: user.id },
          { project: { memberships: { some: { userId: user.id } } } },
        ],
      };
    }

    const approvals = await prisma.approvalRequest.findMany({
      where: whereClause,
      orderBy: { requestedAt: 'desc' },
      include: {
        project: { select: { id: true, name: true, ownerId: true, sponsor: true } },
        requester: { select: { id: true, name: true, role: true, avatarUrl: true } },
        approver: { select: { id: true, name: true, role: true, avatarUrl: true } },
      },
    });

    res.json(approvals);
  } catch (error) {
    console.error('Failed to get approvals:', error);
    res.status(500).json({ error: 'Failed to retrieve approval requests' });
  }
});

// GET /api/projects/:id/approvals — List approvals for a specific project
router.get('/project/:projectId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { projectId } = req.params;
    const user = req.user!;

    if (user.role !== 'CEO') {
      const isOwner = await prisma.project.findFirst({ where: { id: projectId, ownerId: user.id } });
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId, userId: user.id } },
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: 'You do not have access to view approvals for this project.' });
      }
    }

    const approvals = await prisma.approvalRequest.findMany({
      where: { projectId },
      orderBy: { requestedAt: 'desc' },
      include: {
        project: { select: { id: true, name: true, ownerId: true } },
        requester: { select: { id: true, name: true, role: true, avatarUrl: true } },
        approver: { select: { id: true, name: true, role: true, avatarUrl: true } },
      },
    });

    res.json(approvals);
  } catch (error) {
    console.error('Failed to get project approvals:', error);
    res.status(500).json({ error: 'Failed to retrieve approvals' });
  }
});

// POST /api/approvals — Submit a new approval request
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const {
      projectId,
      type, // 'Budget' | 'Timeline' | 'Scope'
      summary,
      detail,
      impact,
      requestedAmount,
      movesBaselinedMilestone,
      payload,
    } = req.body;

    if (!projectId || !type || !summary || !detail) {
      return res.status(400).json({ error: 'projectId, type, summary, and detail are required' });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { owner: true },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (user.role !== 'CEO') {
      const isOwner = project.ownerId === user.id;
      const isMember = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId, userId: user.id } },
      });
      if (!isOwner && !isMember) {
        return res.status(403).json({ error: 'You do not have access to submit approvals for this project.' });
      }
    }

    // Find a CEO in the system for routing
    const ceo = await prisma.user.findFirst({
      where: { role: 'CEO' },
    });
    const ceoId = ceo?.id || project.ownerId;

    // Apply strict server-authoritative routing rules
    const route = determineApprovalRoute({
      type: type as any,
      requestedAmount: Number(requestedAmount) || 0,
      projectContingency: project.contingency,
      movesBaselinedMilestone: !!movesBaselinedMilestone,
      requesterId: user.id,
      requesterRole: user.role as any,
      projectOwnerId: project.ownerId,
      ceoId,
      sponsorName: project.sponsor,
    });

    const approval = await prisma.approvalRequest.create({
      data: {
        projectId,
        type,
        summary,
        detail,
        impact: impact || (route.escalationReason ? `[Route note: ${route.escalationReason}]` : 'Standard approval workflow'),
        requestedBy: user.id,
        approverId: route.designatedApproverId,
        state: 'Pending',
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload || {}),
        version: 1,
      },
      include: {
        project: { select: { id: true, name: true, ownerId: true } },
        requester: { select: { id: true, name: true, role: true } },
        approver: { select: { id: true, name: true, role: true } },
      },
    });

    // Notify the designated approver
    await createNotification({
      userId: route.designatedApproverId,
      projectId,
      title: `Approval Required: ${summary}`,
      message: `${user.name} submitted a ${type} request for "${project.name}".`,
      type: 'approval_awaiting',
      linkUrl: `/projects/${projectId}?tab=approvals`,
      isPush: true,
    });

    res.status(201).json(approval);
  } catch (error) {
    console.error('Failed to create approval request:', error);
    res.status(500).json({ error: 'Failed to create approval request' });
  }
});

// POST /api/approvals/:id/decide — Approve or Send Back
router.post('/:id/decide', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { action, decisionNote } = req.body; // action: 'APPROVE' | 'SEND_BACK'
    const user = req.user!;

    if (action !== 'APPROVE' && action !== 'SEND_BACK') {
      return res.status(400).json({ error: 'action must be APPROVE or SEND_BACK' });
    }

    const approval = await prisma.approvalRequest.findUnique({
      where: { id },
      include: {
        project: true,
        requester: true,
      },
    });

    if (!approval) {
      return res.status(404).json({ error: 'Approval request not found' });
    }

    if (approval.state !== 'Pending') {
      return res.status(400).json({ error: `Request is already in '${approval.state}' state.` });
    }

    // EMPLOYEES CANNOT DECIDE APPROVALS
    if (user.role === 'Employee') {
      return res.status(403).json({ error: 'Forbidden: Employees cannot approve or send back requests.' });
    }

    // Permission check: Both Project Owner and CEO are eligible to approve/send back requests on the project
    const isCEO = user.role === 'CEO';
    const isProjectOwner = approval.project.ownerId === user.id;
    const isDesignatedApprover = user.id === approval.approverId;

    const canDecide = isCEO || isProjectOwner || isDesignatedApprover;
    if (!canDecide) {
      return res.status(403).json({ error: 'You are not authorized to decide this request.' });
    }

    const now = new Date();

    if (action === 'SEND_BACK') {
      // Sent back is NOT rejection. Requester can revise and resubmit.
      const updated = await prisma.approvalRequest.update({
        where: { id },
        data: {
          state: 'Sent back',
          decidedAt: now,
          decisionNote: decisionNote || 'Sent back for revisions.',
        },
        include: {
          requester: { select: { id: true, name: true } },
          project: { select: { id: true, name: true } },
        },
      });

      // Notify requester
      await createNotification({
        userId: approval.requestedBy,
        projectId: approval.projectId,
        title: `Request Sent Back: ${approval.summary}`,
        message: `${user.name} sent back your ${approval.type} request: "${decisionNote || 'Revisions required'}"`,
        type: 'approval_decision',
        linkUrl: `/projects/${approval.projectId}?tab=approvals`,
        isPush: true,
      });

      return res.json(updated);
    }

    // ACTION === 'APPROVE'
    const updated = await prisma.approvalRequest.update({
      where: { id },
      data: {
        state: 'Approved',
        decidedAt: now,
        decisionNote: decisionNote || 'Approved',
      },
      include: {
        requester: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
      },
    });

    // Apply the approved change to project state
    let payloadData: any = {};
    try {
      payloadData = JSON.parse(approval.payload || '{}');
    } catch (e) {
      payloadData = {};
    }

    let changeLogDetails = `${approval.type} change approved by ${user.name}: ${approval.summary}`;

    if (approval.type === 'Budget') {
      const budgetDelta = Number(payloadData.budgetIncrease) || 0;
      const contingencyDelta = Number(payloadData.contingencyIncrease) || 0;
      if (budgetDelta !== 0 || contingencyDelta !== 0) {
        await prisma.project.update({
          where: { id: approval.projectId },
          data: {
            plannedBudget: { increment: budgetDelta },
            contingency: { increment: contingencyDelta },
          },
        });
        changeLogDetails += ` (Planned Budget +£${budgetDelta}, Contingency +£${contingencyDelta})`;
      }
    } else if (approval.type === 'Timeline') {
      if (payloadData.milestoneId && payloadData.newForecastDate) {
        await prisma.milestone.update({
          where: { id: payloadData.milestoneId },
          data: { forecastDate: new Date(payloadData.newForecastDate) },
        });
        changeLogDetails += ` (Milestone updated to ${payloadData.newForecastDate})`;
      }
    }

    // Record in Change Log
    await prisma.changeLogEntry.create({
      data: {
        projectId: approval.projectId,
        what: `${approval.type} Change Approved`,
        fromValue: approval.state,
        toValue: 'Approved',
        actorId: user.id,
        at: now,
        sourceType: approval.type.toUpperCase(),
        sourceId: approval.id,
        action: `APPROVED_${approval.type.toUpperCase()}`,
        details: changeLogDetails,
        changedBy: user.name,
      },
    });

    // Notify requester
    await createNotification({
      userId: approval.requestedBy,
      projectId: approval.projectId,
      title: `Request Approved: ${approval.summary}`,
      message: `${user.name} approved your ${approval.type} request.`,
      type: 'approval_decision',
      linkUrl: `/projects/${approval.projectId}?tab=approvals`,
      isPush: true,
    });

    res.json(updated);
  } catch (error) {
    console.error('Failed to decide approval request:', error);
    res.status(500).json({ error: 'Failed to process approval decision' });
  }
});

// POST /api/approvals/:id/resubmit — Revise and resubmit a "Sent back" request
router.post('/:id/resubmit', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    const { summary, detail, impact, payload } = req.body;

    const prevRequest = await prisma.approvalRequest.findUnique({
      where: { id },
      include: { project: true },
    });

    if (!prevRequest) {
      return res.status(404).json({ error: 'Original approval request not found' });
    }

    if (prevRequest.requestedBy !== user.id && user.role !== 'CEO') {
      return res.status(403).json({ error: 'Only the original requester can revise and resubmit this request.' });
    }

    if (prevRequest.state !== 'Sent back') {
      return res.status(400).json({ error: 'Only requests in "Sent back" state can be resubmitted.' });
    }

    // Create a new revision version
    const newVersion = prevRequest.version + 1;
    const newApproval = await prisma.approvalRequest.create({
      data: {
        projectId: prevRequest.projectId,
        type: prevRequest.type,
        summary: summary || prevRequest.summary,
        detail: detail || prevRequest.detail,
        impact: impact || prevRequest.impact,
        requestedBy: user.id,
        approverId: prevRequest.approverId,
        state: 'Pending',
        payload: payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : prevRequest.payload,
        version: newVersion,
        previousRequestId: prevRequest.id,
      },
      include: {
        project: { select: { id: true, name: true } },
        requester: { select: { id: true, name: true, role: true } },
        approver: { select: { id: true, name: true, role: true } },
      },
    });

    // Notify approver
    await createNotification({
      userId: prevRequest.approverId,
      projectId: prevRequest.projectId,
      title: `Revised Request (v${newVersion}): ${newApproval.summary}`,
      message: `${user.name} revised and resubmitted a ${prevRequest.type} request.`,
      type: 'approval_awaiting',
      linkUrl: `/projects/${prevRequest.projectId}?tab=approvals`,
      isPush: true,
    });

    res.status(201).json(newApproval);
  } catch (error) {
    console.error('Failed to resubmit approval:', error);
    res.status(500).json({ error: 'Failed to resubmit request' });
  }
});

export default router;
