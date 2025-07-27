import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
const swaggerDocument = YAML.load('./docs/swagger.yaml');


// Load environment variables
dotenv.config();

console.log('🔧 Starting server initialization...');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

console.log('📦 Middleware loaded successfully');

// Database connection
import { query } from './config/database.js';

console.log('🗄️ Database module imported');

// Test database connection on startup
const testDatabaseConnection = async () => {
  console.log('🔍 Testing database connection...');
  try {
    const result = await query('SELECT NOW()');
    console.log('✅ Database connected successfully:', result.rows[0]);
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    console.log('Please check your database configuration in .env file');
    return false;
  }
};

// Routes
import vendorsRouter from './routes/vendors.js';
import adminRouter from './routes/admin.js';
import productsRouter from './routes/products.js';
import ordersRouter from './routes/orders.js';
import paymentsRouter from './routes/payments.js';
import notificationsRouter from './routes/notifications.js';
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.use('/api/vendors', vendorsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/products', productsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/notifications', notificationsRouter);

console.log('🛣️ Routes loaded successfully');

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'VendorCursor Backend is running!',
    timestamp: new Date().toISOString()
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('join-vendor', (vendorId) => {
    socket.join(`vendor-${vendorId}`);
    console.log(`Vendor ${vendorId} joined their room`);
  });
  
  socket.on('join-admin', () => {
    socket.join('admin-room');
    console.log('Admin joined admin room');
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Something went wrong!',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const PORT = process.env.PORT || 5000;

console.log('🚀 Starting server...');

// Start server with database test
server.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  
  console.log('🔍 Testing database connection...');
  // Test database connection
  const dbConnected = await testDatabaseConnection();
  
  if (dbConnected) {
    console.log('🎉 Server is fully operational!');
  } else {
    console.log('⚠️ Server started but database connection failed');
  }
});

export { app, io }; 