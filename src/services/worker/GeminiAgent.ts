/**
 * GeminiAgent: Gemini-based observation extraction
 *
 * Alternative to SDKAgent that uses Google's Gemini API directly
 * for extracting observations from tool usage.
 *
 * Responsibility:
 * - Call Gemini REST API for observation extraction
 * - Parse XML responses (same format as Claude)
 * - Sync to database and Chroma
 */

import path from 'path';
import { homedir } from 'os';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import {
  processAgentResponse,
  shouldFallbackToClaude,
  isAbortError,
  type WorkerRef,
  type FallbackAgent
} from './agents/index.js';

// Gemini API endpoint
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Context window management constants (defaults, overridable via settings)
const DEFAULT_GEMINI_MAX_CONTEXT_MESSAGES = 20;  // Maximum messages to keep in conversation history
const DEFAULT_GEMINI_MAX_ESTIMATED_TOKENS = 100000;  // ~100k tokens max context (safety limit)
const CHARS_PER_TOKEN_ESTIMATE = 4;  // Conservative estimate: 1 token = 4 chars

// Retry configuration defaults - increased for quota exhaustion scenarios
// With 5 attempts at 5s base: 5s + 10s + 20s + 40s = ~75s total retry time
const DEFAULT_RETRY_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 5000;

/**
 * Check if error is a rate limit (429) error
 */
function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('429') ||
           msg.includes('rate limit') ||
           msg.includes('resource_exhausted') ||
           msg.includes('quota exceeded');
  }
  return false;
}

/**
 * Calculate exponential backoff delay with jitter
 */
function calculateBackoffDelay(attempt: number, baseDelayMs: number): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const jitter = exponentialDelay * (0.1 + Math.random() * 0.1);
  return Math.min(exponentialDelay + jitter, 60000); // Cap at 60s
}

/**
 * Extract Gemini's suggested retry delay from error response.
 * Gemini 429 responses include a RetryInfo detail with the exact delay to wait.
 * Returns delay in milliseconds, or null if not found.
 */
function extractGeminiRetryDelay(errorText: string): number | null {
  try {
    const errorJson = JSON.parse(errorText);
    const details = errorJson?.error?.details || [];
    for (const detail of details) {
      if (detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo') {
        const retryDelay = detail.retryDelay;
        if (typeof retryDelay === 'string') {
          // Parse "32s" or "32.083535778s" format
          const match = retryDelay.match(/^([\d.]+)s$/);
          if (match) {
            // Convert to ms and round up, add 1s buffer for safety
            return Math.ceil(parseFloat(match[1]) * 1000) + 1000;
          }
        }
      }
    }
  } catch {
    // Not valid JSON, return null
  }
  return null;
}

// Gemini model types (available via API)
export type GeminiModel =
  | 'gemini-2.5-flash-lite'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-pro'
  | 'gemini-2.0-flash'
  | 'gemini-2.0-flash-lite'
  | 'gemini-2.0-flash-exp'
  | 'gemini-3-flash-preview'
  | 'gemini-3-pro-preview';

// Free tier RPM limits by model (requests per minute)
const GEMINI_RPM_LIMITS: Record<GeminiModel, number> = {
  'gemini-2.5-flash-lite': 10,
  'gemini-2.5-flash': 10,
  'gemini-2.5-pro': 5,
  'gemini-2.0-flash': 15,
  'gemini-2.0-flash-lite': 30,
  'gemini-2.0-flash-exp': 10,
  'gemini-3-flash-preview': 5,
  'gemini-3-pro-preview': 2,
};

// Track last request time for rate limiting
let lastRequestTime = 0;

/**
 * Enforce RPM rate limit for Gemini free tier.
 * Waits the required time between requests based on model's RPM limit + 100ms safety buffer.
 * Skipped entirely if rate limiting is disabled (billing users with 1000+ RPM available).
 */
