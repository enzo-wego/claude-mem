import path from "path";
import { readFileSync } from "fs";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";
import { getWorkerRestartInstructions } from "../utils/error-messages.js";
import { MARKETPLACE_ROOT } from "./paths.js";

// Named constants for health checks
const HEALTH_CHECK_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.HEALTH_CHECK);

// Cache to avoid repeated settings file reads
let cachedPort: number | null = null;
let cachedHost: string | null = null;
let cachedAllowedProjectsOnly: string[] | null = null;
let cachedIgnoredProjects: string[] | null = null;

/**
 * Get the worker port number from settings
 * Uses CLAUDE_MEM_WORKER_PORT from settings file or default (37777)
 * Caches the port value to avoid repeated file reads
 */
export function getWorkerPort(): number {
  if (cachedPort !== null) {
    return cachedPort;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedPort = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
  return cachedPort;
}

/**
 * Get the worker host address
 * Uses CLAUDE_MEM_WORKER_HOST from settings file or default (127.0.0.1)
 * Caches the host value to avoid repeated file reads
 */
export function getWorkerHost(): string {
  if (cachedHost !== null) {
    return cachedHost;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedHost = settings.CLAUDE_MEM_WORKER_HOST;
  return cachedHost;
}

/**
 * Clear the cached port, host, and project filter values
 * Call this when settings are updated to force re-reading from file
 */
export function clearPortCache(): void {
  cachedPort = null;
  cachedHost = null;
  cachedAllowedProjectsOnly = null;
  cachedIgnoredProjects = null;
}

/**
 * Get the list of ignored project names from settings (blacklist mode)
 * Uses CLAUDE_MEM_IGNORED_PROJECTS from settings file (comma-separated)
 * Caches the value to avoid repeated file reads
 */
export function getIgnoredProjects(): string[] {
  if (cachedIgnoredProjects !== null) {
    return cachedIgnoredProjects;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedIgnoredProjects = (settings.CLAUDE_MEM_IGNORED_PROJECTS || '')
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0);
  return cachedIgnoredProjects;
}

/**
 * Get the list of allowed project names from settings (whitelist mode)
 * Uses CLAUDE_MEM_ALLOWED_PROJECTS_ONLY from settings file (comma-separated)
 * Caches the value to avoid repeated file reads
 */
export function getAllowedProjectsOnly(): string[] {
  if (cachedAllowedProjectsOnly !== null) {
    return cachedAllowedProjectsOnly;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedAllowedProjectsOnly = (settings.CLAUDE_MEM_ALLOWED_PROJECTS_ONLY || '')
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0);
  return cachedAllowedProjectsOnly;
}

/**
 * Check if any of the given project names should be ignored
 * @param projectNames - Array of project names to check (e.g., from getProjectContext().allProjects)
 * @returns true if project should be ignored
 *
 * Logic:
 * 1. If whitelist (ALLOWED_PROJECTS_ONLY) is non-empty: project must be in whitelist
 * 2. If whitelist is empty: use blacklist (IGNORED_PROJECTS) - project is ignored if in blacklist
 * 3. If both empty: no filtering, all projects allowed
 */
export function isProjectIgnored(projectNames: string[]): boolean {
  const allowedOnly = getAllowedProjectsOnly();
  const ignored = getIgnoredProjects();

  // If whitelist is configured (non-empty), use strict whitelist mode
  if (allowedOnly.length > 0) {
    return !projectNames.some(name => allowedOnly.includes(name));
  }

  // Otherwise, use blacklist mode (default: nothing ignored)
  if (ignored.length > 0) {
    return projectNames.some(name => ignored.includes(name));
  }

  // Default: no filtering, all projects allowed
  return false;
}

/**
 * Check if worker is responsive and fully initialized by trying the readiness endpoint
 * Changed from /health to /api/readiness to ensure MCP initialization is complete
 */
async function isWorkerHealthy(): Promise<boolean> {
  const port = getWorkerPort();
  // Note: Removed AbortSignal.timeout to avoid Windows Bun cleanup issue (libuv assertion)
  const response = await fetch(`http://127.0.0.1:${port}/api/readiness`);
  return response.ok;
}

/**
 * Get the current plugin version from package.json
 */
function getPluginVersion(): string {
  const packageJsonPath = path.join(MARKETPLACE_ROOT, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  return packageJson.version;
}

/**
 * Get the running worker's version from the API
 */
async function getWorkerVersion(): Promise<string> {
  const port = getWorkerPort();
  // Note: Removed AbortSignal.timeout to avoid Windows Bun cleanup issue (libuv assertion)
  const response = await fetch(`http://127.0.0.1:${port}/api/version`);
  if (!response.ok) {
    throw new Error(`Failed to get worker version: ${response.status}`);
  }
  const data = await response.json() as { version: string };
  return data.version;
}

/**
 * Check if worker version matches plugin version
 * Note: Auto-restart on version mismatch is now handled in worker-service.ts start command (issue #484)
 * This function logs for informational purposes only
 */
async function checkWorkerVersion(): Promise<void> {
  const pluginVersion = getPluginVersion();
  const workerVersion = await getWorkerVersion();

  if (pluginVersion !== workerVersion) {
    // Just log debug info - auto-restart handles the mismatch in worker-service.ts
    logger.debug('SYSTEM', 'Version check', {
      pluginVersion,
      workerVersion,
      note: 'Mismatch will be auto-restarted by worker-service start command'
    });
  }
}


/**
 * Ensure worker service is running
 * Polls until worker is ready (assumes worker-service.cjs start was called by hooks.json)
 */
export async function ensureWorkerRunning(): Promise<void> {
  const maxRetries = 150;  // 30 seconds total (increased from 15s for defense in depth)
  const pollInterval = 200;

  for (let i = 0; i < maxRetries; i++) {
    try {
      if (await isWorkerHealthy()) {
        await checkWorkerVersion();  // logs warning on mismatch, doesn't restart
        return;
      }
    } catch (e) {
      logger.debug('SYSTEM', 'Worker health check failed, will retry', {
        attempt: i + 1,
        maxRetries,
        error: e instanceof Error ? e.message : String(e)
      });
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error(getWorkerRestartInstructions({
    port: getWorkerPort(),
    customPrefix: 'Worker did not become ready within 30 seconds.'
  }));
}
