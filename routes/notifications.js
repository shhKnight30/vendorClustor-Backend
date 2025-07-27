import express from 'express';
import { body, validationResult } from 'express-validator';
import { query } from '../config/database.js';
import { authenticateAdmin } from '../middlewares/auth.middleware.js';
import { authenticateVendor } from '../middlewares/auth.middleware.js';

const router = express.Router();

router.get('/vendor', authenticateVendor, async (req, res) => {
  try {
    const vendorId = req.vendor.id;
    const { page = 1, limit = 20, unread_only = false } = req.query;
    const offset = (page - 1) * limit;

    let queryStr = `
      SELECT * FROM notifications 
      WHERE vendor_id = $1
    `;
    let params = [vendorId];

    if (unread_only === 'true') {
      queryStr += ` AND is_read = false`;
    }

    queryStr += ` ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
    params.push(limit, offset);

    const result = await query(queryStr, params);

    res.json({
      notifications: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: result.rows.length
      }
    });

  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/vendor/:id/read', authenticateVendor, async (req, res) => {
  try {
    const vendorId = req.vendor.id;
    const notificationId = req.params.id;

    const result = await query(`
      UPDATE notifications 
      SET is_read = true 
      WHERE id = $1 AND vendor_id = $2
      RETURNING *
    `, [notificationId, vendorId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json({
      message: 'Notification marked as read',
      notification: result.rows[0]
    });

  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark all notifications as read
router.put('/vendor/read-all', authenticateVendor, async (req, res) => {
  try {
    const vendorId = req.vendor.id;

    const result = await query(`
      UPDATE notifications 
      SET is_read = true 
      WHERE vendor_id = $1 AND is_read = false
      RETURNING COUNT(*) as updated_count
    `, [vendorId]);

    res.json({
      message: 'All notifications marked as read',
      updated_count: parseInt(result.rows[0].updated_count)
    });

  } catch (error) {
    console.error('Mark all notifications read error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get unread notification count
router.get('/vendor/unread-count', authenticateVendor, async (req, res) => {
  try {
    const vendorId = req.vendor.id;

    const result = await query(`
      SELECT COUNT(*) as unread_count
      FROM notifications 
      WHERE vendor_id = $1 AND is_read = false
    `, [vendorId]);

    res.json({
      unread_count: parseInt(result.rows[0].unread_count)
    });

  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});



// Send notification to vendor (admin)
router.post('/admin/send', authenticateAdmin, [
  body('vendor_id').isInt().withMessage('Valid vendor ID is required'),
  body('type').notEmpty().withMessage('Notification type is required'),
  body('title').notEmpty().withMessage('Notification title is required'),
  body('message').notEmpty().withMessage('Notification message is required'),
  body('sent_via').optional().isIn(['app', 'email', 'sms', 'whatsapp']).withMessage('Invalid sent_via value')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { vendor_id, type, title, message, sent_via = 'app' } = req.body;

    // Verify vendor exists
    const vendorResult = await query('SELECT id FROM vendors WHERE id = $1 AND is_active = true', [vendor_id]);
    if (vendorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    const result = await query(`
      INSERT INTO notifications (vendor_id, type, title, message, sent_via)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [vendor_id, type, title, message, sent_via]);

    res.status(201).json({
      message: 'Notification sent successfully',
      notification: result.rows[0]
    });

  } catch (error) {
    console.error('Send notification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send bulk notifications (admin)
router.post('/admin/send-bulk', authenticateAdmin, [
  body('vendor_ids').isArray().withMessage('Vendor IDs must be an array'),
  body('type').notEmpty().withMessage('Notification type is required'),
  body('title').notEmpty().withMessage('Notification title is required'),
  body('message').notEmpty().withMessage('Notification message is required'),
  body('sent_via').optional().isIn(['app', 'email', 'sms', 'whatsapp']).withMessage('Invalid sent_via value')
], async (req, res) => {
  try {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { vendor_ids, type, title, message, sent_via = 'app' } = req.body;

    const notifications = [];
    for (const vendorId of vendor_ids) {
      // Verify vendor exists
      const vendorResult = await query('SELECT id FROM vendors WHERE id = $1 AND is_active = true', [vendorId]);
      if (vendorResult.rows.length > 0) {
        const result = await query(`
          INSERT INTO notifications (vendor_id, type, title, message, sent_via)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `, [vendorId, type, title, message, sent_via]);

        notifications.push(result.rows[0]);
      }
    }

    res.status(201).json({
      message: `Sent ${notifications.length} notifications successfully`,
      notifications
    });

  } catch (error) {
    console.error('Send bulk notifications error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all notifications (admin)
router.get('/admin/all', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, vendor_id, type, is_read } = req.query;
    const offset = (page - 1) * limit;

    let queryStr = `
      SELECT n.*, v.name as vendor_name, v.phone as vendor_phone
      FROM notifications n
      JOIN vendors v ON n.vendor_id = v.id
      WHERE 1=1
    `;
    let params = [];
    let paramCount = 0;

    if (vendor_id) {
      paramCount++;
      queryStr += ` AND n.vendor_id = $${paramCount}`;
      params.push(vendor_id);
    }

    if (type) {
      paramCount++;
      queryStr += ` AND n.type = $${paramCount}`;
      params.push(type);
    }

    if (is_read === 'true') {
      queryStr += ` AND n.is_read = true`;
    } else if (is_read === 'false') {
      queryStr += ` AND n.is_read = false`;
    }

    queryStr += ` ORDER BY n.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);

    const result = await query(queryStr, params);

    res.json({
      notifications: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: result.rows.length
      }
    });

  } catch (error) {
    console.error('Get all notifications error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router; 