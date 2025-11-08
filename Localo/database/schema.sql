-- Localo MySQL Database Schema
-- Run this file to manually create the database and tables

-- Create database
CREATE DATABASE IF NOT EXISTS localo
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- Use the database
USE localo;

-- Create users table
-- Stores current user information and last known location
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(255) UNIQUE NOT NULL COMMENT 'Unique user identifier',
  latitude DECIMAL(10, 8) COMMENT 'User latitude coordinate',
  longitude DECIMAL(11, 8) COMMENT 'User longitude coordinate',
  address TEXT COMMENT 'Reverse geocoded address',
  is_tracking BOOLEAN DEFAULT FALSE COMMENT 'Whether user is actively tracking',
  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last activity timestamp',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT 'User first connection time',
  INDEX idx_user_id (user_id),
  INDEX idx_last_seen (last_seen),
  INDEX idx_is_tracking (is_tracking)
) ENGINE=InnoDB 
  DEFAULT CHARSET=utf8mb4 
  COLLATE=utf8mb4_unicode_ci
  COMMENT='Active and recent users with their current location';

-- Create location_history table
-- Stores historical location data for tracking and analytics
CREATE TABLE IF NOT EXISTS location_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL COMMENT 'Reference to user ID',
  latitude DECIMAL(10, 8) NOT NULL COMMENT 'Historical latitude coordinate',
  longitude DECIMAL(11, 8) NOT NULL COMMENT 'Historical longitude coordinate',
  address TEXT COMMENT 'Reverse geocoded address at this point',
  tracked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT 'When this location was recorded',
  INDEX idx_user_id (user_id),
  INDEX idx_tracked_at (tracked_at)
) ENGINE=InnoDB 
  DEFAULT CHARSET=utf8mb4 
  COLLATE=utf8mb4_unicode_ci
  COMMENT='Historical location tracking data';

-- Optional: Create a view for recent user activity
CREATE OR REPLACE VIEW recent_users AS
SELECT 
  u.user_id,
  u.latitude,
  u.longitude,
  u.address,
  u.is_tracking,
  u.last_seen,
  u.created_at,
  COUNT(lh.id) as location_count
FROM users u
LEFT JOIN location_history lh ON u.user_id = lh.user_id
WHERE u.last_seen > DATE_SUB(NOW(), INTERVAL 1 HOUR)
GROUP BY u.user_id, u.latitude, u.longitude, u.address, u.is_tracking, u.last_seen, u.created_at
ORDER BY u.last_seen DESC;

-- Optional: Create stored procedure to clean old data
DELIMITER //

CREATE PROCEDURE IF NOT EXISTS cleanup_old_data(IN days_to_keep INT)
BEGIN
  -- Delete location history older than specified days
  DELETE FROM location_history 
  WHERE tracked_at < DATE_SUB(NOW(), INTERVAL days_to_keep DAY);
  
  -- Delete users not seen in specified days
  DELETE FROM users 
  WHERE last_seen < DATE_SUB(NOW(), INTERVAL days_to_keep DAY);
  
  -- Return cleanup summary
  SELECT 
    'Cleanup completed' as status,
    ROW_COUNT() as rows_deleted,
    NOW() as cleanup_time;
END //

DELIMITER ;

-- Optional: Create event to auto-cleanup old data (runs daily)
-- Note: Requires EVENT scheduler to be enabled
SET GLOBAL event_scheduler = ON;

CREATE EVENT IF NOT EXISTS daily_cleanup
ON SCHEDULE EVERY 1 DAY
STARTS CURRENT_TIMESTAMP
DO
  CALL cleanup_old_data(30); -- Keep last 30 days

-- Useful queries for monitoring

-- Check active users in last hour
-- SELECT * FROM recent_users;

-- Get user location history
-- SELECT * FROM location_history WHERE user_id = 'your_user_id' ORDER BY tracked_at DESC LIMIT 50;

-- Count total locations tracked
-- SELECT COUNT(*) as total_locations FROM location_history;

-- Get most active users
-- SELECT user_id, COUNT(*) as location_updates 
-- FROM location_history 
-- GROUP BY user_id 
-- ORDER BY location_updates DESC 
-- LIMIT 10;

-- Check database size
-- SELECT 
--   table_name,
--   ROUND(((data_length + index_length) / 1024 / 1024), 2) AS size_mb
-- FROM information_schema.TABLES 
-- WHERE table_schema = 'localo'
-- ORDER BY (data_length + index_length) DESC;