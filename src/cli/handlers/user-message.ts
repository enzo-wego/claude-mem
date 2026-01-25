/**
 * User Message Handler - SessionStart (parallel)
 *
 * Extracted from user-message-hook.ts - displays context info to user via stderr.
 * Uses exit code 3 to show user message without injecting into Claude's context.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning } from '../../shared/worker-utils.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';

/**
 * User Message Handler - SessionStart (parallel)
 *
 * As of Claude Code 2.1.0, SessionStart hooks no longer display user-visible messages.
 * Context injection happens via the 'context' hook's additionalContext field.
 * This handler now only ensures the worker is running - the stderr output has been
 * removed to avoid triggering the "hook error" indicator.
 */
export const userMessageHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running (context injection is handled by context.ts)
    await ensureWorkerRunning();

    return { exitCode: HOOK_EXIT_CODES.SUCCESS };
  }
};
