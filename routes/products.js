import express from 'express';
import { body, validationResult } from 'express-validator';
import { query } from '../config/database.js';
import { authenticateAdmin } from '../middlewares/auth.middleware.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { category, search } = req.query;
    let queryStr = 'SELECT * FROM products WHERE is_active = true';
    let params = [];
    let paramCount = 0;

    if (category) {
      paramCount++;
      queryStr += ` AND category = $${paramCount}`;
      params.push(category);
    }

    if (search) {
      paramCount++;
      queryStr += ` AND (name ILIKE $${paramCount} OR description ILIKE $${paramCount})`;
      params.push(`%${search}%`);
    }

    queryStr += ' ORDER BY name';
    // console.log(queryStr);
    const result = await query(queryStr, params);

    // console.log(result);
    res.status(201)
    .json({
      message:"product fetched successfully", 
      product: result.rows[0]
    });

  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const productId = req.params.id;

    const result = await query('SELECT * FROM products WHERE id = $1 AND is_active = true', [productId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({
      product: result.rows[0]
    });

  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', authenticateAdmin, [
  body('name').notEmpty().withMessage('Product name is required'),
  body('unit').notEmpty().withMessage('Unit is required'),
  body('price').isFloat({ min: 0 }).withMessage('Valid price is required'),
  body('stock_quantity').isFloat({ min: 0 }).withMessage('Valid stock quantity is required'),
  body('category').notEmpty().withMessage('Category is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, description, unit, price, stock_quantity, min_stock_level, category, expiry_date } = req.body;

    const result = await query(`
      INSERT INTO products (name, description, unit, price, stock_quantity, min_stock_level, category, expiry_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [name, description, unit, price, stock_quantity, min_stock_level || 0, category, expiry_date]);

    res.status(201).json({
      message: 'Product added successfully',
      product: result.rows[0]
    });

  } catch (error) {
    console.error('Add product error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', authenticateAdmin, [
  body('name').optional().notEmpty().withMessage('Product name cannot be empty'),
  body('unit').optional().notEmpty().withMessage('Unit cannot be empty'),
  body('price').optional().isFloat({ min: 0 }).withMessage('Valid price is required'),
  body('stock_quantity').optional().isFloat({ min: 0 }).withMessage('Valid stock quantity is required'),
  body('category').optional().notEmpty().withMessage('Category cannot be empty')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const productId = req.params.id;
    const { name, description, unit, price, stock_quantity, min_stock_level, category, expiry_date, is_active } = req.body;

    const result = await query(`
      UPDATE products 
      SET name = COALESCE($1, name),
          description = COALESCE($2, description),
          unit = COALESCE($3, unit),
          price = COALESCE($4, price),
          stock_quantity = COALESCE($5, stock_quantity),
          min_stock_level = COALESCE($6, min_stock_level),
          category = COALESCE($7, category),
          expiry_date = COALESCE($8, expiry_date),
          is_active = COALESCE($9, is_active),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $10
      RETURNING *
    `, [name, description, unit, price, stock_quantity, min_stock_level, category, expiry_date, is_active, productId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({
      message: 'Product updated successfully',
      product: result.rows[0]
    });

  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete product (admin only)
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const productId = req.params.id;

    // Check if product is being used in any orders
    const usageResult = await query(`
      SELECT COUNT(*) as usage_count
      FROM (
        SELECT product_id FROM daily_needs WHERE product_id = $1
        UNION ALL
        SELECT product_id FROM extra_orders WHERE product_id = $1
        UNION ALL
        SELECT product_id FROM order_items WHERE product_id = $1
      ) as usage
    `, [productId]);

    if (parseInt(usageResult.rows[0].usage_count) > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete product. It is being used in orders or daily needs.' 
      });
    }

    const result = await query('DELETE FROM products WHERE id = $1 RETURNING *', [productId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({
      message: 'Product deleted successfully',
      product: result.rows[0]
    });

  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get product categories
router.get('/categories/list', async (req, res) => {
  try {
    const result = await query('SELECT DISTINCT category FROM products WHERE is_active = true ORDER BY category');
    
    res.json({
      categories: result.rows.map(row => row.category)
    });

  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get low stock products (admin only)
router.get('/admin/low-stock', authenticateAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT * FROM products 
      WHERE is_active = true 
      AND stock_quantity <= min_stock_level
      ORDER BY stock_quantity ASC
    `);

    res.json({
      low_stock_products: result.rows
    });

  } catch (error) {
    console.error('Get low stock products error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update stock quantity (admin only)
router.put('/:id/stock', authenticateAdmin, [
  body('stock_quantity').isFloat({ min: 0 }).withMessage('Valid stock quantity is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const productId = req.params.id;
    const { stock_quantity } = req.body;

    const result = await query(`
      UPDATE products 
      SET stock_quantity = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
    `, [stock_quantity, productId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({
      message: 'Stock quantity updated successfully',
      product: result.rows[0]
    });

  } catch (error) {
    console.error('Update stock error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router; 