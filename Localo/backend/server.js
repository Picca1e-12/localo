// server.js - Optimized backend server for Localo
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();

// Configuration
const CONFIG = {
  port: process.env.PORT || 3001,
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  inactiveThreshold: 5 * 60 * 1000, // 5 minutes in ms
  cleanupInterval: 60 * 1000, // 1 minute in ms
  historyLimit: 100,
  db: {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'localo',
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  }
};

// Middleware
app.use(cors({ origin: CONFIG.clientUrl, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Request logging in development
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.path} - ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });
}

// MySQL connection pool with optimizations
let pool;

async function initializeDatabase() {
  try {
    pool = mysql.createPool(CONFIG.db);
    
    // Test connection
    const connection = await pool.getConnection();
    console.log('✅ MySQL connected successfully');
    connection.release();

    // Create tables with optimized indexes
    await createTables();
    
    // Start cleanup task
    startCleanupTask();
  } catch (error) {
    console.error('❌ MySQL connection error:', error.message);
    console.log('⚠️  Running in-memory mode only');
  }
}

// Optimized table creation with better indexes
async function createTables() {
  const queries = [
    `CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      latitude DECIMAL(10, 8),
      longitude DECIMAL(11, 8),
      address VARCHAR(512),
      is_tracking BOOLEAN DEFAULT FALSE,
      last_seen TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY idx_user_id (user_id),
      KEY idx_tracking_lookup (is_tracking, last_seen),
      KEY idx_last_seen (last_seen)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC`,
    
    `CREATE TABLE IF NOT EXISTS location_history (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      latitude DECIMAL(10, 8) NOT NULL,
      longitude DECIMAL(11, 8) NOT NULL,
      address VARCHAR(512),
      tracked_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_user_time (user_id, tracked_at DESC),
      KEY idx_tracked_at (tracked_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC 
    PARTITION BY RANGE (UNIX_TIMESTAMP(tracked_at)) (
      PARTITION p0 VALUES LESS THAN (UNIX_TIMESTAMP('2025-01-01 00:00:00')),
      PARTITION p1 VALUES LESS THAN (UNIX_TIMESTAMP('2026-01-01 00:00:00')),
      PARTITION p2 VALUES LESS THAN MAXVALUE
    )`
  ];

  for (const query of queries) {
    try {
      await pool.query(query);
    } catch (error) {
      if (!error.message.includes('already exists')) {
        console.error('Table creation error:', error.message);
      }
    }
  }
  console.log('✅ Database tables verified');
}

// In-memory cache with TTL
class LocationCache {
  constructor(ttl = 60000) {
    this.cache = new Map();
    this.ttl = ttl;
  }

  set(key, value) {
    this.cache.set(key, {
      data: value,
      timestamp: Date.now()
    });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return item.data;
  }

  delete(key) {
    this.cache.delete(key);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }

  size() {
    this.cleanup();
    return this.cache.size;
  }

  getAll() {
    this.cleanup();
    const result = {};
    for (const [key, value] of this.cache.entries()) {
      result[key] = value.data;
    }
    return result;
  }
}

const locationCache = new LocationCache(3000); // 3 second cache

// Optimized database queries using prepared statements
const queries = {
  upsertUser: `
    INSERT INTO users (user_id, latitude, longitude, address, is_tracking, last_seen)
    VALUES (?, ?, ?, ?, ?, NOW(3))
    ON DUPLICATE KEY UPDATE
      latitude = VALUES(latitude),
      longitude = VALUES(longitude),
      address = VALUES(address),
      is_tracking = VALUES(is_tracking),
      last_seen = NOW(3)`,
  
  insertHistory: `
    INSERT INTO location_history (user_id, latitude, longitude, address)
    VALUES (?, ?, ?, ?)`,
  
  getActiveUsers: `
    SELECT user_id, latitude, longitude, address, is_tracking, 
           UNIX_TIMESTAMP(last_seen) as last_seen_ts
    FROM users
    WHERE is_tracking = TRUE 
      AND last_seen > DATE_SUB(NOW(3), INTERVAL ? SECOND)
      AND latitude IS NOT NULL 
      AND longitude IS NOT NULL`,
  
  stopTracking: `
    UPDATE users 
    SET is_tracking = FALSE, last_seen = NOW(3) 
    WHERE user_id = ?`,
  
  updateHeartbeat: `
    UPDATE users 
    SET last_seen = NOW(3) 
    WHERE user_id = ?`,
  
  cleanupInactive: `
    UPDATE users 
    SET is_tracking = FALSE 
    WHERE is_tracking = TRUE 
      AND last_seen < DATE_SUB(NOW(3), INTERVAL ? SECOND)`
};