async function enforceRateLimitForModel(model: GeminiModel, rateLimitingEnabled: boolean): Promise<void> {
  // Skip rate limiting if disabled (billing users with 1000+ RPM)
  if (!rateLimitingEnabled) {
    return;
  }

  const rpm = GEMINI_RPM_LIMITS[model] || 5;
  const minimumDelayMs = Math.ceil(60000 / rpm) + 100; // (60s / RPM) + 100ms safety buffer

  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < minimumDelayMs) {
    const waitTime = minimumDelayMs - timeSinceLastRequest;
    logger.debug('SDK', `Rate limiting: waiting ${waitTime}ms before Gemini request`, { model, rpm });
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  lastRequestTime = Date.now();
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;  // true for thinking output, false/undefined for actual content
      }>;
    };
    finishReason?: string;  // STOP, MAX_TOKENS, SAFETY, RECITATION, OTHER
    safetyRatings?: Array<{
      category: string;
      probability: string;
    }>;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;  // Tokens used for thinking (Gemini 2.5+)
  };
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: Array<{
      category: string;
      probability: string;
    }>;
  };
}

/**
 * Check if model supports thinking mode (Gemini 2.5+)
 */
function isThinkingModel(model: GeminiModel): boolean {
  return model.startsWith('gemini-2.5') || model.startsWith('gemini-3');
}

/**
 * Gemini content message format
 * role: "user" or "model" (Gemini uses "model" not "assistant")
 */
interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

