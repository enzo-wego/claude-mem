/**
 * Smart Install Script for claude-mem
 *
 * Ensures Bun runtime and uv (Python package manager) are installed
 * (auto-installs if missing) and handles dependency installation when needed.
 *
 * This file is built to plugin/scripts/smart-install.js
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync, spawnSync, SpawnSyncReturns } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

// Marketplace vendor - single source of truth (must match paths.ts MARKETPLACE_VENDOR)
const MARKETPLACE_VENDOR = process.env.CLAUDE_MEM_MARKETPLACE_VENDOR || 'enzo-claude-mem';
const ROOT = join(homedir(), '.claude', 'plugins', 'marketplaces', MARKETPLACE_VENDOR);
const MARKER = join(ROOT, '.install-version');
const IS_WINDOWS = process.platform === 'win32';

// Common installation paths (handles fresh installs before PATH reload)
const BUN_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
  : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

const UV_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.local', 'bin', 'uv.exe'), join(homedir(), '.cargo', 'bin', 'uv.exe')]
  : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv', '/opt/homebrew/bin/uv'];

/**
 * Get the Bun executable path (from PATH or common install locations)
 */
function getBunPath(): string | null {
  // Try PATH first
  try {
    const result: SpawnSyncReturns<string> = spawnSync('bun', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    if (result.status === 0) return 'bun';
  } catch {
    // Not in PATH
  }

  // Check common installation paths
  return BUN_COMMON_PATHS.find(existsSync) || null;
}

/**
 * Check if Bun is installed and accessible
 */
function isBunInstalled(): boolean {
  return getBunPath() !== null;
}

/**
 * Get Bun version if installed
 */
function getBunVersion(): string | null {
  const bunPath = getBunPath();
  if (!bunPath) return null;

  try {
    const result: SpawnSyncReturns<string> = spawnSync(bunPath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Get the uv executable path (from PATH or common install locations)
 */
function getUvPath(): string | null {
  // Try PATH first
  try {
    const result: SpawnSyncReturns<string> = spawnSync('uv', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    if (result.status === 0) return 'uv';
  } catch {
    // Not in PATH
  }

  // Check common installation paths
  return UV_COMMON_PATHS.find(existsSync) || null;
}

/**
 * Check if uv is installed and accessible
 */
function isUvInstalled(): boolean {
  return getUvPath() !== null;
}

/**
 * Get uv version if installed
 */
function getUvVersion(): string | null {
  const uvPath = getUvPath();
  if (!uvPath) return null;

  try {
    const result: SpawnSyncReturns<string> = spawnSync(uvPath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Install Bun automatically based on platform
 */
function installBun(): void {
  console.error('🔧 Bun not found. Installing Bun runtime...');

  try {
    if (IS_WINDOWS) {
      console.error('   Installing via PowerShell...');
      execSync('powershell -c "irm bun.sh/install.ps1 | iex"', {
        stdio: 'inherit',
        shell: true
      });
    } else {
      console.error('   Installing via curl...');
      execSync('curl -fsSL https://bun.sh/install | bash', {
        stdio: 'inherit',
        shell: true
      });
    }

    if (!isBunInstalled()) {
      throw new Error(
        'Bun installation completed but binary not found. ' +
        'Please restart your terminal and try again.'
      );
    }

    const version = getBunVersion();
    console.error(`✅ Bun ${version} installed successfully`);
  } catch (error) {
    console.error('❌ Failed to install Bun');
    console.error('   Please install manually:');
    if (IS_WINDOWS) {
      console.error('   - winget install Oven-sh.Bun');
      console.error('   - Or: powershell -c "irm bun.sh/install.ps1 | iex"');
    } else {
      console.error('   - curl -fsSL https://bun.sh/install | bash');
      console.error('   - Or: brew install oven-sh/bun/bun');
    }
    console.error('   Then restart your terminal and try again.');
    throw error;
  }
}

/**
 * Install uv automatically based on platform
 */
function installUv(): void {
  console.error('🐍 Installing uv for Python/Chroma support...');

  try {
    if (IS_WINDOWS) {
      console.error('   Installing via PowerShell...');
      execSync('powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"', {
        stdio: 'inherit',
        shell: true
      });
    } else {
      console.error('   Installing via curl...');
      execSync('curl -LsSf https://astral.sh/uv/install.sh | sh', {
        stdio: 'inherit',
        shell: true
      });
    }

    if (!isUvInstalled()) {
      throw new Error(
        'uv installation completed but binary not found. ' +
        'Please restart your terminal and try again.'
      );
    }

    const version = getUvVersion();
    console.error(`✅ uv ${version} installed successfully`);
  } catch (error) {
    console.error('❌ Failed to install uv');
    console.error('   Please install manually:');
    if (IS_WINDOWS) {
      console.error('   - winget install astral-sh.uv');
      console.error('   - Or: powershell -c "irm https://astral.sh/uv/install.ps1 | iex"');
    } else {
      console.error('   - curl -LsSf https://astral.sh/uv/install.sh | sh');
      console.error('   - Or: brew install uv (macOS)');
    }
    console.error('   Then restart your terminal and try again.');
    throw error;
  }
}

/**
 * Add shell alias for claude-mem command
 */
function installCLI(): void {
  const WORKER_CLI = join(ROOT, 'plugin', 'scripts', 'worker-service.cjs');
  const bunPath = getBunPath() || 'bun';
  const aliasLine = `alias claude-mem='${bunPath} "${WORKER_CLI}"'`;
  const markerPath = join(ROOT, '.cli-installed');

  // Skip if already installed
  if (existsSync(markerPath)) return;

  try {
    if (IS_WINDOWS) {
      // Windows: Add to PATH via PowerShell profile
      const profilePath = join(process.env.USERPROFILE || homedir(), 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
      const profileDir = join(process.env.USERPROFILE || homedir(), 'Documents', 'PowerShell');
      const functionDef = `function claude-mem { & "${bunPath}" "${WORKER_CLI}" $args }\n`;

      if (!existsSync(profileDir)) {
        execSync(`mkdir "${profileDir}"`, { stdio: 'ignore', shell: true });
      }

      const existingContent = existsSync(profilePath) ? readFileSync(profilePath, 'utf-8') : '';
      if (!existingContent.includes('function claude-mem')) {
        writeFileSync(profilePath, existingContent + '\n' + functionDef);
        // Suppress success message - stderr output triggers Claude Code's "hook error" indicator
      }
    } else {
      // Unix: Add alias to shell configs
      const shellConfigs = [
        join(homedir(), '.bashrc'),
        join(homedir(), '.zshrc')
      ];

      for (const config of shellConfigs) {
        if (existsSync(config)) {
          const content = readFileSync(config, 'utf-8');
          if (!content.includes('alias claude-mem=')) {
            writeFileSync(config, content + '\n' + aliasLine + '\n');
            // Suppress success message - stderr output triggers Claude Code's "hook error" indicator
          }
        }
      }
      // Suppress informational message - stderr output triggers Claude Code's "hook error" indicator
    }

    writeFileSync(markerPath, new Date().toISOString());
  } catch (error) {
    // Only log actual errors
    const message = error instanceof Error ? error.message : String(error);
    console.error(`⚠️  Could not add shell alias: ${message}`);
    console.error(`   Use directly: ${bunPath} "${WORKER_CLI}" <command>`);
  }
}

/**
 * Check if dependencies need to be installed
 */
function needsInstall(): boolean {
  if (!existsSync(join(ROOT, 'node_modules'))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const marker = JSON.parse(readFileSync(MARKER, 'utf-8'));
    return pkg.version !== marker.version || getBunVersion() !== marker.bun;
  } catch {
    return true;
  }
}

/**
 * Install dependencies using Bun with npm fallback
 *
 * Bun has issues with npm alias packages (e.g., string-width-cjs, strip-ansi-cjs)
 * that are defined in package-lock.json. When bun fails with 404 errors for these
 * packages, we fall back to npm which handles aliases correctly.
 */
function installDeps(): void {
  const bunPath = getBunPath();
  if (!bunPath) {
    throw new Error('Bun executable not found');
  }

  // Suppress informational message - stderr output triggers Claude Code's "hook error" indicator

  // Quote path for Windows paths with spaces
  const bunCmd = IS_WINDOWS && bunPath.includes(' ') ? `"${bunPath}"` : bunPath;

  let bunSucceeded = false;
  try {
    // Use 'pipe' instead of 'inherit' to suppress output
    execSync(`${bunCmd} install`, { cwd: ROOT, stdio: 'pipe', shell: IS_WINDOWS });
    bunSucceeded = true;
  } catch {
    // First attempt failed, try with force flag
    try {
      execSync(`${bunCmd} install --force`, { cwd: ROOT, stdio: 'pipe', shell: IS_WINDOWS });
      bunSucceeded = true;
    } catch {
      // Bun failed completely, will try npm fallback
    }
  }

  // Fallback to npm if bun failed (handles npm alias packages correctly)
  if (!bunSucceeded) {
    // Only show error message if we need to fall back (this is an error condition)
    console.error('⚠️  Bun install failed, falling back to npm...');
    try {
      execSync('npm install', { cwd: ROOT, stdio: 'pipe', shell: IS_WINDOWS });
    } catch (npmError) {
      const message = npmError instanceof Error ? npmError.message : String(npmError);
      throw new Error('Both bun and npm install failed: ' + message);
    }
  }

  // Write version marker
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  writeFileSync(MARKER, JSON.stringify({
    version: pkg.version,
    bun: getBunVersion(),
    uv: getUvVersion(),
    installedAt: new Date().toISOString()
  }));
}

// Main execution
// NOTE: For SessionStart hooks, Claude Code shows "hook error" if there's ANY stderr output,
// even with exit code 0. We suppress informational output during normal operation.
try {
  // Step 1: Ensure Bun is installed (REQUIRED)
  if (!isBunInstalled()) {
    installBun();

    // Re-check after installation
    if (!isBunInstalled()) {
      console.error('❌ Bun is required but not available in PATH');
      console.error('   Please restart your terminal after installation');
      process.exit(1);
    }
  }

  // Step 2: Ensure uv is installed (REQUIRED for vector search)
  if (!isUvInstalled()) {
    installUv();

    // Re-check after installation
    if (!isUvInstalled()) {
      console.error('❌ uv is required but not available in PATH');
      console.error('   Please restart your terminal after installation');
      process.exit(1);
    }
  }

  // Step 3: Install dependencies if needed
  if (needsInstall()) {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const newVersion = pkg.version;

    installDeps();
    // Suppress success message - stderr output triggers Claude Code's "hook error" indicator

    // Auto-restart worker to pick up new code
    const port = process.env.CLAUDE_MEM_WORKER_PORT || '37777';
    // Suppress update message - stderr output triggers Claude Code's "hook error" indicator
    try {
      // Graceful shutdown via HTTP (curl is cross-platform enough)
      execSync(`curl -s -X POST http://127.0.0.1:${port}/api/admin/shutdown`, {
        stdio: 'ignore',
        shell: IS_WINDOWS,
        timeout: 5000
      });
      // Brief wait for port to free
      execSync(IS_WINDOWS ? 'timeout /t 1 /nobreak >nul' : 'sleep 0.5', {
        stdio: 'ignore',
        shell: true
      });
    } catch {
      // Worker wasn't running or already stopped - that's fine
    }
    // Worker will be started fresh by next hook in chain (worker-service.cjs start)
  }

  // Step 4: Ensure bun-runner.sh is executable (for non-Windows)
  if (!IS_WINDOWS) {
    const bunRunner = join(ROOT, 'plugin', 'scripts', 'bun-runner.sh');
    if (existsSync(bunRunner)) {
      try {
        execSync(`chmod +x "${bunRunner}"`, { stdio: 'ignore' });
      } catch {
        // Ignore chmod errors - might already be executable
      }
    }
  }

  // Step 5: Install CLI to PATH (silently)
  installCLI();
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error('❌ Installation failed:', message);
  process.exit(1);
}
