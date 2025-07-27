import jwt from 'jsonwebtoken';
import { query } from '../config/database.js';

export const authenticateAdmin = async (req, res, next) => {
    try {
      const token = req.header('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
      }
  
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const result = await query('SELECT * FROM staff WHERE id = $1 AND is_active = true', [decoded.staffId]);
      
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid token.' });
      }
  
      req.staff = result.rows[0];
      next();
    } catch (error) {
      res.status(401).json({ error: 'Invalid token.' });
    }
  };


export const authenticateVendor = async (req, res, next) => {
    try {
      const token = req.header('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
      }
  
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const result = await query('SELECT * FROM vendors WHERE id = $1 AND is_active = true', [decoded.vendorId]);
      
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid token.' });
      }
  
      req.vendor = result.rows[0];
      next();
    } catch (error) {
      res.status(401).json({ error: 'Invalid token.' });
    }
  };
  
