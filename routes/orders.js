import express from 'express';
import { body, validationResult } from 'express-validator';
import { query } from '../config/database.js';
import { authenticateAdmin } from '../middlewares/auth.middleware.js';
import { authenticateVendor } from '../middlewares/auth.middleware.js';
const router = express.Router();


router.get('/:id', authenticateVendor, async (req, res) => {
  try {
    const orderId = req.params.id;
    const vendorId = req.vendor.id;

    // Get order details
    const orderResult = await query(`
      SELECT * FROM orders 
      WHERE id = $1 AND vendor_id = $2
    `, [orderId, vendorId]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Get order items
    const itemsResult = await query(`
      SELECT oi.*, p.name as product_name, p.unit
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = $1
    `, [orderId]);

    res.json({
      order: orderResult.rows[0],
      items: itemsResult.rows
    });

  } catch (error) {
    console.error('Get order details error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create return request
router.post('/:id/return', authenticateVendor, [
  body('items').isArray().withMessage('Items must be an array'),
  body('items.*.product_id').isInt().withMessage('Valid product ID is required'),
  body('items.*.quantity').isFloat({ min: 0.1 }).withMessage('Valid quantity is required'),
  body('return_date').isDate().withMessage('Valid return date is required'),
  body('reason').optional().isString().withMessage('Reason must be a string')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const orderId = req.params.id;
    const vendorId = req.vendor.id;
    const { items, return_date, reason } = req.body;

    // Verify order belongs to vendor
    const orderResult = await query('SELECT * FROM orders WHERE id = $1 AND vendor_id = $2', [orderId, vendorId]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Create return requests for each item
    const returnRequests = [];
    for (const item of items) {
      const result = await query(`
        INSERT INTO return_requests (vendor_id, product_id, quantity, return_date, reason)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [vendorId, item.product_id, item.quantity, return_date, reason]);

      returnRequests.push(result.rows[0]);
    }

    res.status(201).json({
      message: 'Return request created successfully',
      return_requests: returnRequests
    });

  } catch (error) {
    console.error('Create return request error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all orders (admin)
router.get('/admin/all', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, date, vendor_id } = req.query;
    const offset = (page - 1) * limit;

    let queryStr = `
      SELECT o.*, v.name as vendor_name, v.phone as vendor_phone,
             COUNT(oi.id) as item_count
      FROM orders o
      JOIN vendors v ON o.vendor_id = v.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE 1=1
    `;
    let params = [];
    let paramCount = 0;

    if (status) {
      paramCount++;
      queryStr += ` AND o.status = $${paramCount}`;
      params.push(status);
    }

    if (date) {
      paramCount++;
      queryStr += ` AND o.order_date = $${paramCount}`;
      params.push(date);
    }

    if (vendor_id) {
      paramCount++;
      queryStr += ` AND o.vendor_id = $${paramCount}`;
      params.push(vendor_id);
    }

    queryStr += ` GROUP BY o.id, v.name, v.phone ORDER BY o.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
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
    console.error('Get all orders error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get order details (admin)
router.get('/admin/:id', authenticateAdmin, async (req, res) => {
  try {
    const orderId = req.params.id;

    // Get order details
    const orderResult = await query(`
      SELECT o.*, v.name as vendor_name, v.phone as vendor_phone, v.address as vendor_address
      FROM orders o
      JOIN vendors v ON o.vendor_id = v.id
      WHERE o.id = $1
    `, [orderId]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Get order items
    const itemsResult = await query(`
      SELECT oi.*, p.name as product_name, p.unit, p.price as current_price
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = $1
    `, [orderId]);

    res.json({
      order: orderResult.rows[0],
      items: itemsResult.rows
    });

  } catch (error) {
    console.error('Get order details error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update order status (admin)
router.put('/admin/:id/status', authenticateAdmin, [
  body('status').isIn(['pending', 'processing', 'out_for_delivery', 'delivered', 'cancelled']).withMessage('Invalid status'),
  body('notes').optional().isString().withMessage('Notes must be a string')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const orderId = req.params.id;
    const { status, notes } = req.body;

    const result = await query(`
      UPDATE orders 
      SET status = $1, notes = COALESCE($2, notes), updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [status, notes, orderId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({
      message: 'Order status updated successfully',
      order: result.rows[0]
    });

  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Generate daily orders (admin - cron job)
router.post('/admin/generate-daily', authenticateAdmin, async (req, res) => {
  try {
    const { target_date } = req.body;
    const orderDate = target_date || new Date().toISOString().split('T')[0];

    // Get all active vendors with daily needs
    const vendorsResult = await query(`
      SELECT DISTINCT v.id, v.name, v.address
      FROM vendors v
      JOIN daily_needs dn ON v.id = dn.vendor_id
      WHERE v.is_active = true
    `);
    const generatedOrders = [];
    for (const vendor of vendorsResult.rows) {
      // Check if order is cancelled for this date
      const cancelledResult = await query(`
        SELECT id FROM cancelled_orders 
        WHERE vendor_id = $1 AND cancel_date = $2
      `, [vendor.id, orderDate]);

      if (cancelledResult.rows.length > 0) {
        continue; // Skip this vendor for this date
      }
      // Get vendor's daily needs
      const dailyNeedsResult = await query(`
        SELECT dn.*, p.name as product_name, p.price, p.unit
        FROM daily_needs dn
        JOIN products p ON dn.product_id = p.id
        WHERE dn.vendor_id = $1 AND p.is_active = true
      `, [vendor.id]);

      if (dailyNeedsResult.rows.length === 0) {
        continue
      }
      // Calculate total amount
      let totalAmount = 0;
      const orderItems = [];

      for (const need of dailyNeedsResult.rows) {
        const itemTotal = need.quantity * need.price;
        totalAmount += itemTotal;
        orderItems.push({
          product_id: need.product_id,
          quantity: need.quantity,
          unit_price: need.price,
          total_price: itemTotal
        });
      }

      // Get extra orders for this date
      const extraOrdersResult = await query(`
        SELECT eo.*, p.name as product_name, p.price, p.unit
        FROM extra_orders eo
        JOIN products p ON eo.product_id = p.id
        WHERE eo.vendor_id = $1 AND eo.order_date = $2 AND p.is_active = true
      `, [vendor.id, orderDate]);

      for (const extra of extraOrdersResult.rows) {
        const itemTotal = extra.quantity * extra.price;
        totalAmount += itemTotal;
        orderItems.push({
          product_id: extra.product_id,
          quantity: extra.quantity,
          unit_price: extra.price,
          total_price: itemTotal
        });
      }

      // Create order
      const orderResult = await query(`
        INSERT INTO orders (vendor_id, order_date, total_amount, status, delivery_address)
        VALUES ($1, $2, $3, 'pending', $4)
        RETURNING *
      `, [vendor.id, orderDate, totalAmount, vendor.address]);

      const order = orderResult.rows[0];

      // Create order items
      for (const item of orderItems) {
        await query(`
          INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_price)
          VALUES ($1, $2, $3, $4, $5)
        `, [order.id, item.product_id, item.quantity, item.unit_price, item.total_price]);
      }

      generatedOrders.push({
        order_id: order.id,
        vendor_name: vendor.name,
        total_amount: totalAmount,
        item_count: orderItems.length
      });
    }

    res.json({
      message: `Generated ${generatedOrders.length} orders for ${orderDate}`,
      generated_orders: generatedOrders
    });

  } catch (error) {
    console.error('Generate daily orders error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router; 