/**
 * SpawnLock - Cross-platform file-based mutex for spawn operations
 *
 * Uses atomic file operations to prevent multiple processes from spawning
 * the worker simultaneously. Works on Windows and Unix.
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { logger } from '../../utils/logger.js';

const DATA_DIR = path.join(homedir(), '.claude-mem');
const SPAWN_LOCK_FILE = path.join(DATA_DIR, 'spawn.lock');
const LOCK_STALE_THRESHOLD_MS = 60000; // 60 seconds - lock is stale if older than this

interface LockInfo {
  pid: number;
  timestamp: number;
}

/**
 * Check if a process is still running
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to acquire the spawn lock
 * Returns true if lock acquired, false if another process holds it
 */
export function acquireSpawnLock(): boolean {
  mkdirSync(DATA_DIR, { recursive: true });

  // Check for existing lock
  if (existsSync(SPAWN_LOCK_FILE)) {
    try {
      const lockContent = readFileSync(SPAWN_LOCK_FILE, 'utf-8');
      const lockInfo: LockInfo = JSON.parse(lockContent);

      // Check if lock is stale (process dead or lock too old)
      const lockAge = Date.now() - lockInfo.timestamp;
      const processAlive = isProcessRunning(lockInfo.pid);

      if (lockAge > LOCK_STALE_THRESHOLD_MS || !processAlive) {
        logger.info('SYSTEM', 'Removing stale spawn lock', {
          stalePid: lockInfo.pid,
          ageMs: lockAge,
          processAlive
        });
        unlinkSync(SPAWN_LOCK_FILE);
      } else {
        // Lock is valid and held by another process
        logger.debug('SYSTEM', 'Spawn lock held by another process', {
          lockPid: lockInfo.pid,
          ageMs: lockAge
        });
        return false;
      }
    } catch (error) {
      // Corrupted lock file - remove it
      logger.warn('SYSTEM', 'Removing corrupted spawn lock file', {}, error as Error);
      try { unlinkSync(SPAWN_LOCK_FILE); } catch { /* ignore */ }
    }
  }

  // Write our lock
  const lockInfo: LockInfo = {
    pid: process.pid,
    timestamp: Date.now()
  };

  try {
    // Use 'wx' flag for exclusive create (fails if file exists)
    // This is atomic on both Windows and Unix
    writeFileSync(SPAWN_LOCK_FILE, JSON.stringify(lockInfo), { flag: 'wx' });
    logger.debug('SYSTEM', 'Acquired spawn lock', { pid: process.pid });
    return true;
  } catch (error) {
    // Another process beat us to it
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      logger.debug('SYSTEM', 'Lost race for spawn lock');
      return false;
    }
    throw error;
  }
}

/**
 * Release the spawn lock (only if we own it)
 */
export function releaseSpawnLock(): void {
  if (!existsSync(SPAWN_LOCK_FILE)) return;

  try {
    const lockContent = readFileSync(SPAWN_LOCK_FILE, 'utf-8');
    const lockInfo: LockInfo = JSON.parse(lockContent);

    // Only release if we own the lock
    if (lockInfo.pid === process.pid) {
      unlinkSync(SPAWN_LOCK_FILE);
      logger.debug('SYSTEM', 'Released spawn lock', { pid: process.pid });
    }
  } catch (error) {
    logger.warn('SYSTEM', 'Failed to release spawn lock', {}, error as Error);
  }
}
