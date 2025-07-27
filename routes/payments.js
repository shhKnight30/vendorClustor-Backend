import express from 'express';
import { body, validationResult } from 'express-validator';
import { query } from '../config/database.js';
import { authenticateAdmin } from '../middlewares/auth.middleware.js';
import { authenticateVendor } from '../middlewares/auth.middleware.js';

const router = express.Router();

// Get vendor's payment history
router.get('/history', authenticateVendor, async (req, res) => {
  try {
    const vendorId = req.vendor.id;
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;

    let queryStr = `
      SELECT p.*, o.order_date, o.total_amount as order_amount
      FROM payments p
      LEFT JOIN orders o ON p.order_id = o.id
      WHERE p.vendor_id = $1
    `;
    let params = [vendorId];
    let paramCount = 1;

    if (status) {
      paramCount++;
      queryStr += ` AND p.payment_status = $${paramCount}`;
      params.push(status);
    }

    queryStr += ` ORDER BY p.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);

    const result = await query(queryStr, params);

    res.json({
      payments: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: result.rows.length
      }
    });

  } catch (error) {
    console.error('Get payment history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get payment summary
router.get('/summary', authenticateVendor, async (req, res) => {
  try {
    const vendorId = req.vendor.id;

    const result = await query(`
      SELECT 
        SUM(CASE WHEN payment_status = 'pending' THEN amount ELSE 0 END) as pending_amount,
        SUM(CASE WHEN payment_status = 'completed' THEN amount ELSE 0 END) as completed_amount,
        COUNT(CASE WHEN payment_status = 'pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN payment_status = 'completed' THEN 1 END) as completed_count
      FROM payments 
      WHERE vendor_id = $1
    `, [vendorId]);

    res.json({
      summary: result.rows[0]
    });

  } catch (error) {
    console.error('Get payment summary error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/admin/all', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, vendor_id } = req.query;
    const offset = (page - 1) * limit;

    let queryStr = `
      SELECT p.*, v.name as vendor_name, v.phone as vendor_phone,
             o.order_date, o.total_amount as order_amount
      FROM payments p
      JOIN vendors v ON p.vendor_id = v.id
      LEFT JOIN orders o ON p.order_id = o.id
      WHERE 1=1
    `;
    let params = [];
    let paramCount = 0;

    if (status) {
      paramCount++;
      queryStr += ` AND p.payment_status = $${paramCount}`;
      params.push(status);
    }

    if (vendor_id) {
      paramCount++;
      queryStr += ` AND p.vendor_id = $${paramCount}`;
      params.push(vendor_id);
    }

    queryStr += ` ORDER BY p.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);

    const result = await query(queryStr, params);

    res.json({
      payments: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: result.rows.length
      }
    });

  } catch (error) {
    console.error('Get all payments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Update payment status (admin)
router.put('/admin/:id/status', authenticateAdmin, [
  body('payment_status').isIn(['pending', 'completed', 'failed']).withMessage('Invalid payment status'),
  body('notes').optional().isString().withMessage('Notes must be a string')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const paymentId = req.params.id;
    const { payment_status, notes } = req.body;

    const result = await query(`
      UPDATE payments 
      SET payment_status = $1, notes = COALESCE($2, notes), payment_date = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [payment_status, notes, paymentId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    res.json({
      message: 'Payment status updated successfully',
      payment: result.rows[0]
    });

  } catch (error) {
    console.error('Update payment status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router; 