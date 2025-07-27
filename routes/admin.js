import express from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../config/database.js';
import { authenticateAdmin } from '../middlewares/auth.middleware.js';

const router = express.Router();

router.post('/register', [
  body('id'),
  body('name'),
  body('email').isEmail(),
  body('phone'),
  body('password'),
  body('role'),
  body('birthday'),
  body('is_active')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { id, name, email, phone, password, role, birthday, is_active } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await query(`
      INSERT INTO staff . VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ) RETURNING *;
    `, [id, name, email, phone, hashedPassword, role, birthday, is_active]);
    console.log("Registered successfully:", result.rows[0]);
    res.status(201).json({
      message: 'Admin registered successfully',
      admin: result.rows[0]
    });

  } catch (error) {
    console.error('Admin registration error: ', error)
    res.status(500).json({ error: 'Internal server error' });
  }
})

router.post('/login', [
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    const result = await query('SELECT * FROM staff WHERE email = $1 AND is_active = true', [email]);
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const staff = result.rows[0];

    const isValidPassword = await bcrypt.compare(password, staff.password_hash);
    if (!isValidPassword) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    
    const token = jwt.sign(
      { staffId: staff.id, role: staff.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    console.log(token);
    res.json({
      message: 'Login successful',
      staff: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role
      },
      token
    });

  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/daily-packing', authenticateAdmin, async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    const dailyNeedsResult = await query(`
      SELECT 
        p.name as product_name,
        p.unit,
        p.price,
        SUM(dn.quantity) as total_quantity,
        COUNT(DISTINCT dn.vendor_id) as vendor_count,
        ARRAY_AGG(DISTINCT v.name) as vendor_names
      FROM daily_needs dn
      JOIN products p ON dn.product_id = p.id
      JOIN vendors v ON dn.vendor_id = v.id
      WHERE p.is_active = true AND v.is_active = true
      GROUP BY p.id, p.name, p.unit, p.price
      ORDER BY p.name
    `);

    const extraOrdersResult = await query(`
      SELECT 
        p.name as product_name,
        p.unit,
        p.price,
        SUM(eo.quantity) as total_quantity,
        COUNT(DISTINCT eo.vendor_id) as vendor_count,
        ARRAY_AGG(DISTINCT v.name) as vendor_names
      FROM extra_orders eo
      JOIN products p ON eo.product_id = p.id
      JOIN vendors v ON eo.vendor_id = v.id
      WHERE eo.order_date = $1 AND p.is_active = true AND v.is_active = true
      GROUP BY p.id, p.name, p.unit, p.price
      ORDER BY p.name
    `, [targetDate]);

    const cancelledOrdersResult = await query(`
      SELECT 
        v.name as vendor_name,
        co.reason
      FROM cancelled_orders co
      JOIN vendors v ON co.vendor_id = v.id
      WHERE co.cancel_date = $1 AND v.is_active = true
    `, [targetDate]);

    const packingList = {};
    

    dailyNeedsResult.rows.forEach(item => {
      packingList[item.product_name] = {
        product_name: item.product_name,
        unit: item.unit,
        price: item.price,
        daily_quantity: item.total_quantity,
        extra_quantity: 0,
        total_quantity: item.total_quantity,
        vendor_count: item.vendor_count,
        vendor_names: item.vendor_names
      };
    });


    extraOrdersResult.rows.forEach(item => {
      if (packingList[item.product_name]) {
        packingList[item.product_name].extra_quantity += item.total_quantity;
        packingList[item.product_name].total_quantity += item.total_quantity;
        packingList[item.product_name].vendor_count += item.vendor_count;
        packingList[item.product_name].vendor_names = [
          ...packingList[item.product_name].vendor_names,
          ...item.vendor_names
        ];
      } else {
        packingList[item.product_name] = {
          product_name: item.product_name,
          unit: item.unit,
          price: item.price,
          daily_quantity: 0,
          extra_quantity: item.total_quantity,
          total_quantity: item.total_quantity,
          vendor_count: item.vendor_count,
          vendor_names: item.vendor_names
        };
      }
    });

    res.json({
      date: targetDate,
      packing_list: Object.values(packingList),
      cancelled_orders: cancelledOrdersResult.rows,
      summary: {
        total_products: Object.keys(packingList).length,
        total_vendors: new Set(Object.values(packingList).flatMap(item => item.vendor_names)).size,
        cancelled_vendors: cancelledOrdersResult.rows.length
      }
    });

  } catch (error) {
    console.error('Get daily packing list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


router.get('/vendors', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    const offset = (page - 1) * limit;

    let queryStr = 'SELECT * FROM vendors WHERE 1=1';
    let params = [];
    let paramCount = 0;

    if (search) {
      paramCount++;
      queryStr += ` AND (name ILIKE $${paramCount} OR phone ILIKE $${paramCount} OR city ILIKE $${paramCount})`;
      params.push(`%${search}%`);
    }

    if (status === 'active') {
      paramCount++;
      queryStr += ` AND is_active = true`;
    } else if (status === 'inactive') {
      paramCount++;
      queryStr += ` AND is_active = false`;
    }

    const countResult = await query(queryStr, params);
    const total = countResult.rows.length;

    paramCount++;
    queryStr += `ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await query(queryStr, params);

    res.json({
      vendors: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Get vendors error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


router.get('/vendors/:id', authenticateAdmin, async (req, res) => {
  try {
    const vendorId = req.params.id;

    const result = await query(`
      SELECT v.*,
             COUNT(DISTINCT o.id) as total_orders,
             COUNT(DISTINCT dn.product_id) as daily_needs_count,
             SUM(p.amount) as total_payments
      FROM vendors v
      LEFT JOIN orders o ON v.id = o.vendor_id
      LEFT JOIN daily_needs dn ON v.id = dn.vendor_id
      LEFT JOIN payments p ON v.id = p.vendor_id
      WHERE v.id = $1
      GROUP BY v.id
    `, [vendorId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    res.json({
      vendor: result.rows[0]
    });

  } catch (error) {
    console.error('Get vendor details error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


router.put('/vendors/:id/status', authenticateAdmin, [
  body('is_active').isBoolean().withMessage('is_active must be a boolean')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const vendorId = req.params.id;
    const { is_active } = req.body;

    const result = await query(`
      UPDATE vendors 
      SET is_active = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
    `, [is_active, vendorId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    res.json({
      message: 'Vendor status updated successfully',
      vendor: result.rows[0]
    });

  } catch (error) {
    console.error('Update vendor status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/returns', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;

    let queryStr = `
      SELECT rr.*, v.name as vendor_name, v.phone as vendor_phone,
             p.name as product_name, p.unit
      FROM return_requests rr
      JOIN vendors v ON rr.vendor_id = v.id
      JOIN products p ON rr.product_id = p.id
      WHERE 1=1
    `;
    let params = [];
    let paramCount = 0;
    if (status) {
      paramCount++;
      queryStr += ` AND rr.status = $${paramCount}`;
      params.push(status);
    }
    queryStr += ` ORDER BY rr.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);
    const result = await query(queryStr, params);
    res.json({
      returns: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: result.rows.length
      }
    });
  } catch (error) {
    console.error('Get returns error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/returns/:id/process', authenticateAdmin, [
  body('status').isIn(['approved', 'rejected']).withMessage('Status must be approved or rejected'),
  body('notes').optional().isString().withMessage('Notes must be a string')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const returnId = req.params.id;
    const { status, notes } = req.body;

    const result = await query(`
      UPDATE return_requests 
      SET status = $1, notes = COALESCE($2, notes), updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [status, notes, returnId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Return request not found' });
    }

    res.json({
      message: 'Return request processed successfully',
      return_request: result.rows[0]
    });

  } catch (error) {
    console.error('Process return error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


router.get('/analytics', authenticateAdmin, async (req, res) => {
  try {
    const { period = 'month' } = req.query;
    const now = new Date();
    let startDate;

    switch (period) {
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'year':
        startDate = new Date(now.getFullYear(), 0, 1);
        break;
      default:
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const vendorsResult = await query('SELECT COUNT(*) as total FROM vendors WHERE is_active = true');
    const totalVendors = vendorsResult.rows[0].total;

    const ordersResult = await query(`
      SELECT COUNT(*) as total, SUM(total_amount) as revenue
      FROM orders 
      WHERE created_at >= $1
    `, [startDate]);
    const totalOrders = ordersResult.rows[0].total;
    const totalRevenue = ordersResult.rows[0].revenue || 0;

    const topProductsResult = await query(`
      SELECT p.name, COUNT(oi.id) as order_count, SUM(oi.quantity) as total_quantity
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at >= $1
      GROUP BY p.id, p.name
      ORDER BY total_quantity DESC
      LIMIT 10
    `, [startDate]);


    const topVendorsResult = await query(`
      SELECT v.name, COUNT(o.id) as order_count, SUM(o.total_amount) as total_spent
      FROM orders o
      JOIN vendors v ON o.vendor_id = v.id
      WHERE o.created_at >= $1
      GROUP BY v.id, v.name
      ORDER BY total_spent DESC
      LIMIT 10
    `, [startDate]);

    res.json({
      period,
      summary: {
        total_vendors: totalVendors,
        total_orders: totalOrders,
        total_revenue: totalRevenue
      },
      top_products: topProductsResult.rows,
      top_vendors: topVendorsResult.rows
    });

  } catch (error) {
    console.error('Get analytics error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router; 