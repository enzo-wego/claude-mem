/**
 * Summarize Handler - Stop
 *
 * Extracted from summary-hook.ts - sends summary request to worker.
 * Transcript parsing stays in the hook because only the hook has access to
 * the transcript file path.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort, isProjectIgnored } from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    await ensureWorkerRunning();

    // Check if this project is ignored
    const projectContext = getProjectContext(input.cwd || process.cwd());
    if (isProjectIgnored(projectContext.allProjects)) {
      logger.debug('HOOK', 'summarize: Project ignored', { project: projectContext.primary });
      return { continue: true, suppressOutput: true };
    }

    const { sessionId, transcriptPath } = input;

    const port = getWorkerPort();

    // Validate required fields before processing
    if (!transcriptPath) {
      throw new Error(`Missing transcriptPath in Stop hook input for session ${sessionId}`);
    }

    // Extract last assistant message from transcript (the work Claude did)
    // Note: "user" messages in transcripts are mostly tool_results, not actual user input.
    // The user's original request is already stored in user_prompts table.
    const lastAssistantMessage = extractLastMessage(transcriptPath, 'assistant', true);

    logger.dataIn('HOOK', 'Stop: Requesting summary', {
      workerPort: port,
      hasLastAssistantMessage: !!lastAssistantMessage
    });

    // Send to worker - worker handles privacy check and database operations
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: sessionId,
        last_assistant_message: lastAssistantMessage
      })
      // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
    });

    if (!response.ok) {
      // Return standard response even on failure (matches original behavior)
      return { continue: true, suppressOutput: true };
    }

    logger.debug('HOOK', 'Summary request sent successfully');

    return { continue: true, suppressOutput: true };
  }
};