// Batch processing for history inserts
class BatchProcessor {
  constructor(batchSize = 10, flushInterval = 5000) {
    this.queue = [];
    this.batchSize = batchSize;
    this.flushInterval = flushInterval;
    this.startFlushTimer();
  }

  add(item) {
    this.queue.push(item);
    if (this.queue.length >= this.batchSize) {
      this.flush();
    }
  }

  async flush() {
    if (!pool || this.queue.length === 0) return;

    const items = this.queue.splice(0, this.queue.length);
    try {
      const values = items.map(item => [
        item.userId,
        item.location.lat,
        item.location.lng,
        item.address
      ]);
      
      if (values.length > 0) {
        await pool.query(
          `INSERT INTO location_history (user_id, latitude, longitude, address) VALUES ?`,
          [values]
        );
      }
    } catch (error) {
      console.error('Batch flush error:', error.message);
    }
  }

  startFlushTimer() {
    setInterval(() => this.flush(), this.flushInterval);
  }
}

const historyBatcher = new BatchProcessor();

// Cleanup task
function startCleanupTask() {
  setInterval(async () => {
    try {
      // Cleanup cache
      locationCache.cleanup();

      // Cleanup database
      if (pool) {
        const [result] = await pool.query(queries.cleanupInactive, [CONFIG.inactiveThreshold / 1000]);
        if (result.affectedRows > 0) {
          console.log(`🧹 Cleaned up ${result.affectedRows} inactive users`);
        }
      }
    } catch (error) {
      console.error('Cleanup error:', error.message);
    }
  }, CONFIG.cleanupInterval);
}

// Initialize
initializeDatabase();

// ===== API Routes =====

// Health check with caching
let healthCache = null;
let healthCacheTime = 0;

