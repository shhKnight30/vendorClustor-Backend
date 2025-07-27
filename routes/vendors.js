import express from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../config/database.js';
import { authenticateVendor } from '../middlewares/auth.middleware.js';

const router = express.Router();

router.post('/register', [
  body('name').notEmpty().withMessage('Name is required'),
  body('phone').isMobilePhone().withMessage('Valid phone number is required'),
  body('email').optional().isEmail().withMessage('Valid email is required'),
  body('address').notEmpty().withMessage('Address is required'),
  body('city').notEmpty().withMessage('City is required'),
  body('state').notEmpty().withMessage('State is required'),
  body('pincode').notEmpty().withMessage('Pincode is required'),
  body('vendor_type').notEmpty().withMessage('Vendor type is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, phone, email, address, city, state, pincode, vendor_type, working_hours, language } = req.body;

    // Check if vendor already exists
    const existingVendor = await query('SELECT id FROM vendors WHERE phone = $1', [phone]);
    if (existingVendor.rows.length > 0) {
      return res.status(400).json({ error: 'Vendor with this phone number already exists' });
    }

    // Create new vendor
    const result = await query(`
      INSERT INTO vendors (name, phone, email, address, city, state, pincode, vendor_type, working_hours, language)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, name, phone, email, address, city, state, pincode, vendor_type, working_hours, language, created_at
    `, [name, phone, email, address, city, state, pincode, vendor_type, working_hours, language || 'en']);

    const vendor = result.rows[0];

    // Generate JWT token
    const token = jwt.sign(
      { vendorId: vendor.id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    
    console.log("registered successfully");
    res.status(201).json({
      message: 'Vendor registered successfully',
      vendor,
      token
    });

  } catch (error) {
    console.error('Vendor registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


router.post('/login', [
  body('phone').isMobilePhone().withMessage('Valid phone number is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { phone } = req.body;

    // Find vendor by phone
    const result = await query('SELECT * FROM vendors WHERE phone = $1 AND is_active = true', [phone]);
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Vendor not found' });
    }

    const vendor = result.rows[0];

    // Generate JWT token
    const token = jwt.sign(
      { vendorId: vendor.id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    console.log("login successfully");
    console.log(token);
    res.json({
      message: 'Login successful',
      vendor: {
        id: vendor.id,
        name: vendor.name,
        phone: vendor.phone,
        email: vendor.email,
        address: vendor.address,
        city: vendor.city,
        state: vendor.state,
        vendor_type: vendor.vendor_type,
        working_hours: vendor.working_hours,
        language: vendor.language,
        credit_limit: vendor.credit_limit
      },
      token
    });

  } catch (error) {
    console.error('Vendor login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/profile', authenticateVendor, async (req, res) => {
  try {
    res.json({
      vendor: req.vendor
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


router.put('/profile', authenticateVendor, [
  body('name').optional().notEmpty().withMessage('Name cannot be empty'),
  body('email').optional().isEmail().withMessage('Valid email is required'),
  body('address').optional().notEmpty().withMessage('Address cannot be empty'),
  body('working_hours').optional().notEmpty().withMessage('Working hours cannot be empty'),
  body('language').optional().isIn(['en', 'hi', 'mr', 'ta', 'bn']).withMessage('Invalid language')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, address, working_hours, language } = req.body;
    const vendorId = req.vendor.id;

    const result = await query(`
      UPDATE vendors 
      SET name = COALESCE($1, name),
          email = COALESCE($2, email),
          address = COALESCE($3, address),
          working_hours = COALESCE($4, working_hours),
          language = COALESCE($5, language),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `, [name, email, address, working_hours, language, vendorId]);

    res.json({
      message: 'Profile updated successfully',
      vendor: result.rows[0]
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


router.get('/daily-needs', authenticateVendor, async (req, res) => {
  try {
    const vendorId = req.vendor.id;
    
    const result = await query(`
      SELECT dn.*, p.name as product_name, p.unit, p.price
      FROM daily_needs dn
      JOIN products p ON dn.product_id = p.id
      WHERE dn.vendor_id = $1 AND p.is_active = true
      ORDER BY p.name
    `, [vendorId]);

    res.json({
      daily_needs: result.rows
    });

  } catch (error) {
    console.error('Get daily needs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/daily-needs', authenticateVendor, [
  body('daily_needs').isArray().withMessage('Daily needs must be an array'),
  body('daily_needs.*.product_id').isInt().withMessage('Valid product ID is required'),
  body('daily_needs.*.quantity').isFloat({ min: 0.1 }).withMessage('Valid quantity is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const vendorId = req.vendor.id;
    const { daily_needs } = req.body;

    // Delete existing daily needs
    await query('DELETE FROM daily_needs WHERE vendor_id = $1', [vendorId]);

    // Insert new daily needs
    for (const need of daily_needs) {
      await query(`
        INSERT INTO daily_needs (vendor_id, product_id, quantity)
        VALUES ($1, $2, $3)
      `, [vendorId, need.product_id, need.quantity]);
    }

    res.json({
      message: 'Daily needs updated successfully'
    });

  } catch (error) {
    console.error('Set daily needs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/extra-orders', authenticateVendor, [
  body('product_id').isInt().withMessage('Valid product ID is required'),
  body('quantity').isFloat({ min: 0.1 }).withMessage('Valid quantity is required'),
  body('order_date').isDate().withMessage('Valid date is required'),
  body('notes').optional().isString().withMessage('Notes must be a string')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const vendorId = req.vendor.id;
    const { product_id, quantity, order_date, notes } = req.body;

    const result = await query(`
      INSERT INTO extra_orders (vendor_id, product_id, quantity, order_date, notes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [vendorId, product_id, quantity, order_date, notes]);

    res.status(201).json({
      message: 'Extra order added successfully',
      extra_order: result.rows[0]
    });

  } catch (error) {
    console.error('Add extra order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/cancel-order', authenticateVendor, [
  body('cancel_date').isDate().withMessage('Valid date is required'),
  body('reason').optional().isString().withMessage('Reason must be a string')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const vendorId = req.vendor.id;
    const { cancel_date, reason } = req.body;

    const result = await query(`
      INSERT INTO cancelled_orders (vendor_id, cancel_date, reason)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [vendorId, cancel_date, reason]);

    res.status(201).json({
      message: 'Order cancelled successfully',
      cancelled_order: result.rows[0]
    });

  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/orders', authenticateVendor, async (req, res) => {
  try {
    const vendorId = req.vendor.id;
    const { page = 1, limit = 10, status } = req.query;
    const offset = (page - 1) * limit;

    let queryStr = `
      SELECT o.*, 
             COUNT(oi.id) as item_count
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.vendor_id = $1
    `;
    let params = [vendorId];
    let paramCount = 1;

    if (status) {
      paramCount++;
      queryStr += ` AND o.status = $${paramCount}`;
      params.push(status);
    }

    queryStr += ` GROUP BY o.id ORDER BY o.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);

    const result = await query(queryStr, params);

    res.json({
      orders: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: result.rows.length
      }
    });

  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/notifications', authenticateVendor, async (req, res) => {
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

router.put('/notifications/:id/read', authenticateVendor, async (req, res) => {
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

export default router; 