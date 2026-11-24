import { Router, Response } from 'express';
import {
  AuthRequest,
  requireAuth,
  requireUnrestricted,
} from '../auth.js';
import {
  getConfigurations,
  createConfiguration,
  getTargetUserPermissions,
  updateUserPermissions,
  PermissionServiceError,
} from '../services/permissionService.js';

const router = Router();

// GET /api/permissions/configurations — List all configuration permission keys
router.get('/configurations', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const configurations = await getConfigurations();
    res.json(configurations);
  } catch (error: any) {
    if (error instanceof PermissionServiceError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Error fetching configurations:', error);
    res.status(500).json({ error: 'Failed to fetch configurations' });
  }
});

// POST /api/permissions/configurations — Create new configuration key (restricted to unrestricted executive)
router.post('/configurations', requireAuth, requireUnrestricted, async (req: AuthRequest, res: Response) => {
  try {
    const { name, key } = req.body || {};
    const created = await createConfiguration(req.user, { name, key });
    res.status(201).json(created);
  } catch (error: any) {
    if (error instanceof PermissionServiceError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Error creating configuration:', error);
    res.status(500).json({ error: 'Failed to create configuration' });
  }
});

// GET /api/permissions/users/:userId — Get permissions for target user with toggle permissions for actor
router.get('/users/:userId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await getTargetUserPermissions(req.user, req.params.userId);
    res.json(result);
  } catch (error: any) {
    if (error instanceof PermissionServiceError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Error fetching user permissions:', error);
    res.status(500).json({ error: 'Failed to fetch user permissions' });
  }
});

// PUT /api/permissions/users/:userId — Update target user permissions
router.put('/users/:userId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body || {};
    let updates: Array<{ key: string; isEnabled: boolean }> = [];

    if (Array.isArray(body.updates)) {
      updates = body.updates;
    } else if (typeof body.key === 'string') {
      updates = [{ key: body.key, isEnabled: Boolean(body.isEnabled) }];
    } else {
      return res.status(400).json({ error: 'Invalid payload: provide "updates" array or { key, isEnabled }' });
    }

    const result = await updateUserPermissions(req.user, req.params.userId, updates);
    res.json(result);
  } catch (error: any) {
    if (error instanceof PermissionServiceError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Error updating user permissions:', error);
    res.status(500).json({ error: 'Failed to update user permissions' });
  }
});

export default router;
