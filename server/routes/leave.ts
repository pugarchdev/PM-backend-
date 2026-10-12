import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AuthRequest, requireAuth, requireCEO } from '../auth.js';

const router = Router();

const LEAVE_TYPES = ['Annual Leave', 'Sick Leave', 'Personal Leave', 'Unpaid Leave', 'Other'];
const DAY_TYPES = ['Full day', 'Half day'];

// ─── GET /api/leave ─────────────────────────────────────────────────────────
// Employee / Project Owner: returns their own requests.
// CEO: returns ALL requests (for the Approvals area).
// Optional query parameter: ?status=Pending|Approved|Sent back|Declined
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const { status } = req.query;

    const where: Prisma.LeaveRequestWhereInput =
      user.role === 'CEO'
        ? {} // CEO sees everything
        : { requestedBy: user.id }; // Others see only their own

    if (status && typeof status === 'string') {
      where.status = status;
    }

    const requests = await prisma.leaveRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        requester: { select: { id: true, name: true, role: true, department: true, avatarUrl: true } },
        reviewer: { select: { id: true, name: true, role: true } },
      },
    });

    res.json(requests);
  } catch (error) {
    console.error('Failed to get leave requests:', error);
    res.status(500).json({ error: 'Failed to retrieve leave requests' });
  }
});

// ─── POST /api/leave ─────────────────────────────────────────────────────────
// Employee or Project Owner can submit a leave request.
// CEO cannot use this endpoint (they have no leave workflow in this MVP).
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;

    if (user.role === 'CEO') {
      return res.status(403).json({ error: 'CEO does not submit leave requests in this system.' });
    }

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
        requester: { select: { id: true, name: true, role: true, department: true, avatarUrl: true } },
        reviewer: { select: { id: true, name: true, role: true } },
      },
    });

    // Notify CEO of new leave request
    try {
      const ceos = await prisma.user.findMany({ where: { role: 'CEO' } });
      for (const ceo of ceos) {
        await prisma.notification.create({
          data: {
            userId: ceo.id,
            title: 'New Leave Request',
            message: `${user.name} submitted a ${leaveType} request (${dayType || 'Full day'})`,
            type: 'LEAVE_REQUEST',
            linkUrl: '/alerts',
          },
        });
      }
    } catch (notifErr) {
      console.error('Failed to create leave request notification:', notifErr);
    }

    res.status(201).json(leave);
  } catch (error) {
    console.error('Failed to create leave request:', error);
    res.status(500).json({ error: 'Failed to submit leave request' });
  }
});

// ─── POST /api/leave/:id/decide ──────────────────────────────────────────────
// CEO only: Approve, Send Back, or Reject a leave request.
router.post('/:id/decide', requireAuth, requireCEO, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user!;
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
      return res.status(400).json({ error: 'A review note is required when sending back or rejecting.' });
    }

    const leave = await prisma.leaveRequest.findUnique({ where: { id } });

    if (!leave) {
      return res.status(404).json({ error: 'Leave request not found.' });
    }

    if (leave.status !== 'Pending') {
      return res.status(400).json({ error: `This request is already '${leave.status}'.` });
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
        requester: { select: { id: true, name: true, role: true, department: true, avatarUrl: true } },
        reviewer: { select: { id: true, name: true, role: true } },
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
// Employee / Project Owner: withdraw their own PENDING request.
const handleWithdraw = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user!;

    const leave = await prisma.leaveRequest.findUnique({ where: { id } });

    if (!leave) {
      return res.status(404).json({ error: 'Leave request not found.' });
    }

    // Only the requester (not the CEO) can withdraw
    if (leave.requestedBy !== user.id) {
      return res.status(403).json({ error: 'You can only withdraw your own leave requests.' });
    }

    if (leave.status !== 'Pending') {
      return res.status(400).json({ error: `Only pending requests can be withdrawn. This request is '${leave.status}'.` });
    }

    await prisma.leaveRequest.delete({ where: { id } });

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to withdraw leave request:', error);
    res.status(500).json({ error: 'Failed to withdraw leave request.' });
  }
};

router.post('/:id/withdraw', requireAuth, handleWithdraw);
router.delete('/:id/withdraw', requireAuth, handleWithdraw);
router.delete('/:id', requireAuth, handleWithdraw);

export default router;