app.get('/api/health', async (req, res) => {
  try {
    const now = Date.now();
    
    // Return cached health if less than 5 seconds old
    if (healthCache && (now - healthCacheTime) < 5000) {
      return res.json(healthCache);
    }

    let dbStatus = 'disconnected';
    if (pool) {
      try {
        await pool.query('SELECT 1');
        dbStatus = 'connected';
      } catch {
        dbStatus = 'error';
      }
    }

    healthCache = {
      status: 'healthy',
      database: dbStatus,
      activeUsers: locationCache.size(),
      uptime: Math.floor(process.uptime()),
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
    };
    healthCacheTime = now;

    res.json(healthCache);
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Register user (lightweight)
app.post('/api/users/register', async (req, res) => {
  const { userId } = req.body;
  
  if (!userId || userId.length > 64) {
    return res.status(400).json({ error: 'Invalid userId' });
  }

  try {
    if (pool) {
      await pool.query(
        'INSERT INTO users (user_id) VALUES (?) ON DUPLICATE KEY UPDATE last_seen = NOW(3)',
        [userId]
      );
    }

    res.json({ success: true, userId });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Update location (optimized with caching and batching)
app.post('/api/location/update', async (req, res) => {
  const { userId, location, address, isTracking } = req.body;

  // Validation
  if (!userId || !location?.lat || !location?.lng) {
    return res.status(400).json({ error: 'Invalid data' });
  }

  if (Math.abs(location.lat) > 90 || Math.abs(location.lng) > 180) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  try {
    const userData = {
      location,
      address: address?.substring(0, 512) || 'Unknown',
      isTracking: isTracking !== false,
      lastSeen: Date.now()
    };

    // Update cache immediately for fast reads
    locationCache.set(userId, userData);

    // Async database operations
    if (pool) {
      // Update user (non-blocking)
      pool.query(queries.upsertUser, [
        userId,
        location.lat,
        location.lng,
        userData.address,
        userData.isTracking
      ]).catch(err => console.error('User update error:', err.message));

      // Batch history inserts
      historyBatcher.add({ userId, location, address: userData.address });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: 'Update failed' });
  }
});

// Stop tracking
app.post('/api/location/stop', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId required' });
  }

  try {
    locationCache.delete(userId);

    if (pool) {
      pool.query(queries.stopTracking, [userId])
        .catch(err => console.error('Stop tracking error:', err.message));
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Stop error:', error);
    res.status(500).json({ error: 'Stop failed' });
  }
});

// Get active users (optimized with cache-first strategy)
app.get('/api/users/active', async (req, res) => {
  try {
    // Try cache first
    const cached = locationCache.getAll();
    const cacheUsers = Object.entries(cached)
      .filter(([_, data]) => data.isTracking)
      .map(([userId, data]) => ({
        userId,
        location: data.location,
        address: data.address,
        isTracking: data.isTracking,
        lastSeen: new Date(data.lastSeen).toISOString()
      }));

    // If we have cache data, return it immediately
    if (cacheUsers.length > 0) {
      return res.json({ 
        users: cacheUsers, 
        count: cacheUsers.length,
        source: 'cache'
      });
    }

    // Fallback to database
    if (pool) {
      const [rows] = await pool.query(queries.getActiveUsers, [CONFIG.inactiveThreshold / 1000]);
      
      const users = rows.map(row => ({
        userId: row.user_id,
        location: {
          lat: parseFloat(row.latitude),
          lng: parseFloat(row.longitude)
        },
        address: row.address,
        isTracking: Boolean(row.is_tracking),
        lastSeen: new Date(row.last_seen_ts * 1000).toISOString()
      }));

      return res.json({ users, count: users.length, source: 'database' });
    }

    res.json({ users: [], count: 0, source: 'none' });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Heartbeat (optimized)
app.post('/api/heartbeat', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId required' });
  }

  try {
    // Update cache
    const cached = locationCache.get(userId);
    if (cached) {
      cached.lastSeen = Date.now();
      locationCache.set(userId, cached);
    }

    // Async DB update
    if (pool) {
      pool.query(queries.updateHeartbeat, [userId])
        .catch(err => console.error('Heartbeat error:', err.message));
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Heartbeat failed' });
  }
});

// Get history (with pagination and caching)
app.get('/api/history/:userId', async (req, res) => {
  const { userId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, CONFIG.historyLimit);
  const offset = parseInt(req.query.offset) || 0;

  if (!pool) {
    return res.json({ history: [], count: 0 });
  }

  try {
    const [rows] = await pool.query(
      `SELECT latitude, longitude, address, 
              UNIX_TIMESTAMP(tracked_at) as tracked_at_ts
       FROM location_history
       WHERE user_id = ?
       ORDER BY tracked_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    
    const history = rows.map(row => ({
      location: {
        lat: parseFloat(row.latitude),
        lng: parseFloat(row.longitude)
      },
      address: row.address,
      trackedAt: new Date(row.tracked_at_ts * 1000).toISOString()
    }));

    res.json({ history, count: history.length, limit, offset });
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Batch endpoint for multiple operations
app.post('/api/batch', async (req, res) => {
  const { operations } = req.body;
  
  if (!Array.isArray(operations) || operations.length > 10) {
    return res.status(400).json({ error: 'Invalid batch request' });
  }

  const results = await Promise.allSettled(
    operations.map(op => {
      switch (op.type) {
        case 'heartbeat':
          return pool?.query(queries.updateHeartbeat, [op.userId]);
        case 'update':
          return pool?.query(queries.upsertUser, [
            op.userId, op.location?.lat, op.location?.lng,
            op.address, op.isTracking
          ]);
        default:
          return Promise.reject(new Error('Invalid operation'));
      }
    })
  );

  res.json({ 
    success: true,
    results: results.map(r => r.status === 'fulfilled')
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
const server = app.listen(CONFIG.port, () => {
  console.log(`🚀 Localo server running on port ${CONFIG.port}`);
  console.log(`📡 Using REST API with polling (optimized)`);
  console.log(`🗄️  Database: ${pool ? 'MySQL' : 'In-Memory'}`);
  console.log(`⚡ Cache TTL: ${locationCache.ttl}ms`);
});

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down gracefully...');
  
  // Flush pending history inserts
  await historyBatcher.flush();
  
  // Close server
  server.close();
  
  // Close database
  if (pool) {
    await pool.end();
    console.log('MySQL connection pool closed');
  }
  
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app };