export class GeminiAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when Gemini API fails
   * Must be set after construction to avoid circular dependency
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Estimate token count from text (conservative estimate)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Truncate conversation history to prevent runaway context costs
   * Keeps most recent messages within token budget
   */
  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES) || DEFAULT_GEMINI_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_GEMINI_MAX_TOKENS) || DEFAULT_GEMINI_MAX_ESTIMATED_TOKENS;

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      // Check token count even if message count is ok
      const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) {
        return history;
      }
    }

    // Sliding window: keep most recent messages within limits
    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    // Process messages in reverse (most recent first)
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);

      if (truncated.length >= MAX_CONTEXT_MESSAGES || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS) {
        logger.warn('SDK', 'Gemini context window truncated to prevent death spiral', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: MAX_ESTIMATED_TOKENS
        });
        break;
      }

      truncated.unshift(msg);  // Add to beginning
      tokenCount += msgTokens;
    }

    return truncated;
  }

  /**
   * Start Gemini agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      // Get Gemini configuration
      const { apiKey, model, rateLimitingEnabled } = this.getGeminiConfig();

      if (!apiKey) {
        throw new Error('Gemini API key not configured. Set CLAUDE_MEM_GEMINI_API_KEY in settings or GEMINI_API_KEY environment variable.');
      }

      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Add to conversation history and query Gemini with full context
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);

      // ALWAYS ensure memorySessionId exists for stateless provider
      // This must happen even if init response is empty (thinking-only)
      this.sessionManager.ensureMemorySessionId(session, 'gemini');

      if (initResponse.content) {
        // Add response to conversation history
        session.conversationHistory.push({ role: 'assistant', content: initResponse.content });

        // Track token usage
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);  // Rough estimate
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        // Process response using shared ResponseProcessor (no original timestamp for init - not from queue)
        await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'Gemini'
        );
      } else {
        // For thinking models, init may return only thoughts (model acknowledging setup)
        // This is OK - add placeholder to conversation history so subsequent turns work
        session.conversationHistory.push({ role: 'assistant', content: '<acknowledged>' });
        logger.warn('SDK', 'Init response contained only thinking - continuing with empty content', {
          sessionId: session.sessionDbId,
          model
        });
      }

      // Process pending messages
      // Track cwd from messages for CLAUDE.md generation
      let lastCwd: string | undefined;

      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        // Capture cwd from each message for worktree support
        if (message.cwd) {
          lastCwd = message.cwd;
        }
        // Capture earliest timestamp BEFORE processing (will be cleared after)
        // This ensures backlog messages get their original timestamps, not current time
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          // Update last prompt number
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }

          // Build observation prompt
          const obsPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          });

          // Add to conversation history and query Gemini with full context
          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);

          let tokensUsed = 0;
          if (obsResponse.content) {
            // Add response to conversation history
            session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });

            tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          // Process response using shared ResponseProcessor
          await processAgentResponse(
            obsResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'Gemini',
            lastCwd
          );

        } else if (message.type === 'summarize') {
          // Build summary prompt
          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          // Add to conversation history and query Gemini with full context
          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);

          let tokensUsed = 0;
          if (summaryResponse.content) {
            // Add response to conversation history
            session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });

            tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          // Process response using shared ResponseProcessor
          await processAgentResponse(
            summaryResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'Gemini',
            lastCwd
          );
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Gemini agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length
      });

    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'Gemini agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      // Check if we should fall back to Claude
      const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
      const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
      const disableFallback = settings.CLAUDE_MEM_DISABLE_CLAUDE_FALLBACK !== 'false';
      if (shouldFallbackToClaude(error, disableFallback) && this.fallbackAgent) {
        logger.warn('SDK', 'Gemini API failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
          historyLength: session.conversationHistory.length
        });

        // Fall back to Claude - it will use the same session with shared conversationHistory
        // Note: With claim-and-delete queue pattern, messages are already deleted on claim
        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'Gemini agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  /**
   * Convert shared ConversationMessage array to Gemini's contents format
   * Maps 'assistant' role to 'model' for Gemini API compatibility
   */
  private conversationToGeminiContents(history: ConversationMessage[]): GeminiContent[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));
  }

  /**
   * Query Gemini via REST API with full conversation history (multi-turn)
   * Sends the entire conversation context for coherent responses
   * Includes exponential backoff for rate limit (429) errors
   */
  private async queryGeminiMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: GeminiModel,
    rateLimitingEnabled: boolean
  ): Promise<{ content: string; tokensUsed?: number }> {
    // CRITICAL: Truncate history to prevent unbounded growth death spiral
    const truncatedHistory = this.truncateHistory(history);
    const contents = this.conversationToGeminiContents(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(truncatedHistory.map(m => m.content).join(''));

    // Enhanced request logging
    logger.info('SDK', 'Gemini request', {
      model,
      turns: truncatedHistory.length,
      originalTurns: history.length,
      totalChars,
      estimatedTokens,
      lastMessagePreview: truncatedHistory[truncatedHistory.length - 1]?.content.slice(0, 200)
    });

    const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;

    // Enforce RPM rate limit for free tier (skipped if rate limiting disabled)
    await enforceRateLimitForModel(model, rateLimitingEnabled);

    // Build generation config - add thinkingConfig for 2.5+ models
    const generationConfig: Record<string, unknown> = {
      temperature: 0.3,  // Lower temperature for structured extraction
      maxOutputTokens: 4096,
    };

    // Enable thinking output for Gemini 2.5+ models
    if (isThinkingModel(model)) {
      generationConfig.thinkingConfig = {
        includeThoughts: true,  // Make thinking visible in response
        thinkingBudget: 2048,   // Limit thinking tokens to leave room for output
      };
    }

    // Get retry settings
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxAttempts = parseInt(settings.CLAUDE_MEM_GEMINI_RETRY_MAX_ATTEMPTS) || DEFAULT_RETRY_MAX_ATTEMPTS;
    const baseDelayMs = parseInt(settings.CLAUDE_MEM_GEMINI_RETRY_BASE_DELAY_MS) || DEFAULT_RETRY_BASE_DELAY_MS;

    // Retry loop with exponential backoff for 429 errors
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents,
            generationConfig,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          const error = new Error(`Gemini API error: ${response.status} - ${errorText}`);

          // Check if rate limited and should retry
          if (response.status === 429 && attempt < maxAttempts - 1) {
            // Use Gemini's suggested retry delay if available, otherwise exponential backoff
            const geminiDelay = extractGeminiRetryDelay(errorText);
            const delay = geminiDelay ?? calculateBackoffDelay(attempt, baseDelayMs);
            logger.warn('SDK', `Gemini rate limited (429), retrying in ${delay}ms`, {
              attempt: attempt + 1,
              maxAttempts,
              model,
              usingGeminiSuggestedDelay: geminiDelay !== null
            });
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          throw error;
        }

        // Success - parse and return
        const data = await response.json() as GeminiResponse;
        return this.parseGeminiResponse(data, model);

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Retry on rate limit errors
        if (isRateLimitError(error) && attempt < maxAttempts - 1) {
          const delay = calculateBackoffDelay(attempt, baseDelayMs);
          logger.warn('SDK', `Gemini rate limited, retrying in ${delay}ms`, {
            attempt: attempt + 1,
            maxAttempts,
            error: lastError.message
          });
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    // Should not reach here, but throw last error just in case
    throw lastError || new Error('Gemini request failed after retries');
  }

  /**
   * Parse Gemini response and extract content
   */
  private parseGeminiResponse(data: GeminiResponse, _model: GeminiModel): { content: string; tokensUsed?: number } {

    // Extract parts from response
    const parts = data.candidates?.[0]?.content?.parts || [];

    // For thinking models, separate thought parts from actual content parts
    // thought=true are internal reasoning, thought=false/undefined are actual output
    const contentParts = parts.filter(p => !p.thought && p.text);
    const thoughtParts = parts.filter(p => p.thought && p.text);

    // Combine all non-thought text parts
    const content = contentParts.map(p => p.text).join('');
    const hasContent = content.length > 0;

    // Enhanced response logging
    logger.info('SDK', 'Gemini response', {
      hasContent,
      finishReason: data.candidates?.[0]?.finishReason,
      promptBlockReason: data.promptFeedback?.blockReason,
      tokensUsed: data.usageMetadata?.totalTokenCount,
      thoughtsTokenCount: data.usageMetadata?.thoughtsTokenCount,
      totalParts: parts.length,
      contentParts: contentParts.length,
      thoughtParts: thoughtParts.length,
      candidatesCount: data.candidates?.length ?? 0
    });

    if (!hasContent) {
      // Enhanced empty response logging with full diagnostics
      logger.error('SDK', 'Empty response from Gemini', {
        finishReason: data.candidates?.[0]?.finishReason,
        promptBlockReason: data.promptFeedback?.blockReason,
        safetyRatings: data.candidates?.[0]?.safetyRatings,
        promptSafetyRatings: data.promptFeedback?.safetyRatings,
        candidatesCount: data.candidates?.length ?? 0,
        totalParts: parts.length,
        thoughtParts: thoughtParts.length,
        rawResponse: JSON.stringify(data).slice(0, 500)
      });
      return { content: '' };
    }

    const tokensUsed = data.usageMetadata?.totalTokenCount;

    return { content, tokensUsed };
  }

  /**
   * Get Gemini configuration from settings or environment
   */
  private getGeminiConfig(): { apiKey: string; model: GeminiModel; rateLimitingEnabled: boolean } {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    // API key: check settings first, then environment variable
    const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';

    // Model: from settings or default, with validation
    const defaultModel: GeminiModel = 'gemini-2.5-flash';
    const configuredModel = settings.CLAUDE_MEM_GEMINI_MODEL || defaultModel;
    const validModels: GeminiModel[] = [
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-2.0-flash-exp',
      'gemini-3-flash-preview',
      'gemini-3-pro-preview',
    ];

    let model: GeminiModel;
    if (validModels.includes(configuredModel as GeminiModel)) {
      model = configuredModel as GeminiModel;
    } else {
      logger.warn('SDK', `Invalid Gemini model "${configuredModel}", falling back to ${defaultModel}`, {
        configured: configuredModel,
        validModels,
      });
      model = defaultModel;
    }

    // Rate limiting: enabled by default for free tier users
    const rateLimitingEnabled = settings.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED !== 'false';

    return { apiKey, model, rateLimitingEnabled };
  }
}

/**
 * Check if Gemini is available (has API key configured)
 */
export function isGeminiAvailable(): boolean {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_GEMINI_API_KEY || process.env.GEMINI_API_KEY);
}

/**
 * Check if Gemini is the selected provider
 */
export function isGeminiSelected(): boolean {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'gemini';
}
