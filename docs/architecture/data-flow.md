# Claude-Mem Data Flow Architecture

This document describes how data flows through the claude-mem system, from Claude Code hooks to persistent storage.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CLAUDE CODE                                       │
│  ┌──────────────┐  ┌──────────────────┐  ┌─────────────┐  ┌──────────┐     │
│  │ SessionStart │  │ UserPromptSubmit │  │ PostToolUse │  │   Stop   │     │
│  └──────┬───────┘  └────────┬─────────┘  └──────┬──────┘  └────┬─────┘     │
└─────────┼───────────────────┼───────────────────┼──────────────┼───────────┘
          │                   │                   │              │
          │ context           │ session-init      │ observation  │ summarize
          │ user-message      │                   │              │
          ▼                   ▼                   ▼              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         WORKER SERVICE (port 37777)                          │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                      Hook Handlers (HTTP API)                        │    │
│  │  POST /hook/context  │  POST /hook/session-init  │  POST /hook/obs  │    │
│  └──────────────────────┴───────────────┬───────────┴──────────────────┘    │
│                                         │                                    │
│                                         ▼                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                     Session Manager                                  │    │
│  │  - Creates/retrieves sdk_sessions                                    │    │
│  │  - Enqueues messages to pending_messages                             │    │
│  │  - Starts SDK Agent processing                                       │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                         │                                    │
│                                         ▼                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    LLM Agent (SDK/Gemini/OpenRouter)                 │    │
│  │  - Claims messages from queue                                        │    │
│  │  - Builds prompts with tool context                                  │    │
│  │  - Calls LLM API to extract observations                             │    │
│  │  - Parses XML responses                                              │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                         │                                    │
│                                         ▼                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Response Processor                                │    │
│  │  - Atomic database transaction (SQLite)                              │    │
│  │  - Fire-and-forget Chroma sync                                       │    │
│  │  - SSE broadcast to web UI                                           │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                         │                                    │
│                   ┌─────────────────────┴─────────────────────┐              │
│                   │                                           │              │
│                   ▼                                           ▼              │
│  ┌────────────────────────────────┐    ┌────────────────────────────────┐   │
│  │          SQLite                 │    │          ChromaDB              │   │
│  │  ~/.claude-mem/claude-mem.db    │    │  ~/.claude-mem/vector-db/      │   │
│  │  (Source of truth)              │    │  (Semantic search index)       │   │
│  └────────────────────────────────┘    └────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Hook System

Claude-mem uses 4 lifecycle hooks from Claude Code:

| Hook | Trigger | Purpose | Storage Action |
|------|---------|---------|----------------|
| **SessionStart** | Session begins (startup/clear/compact) | Initialize context | Retrieves recent memories for injection |
| **UserPromptSubmit** | User submits a prompt | Track session & prompt | Creates `sdk_sessions` record, stores `user_prompts` |
| **PostToolUse** | After any tool execution | Capture tool activity | Queues `observation` message to `pending_messages` |
| **Stop** | Session ends | Generate summary | Queues `summarize` message to `pending_messages` |

### Hook Commands

Each hook invokes the worker service via CLI:

```bash
# SessionStart
bun worker-service.cjs hook claude-code context      # Inject recent memories
bun worker-service.cjs hook claude-code user-message # Additional context

# UserPromptSubmit
bun worker-service.cjs hook claude-code session-init # Create/update session

# PostToolUse
bun worker-service.cjs hook claude-code observation  # Queue tool data

# Stop
bun worker-service.cjs hook claude-code summarize    # Queue summary request
```

## SQLite Database Schema

Location: `~/.claude-mem/claude-mem.db`

### Entity Relationship Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                          sdk_sessions                                │    │
│  │  ─────────────────────────────────────────────────────────────────  │    │
│  │  id                    INTEGER PRIMARY KEY AUTOINCREMENT             │    │
│  │  content_session_id    TEXT UNIQUE NOT NULL  ◄─── Claude's session   │    │
│  │  memory_session_id     TEXT UNIQUE           ◄─── Internal memory ID │    │
│  │  project               TEXT NOT NULL                                 │    │
│  │  user_prompt           TEXT                                          │    │
│  │  started_at            TEXT NOT NULL                                 │    │
│  │  started_at_epoch      INTEGER NOT NULL                              │    │
│  │  completed_at          TEXT                                          │    │
│  │  completed_at_epoch    INTEGER                                       │    │
│  │  status                TEXT ('active'|'completed'|'failed')          │    │
│  └──────────────────────────────┬──────────────────────────────────────┘    │
│                                 │                                            │
│         ┌───────────────────────┼───────────────────────┐                   │
│         │                       │                       │                   │
│         ▼                       ▼                       ▼                   │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐  │
│  │   user_prompts   │  │ pending_messages │  │      observations        │  │
│  │  ──────────────  │  │  ──────────────  │  │  ────────────────────    │  │
│  │  id          PK  │  │  id          PK  │  │  id                  PK  │  │
│  │  content_session │  │  session_db_id   │  │  memory_session_id   FK  │  │
│  │  _id         FK  │  │             FK   │  │  project                 │  │
│  │  prompt_number   │  │  content_session │  │  type (decision|bugfix|  │  │
│  │  prompt_text     │  │  _id             │  │    feature|refactor|     │  │
│  │  created_at      │  │  message_type    │  │    discovery)            │  │
│  │  created_at_epoch│  │  tool_name       │  │  title                   │  │
│  └──────────────────┘  │  tool_input      │  │  subtitle                │  │
│                        │  tool_response   │  │  narrative               │  │
│                        │  status          │  │  text                    │  │
│                        │  retry_count     │  │  facts (JSON)            │  │
│                        │  created_at_epoch│  │  concepts (JSON)         │  │
│                        └──────────────────┘  │  files_read (JSON)       │  │
│                                              │  files_modified (JSON)   │  │
│                                              │  prompt_number           │  │
│                                              │  discovery_tokens        │  │
│                                              │  created_at_epoch        │  │
│                                              └──────────────────────────┘  │
│                                                          │                  │
│  ┌──────────────────────────────────────────────────────┐│                  │
│  │               session_summaries                       ││                  │
│  │  ─────────────────────────────────────────────────── ││                  │
│  │  id                  INTEGER PRIMARY KEY             ││                  │
│  │  memory_session_id   TEXT UNIQUE FK ─────────────────┘│                  │
│  │  project             TEXT NOT NULL                    │                  │
│  │  request             TEXT                             │                  │
│  │  investigated        TEXT                             │                  │
│  │  learned             TEXT                             │                  │
│  │  completed           TEXT                             │                  │
│  │  next_steps          TEXT                             │                  │
│  │  notes               TEXT                             │                  │
│  │  prompt_number       INTEGER                          │                  │
│  │  discovery_tokens    INTEGER (ROI tracking)           │                  │
│  │  created_at_epoch    INTEGER NOT NULL                 │                  │
│  └───────────────────────────────────────────────────────┘                  │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                      FTS5 Virtual Tables                             │    │
│  │  ─────────────────────────────────────────────────────────────────  │    │
│  │  observations_fts        - Full-text search on observations          │    │
│  │    (title, subtitle, narrative, text, facts, concepts)               │    │
│  │                                                                      │    │
│  │  session_summaries_fts   - Full-text search on summaries             │    │
│  │    (request, investigated, learned, completed, next_steps, notes)    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Table Descriptions

#### `sdk_sessions`
Core session tracking table. Links Claude Code's `content_session_id` to internal `memory_session_id`.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-increment primary key |
| `content_session_id` | TEXT | Claude Code's session identifier (unique) |
| `memory_session_id` | TEXT | Internal memory session ID (unique) |
| `project` | TEXT | Project path (canonicalized) |
| `user_prompt` | TEXT | First user prompt that started the session |
| `status` | TEXT | `active` \| `completed` \| `failed` |
| `started_at_epoch` | INTEGER | Unix timestamp of session start |
| `completed_at_epoch` | INTEGER | Unix timestamp of session end |

#### `user_prompts`
Stores each user prompt submitted during a session.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-increment primary key |
| `content_session_id` | TEXT | FK to sdk_sessions |
| `prompt_number` | INTEGER | Sequential prompt number within session |
| `prompt_text` | TEXT | Full text of user's prompt |
| `created_at_epoch` | INTEGER | Unix timestamp |

#### `pending_messages`
Work queue for async processing. Messages are claimed and deleted atomically.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-increment primary key |
| `session_db_id` | INTEGER | FK to sdk_sessions.id |
| `content_session_id` | TEXT | Claude session ID |
| `message_type` | TEXT | `observation` \| `summarize` |
| `tool_name` | TEXT | Tool that was invoked |
| `tool_input` | TEXT | JSON-encoded tool input |
| `tool_response` | TEXT | JSON-encoded tool response |
| `status` | TEXT | `pending` \| `processing` \| `processed` \| `failed` |
| `retry_count` | INTEGER | Number of retry attempts |

#### `observations`
Extracted insights from tool usage. One session can have multiple observations.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-increment primary key |
| `memory_session_id` | TEXT | FK to sdk_sessions.memory_session_id |
| `project` | TEXT | Project path |
| `type` | TEXT | `decision` \| `bugfix` \| `feature` \| `refactor` \| `discovery` |
| `title` | TEXT | Short title for the observation |
| `subtitle` | TEXT | Additional context |
| `narrative` | TEXT | Detailed explanation |
| `text` | TEXT | Legacy field (deprecated) |
| `facts` | TEXT | JSON array of specific facts |
| `concepts` | TEXT | JSON array of concepts/keywords |
| `files_read` | TEXT | JSON array of files read |
| `files_modified` | TEXT | JSON array of files modified |
| `prompt_number` | INTEGER | Which prompt this relates to |
| `discovery_tokens` | INTEGER | Token cost for ROI tracking |

#### `session_summaries`
End-of-session summary. One per session (unique on memory_session_id).

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-increment primary key |
| `memory_session_id` | TEXT | FK to sdk_sessions (unique) |
| `project` | TEXT | Project path |
| `request` | TEXT | What the user requested |
| `investigated` | TEXT | What was explored |
| `learned` | TEXT | Key learnings |
| `completed` | TEXT | What was accomplished |
| `next_steps` | TEXT | Suggested follow-ups |
| `notes` | TEXT | Additional notes |
| `discovery_tokens` | INTEGER | Token cost for ROI tracking |

## ChromaDB Document Structure

Location: `~/.claude-mem/vector-db/`

ChromaDB provides semantic (vector) search capabilities. It mirrors data from SQLite with per-field document splitting for precise retrieval.

### Collection Naming

Collections are per-project: `cm__${project_name}`

### Document Splitting Strategy

Unlike traditional approaches that embed entire records, claude-mem splits each record into multiple documents by semantic field:

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Observation Record                              │
│  ─────────────────────────────────────────────────────────────────  │
│  id: 123                                                            │
│  title: "Fixed authentication bug"                                  │
│  narrative: "The auth flow was failing because..."                  │
│  facts: ["JWT expired early", "Clock skew issue"]                   │
└───────────────────────────────────┬─────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
            ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
            │ obs_123_     │ │ obs_123_     │ │ obs_123_     │
            │ narrative    │ │ fact_0       │ │ fact_1       │
            │              │ │              │ │              │
            │ "The auth    │ │ "JWT expired │ │ "Clock skew  │
            │  flow..."    │ │  early"      │ │  issue"      │
            └──────────────┘ └──────────────┘ └──────────────┘
```

### Document Types and ID Patterns

| Type | ID Pattern | Fields Embedded |
|------|------------|-----------------|
| Observation | `obs_{id}_narrative` | narrative |
| Observation | `obs_{id}_text` | text (legacy) |
| Observation | `obs_{id}_fact_{n}` | Each fact separately |
| Summary | `summary_{id}_request` | request |
| Summary | `summary_{id}_investigated` | investigated |
| Summary | `summary_{id}_learned` | learned |
| Summary | `summary_{id}_completed` | completed |
| Summary | `summary_{id}_next_steps` | next_steps |
| Summary | `summary_{id}_notes` | notes |
| User Prompt | `prompt_{id}` | prompt_text |

### Metadata Structure

Each Chroma document includes metadata linking back to SQLite:

```json
{
  "sqlite_id": 123,
  "doc_type": "observation",
  "memory_session_id": "mem_abc123",
  "project": "my-project",
  "created_at_epoch": 1704067200,
  "type": "bugfix",
  "title": "Fixed authentication bug",
  "field_type": "narrative",
  "concepts": "auth,jwt,security",
  "files_read": "src/auth.ts,src/utils.ts",
  "files_modified": "src/auth.ts"
}
```

### Sync Pattern: Fire-and-Forget

Chroma sync is asynchronous and non-blocking:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  SQLite Write   │ ──► │ Transaction     │ ──► │  Chroma Sync    │
│  (sync/atomic)  │     │   Commits       │     │  (async/non-    │
│                 │     │                 │     │   blocking)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                       │
                                                       ▼
                                                If sync fails:
                                                - Log warning
                                                - Continue without vector search
                                                - Data safe in SQLite
```

## Message Queue Processing

### Queue Lifecycle

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Enqueue    │ ──► │  Claim &     │ ──► │   Process    │
│   (hook)     │     │   Delete     │     │   (agent)    │
│              │     │   (atomic)   │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
      │                    │                    │
      │                    │                    │
      ▼                    ▼                    ▼
   status:              Message              Results
   'pending'            removed              stored in
                        from queue           observations/
                                            summaries
```

### Recovery Mechanism

On worker startup, pending messages are recovered:

1. Query `getSessionsWithPendingMessages()` for sessions with pending work
2. For each session, restart the SDK Agent processing loop
3. Messages stuck in `processing` state are reset to `pending`

## Hook → Storage Mapping

| Hook | Direct Storage | Queued Processing |
|------|----------------|-------------------|
| **SessionStart** | (read only) | - |
| **UserPromptSubmit** | `sdk_sessions` (upsert), `user_prompts` (insert) | Starts agent if messages pending |
| **PostToolUse** | `pending_messages` (insert) | Agent processes → `observations` |
| **Stop** | `pending_messages` (insert) | Agent processes → `session_summaries` |

## LLM Agent Processing

Claude-mem uses an LLM to analyze tool usage and extract structured observations. Three agent implementations are available:

### Available Agents

| Agent | API | Configuration | Use Case |
|-------|-----|---------------|----------|
| **SDKAgent** | Claude Agent SDK | `ANTHROPIC_API_KEY` | Default, uses Claude via official SDK |
| **GeminiAgent** | Google Gemini REST | `CLAUDE_MEM_GEMINI_API_KEY` | Free tier available, rate-limited |
| **OpenRouterAgent** | OpenRouter API | `CLAUDE_MEM_OPENROUTER_API_KEY` | Access 100+ models (GPT-4, Llama, Mistral, etc.) |

### Agent Processing Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         LLM AGENT PROCESSING                                 │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  STEP 1: Claim Message from Queue                                      │  │
│  │  ─────────────────────────────────────────────────────────────────────│  │
│  │  • PendingMessageStore.claimAndDelete() - atomic claim & remove        │  │
│  │  • Message contains: tool_name, tool_input, tool_response, cwd         │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                         │                                                    │
│                         ▼                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  STEP 2: Build Prompt                                                  │  │
│  │  ─────────────────────────────────────────────────────────────────────│  │
│  │  • buildInitPrompt() - First message in session                        │  │
│  │  • buildObservationPrompt() - Tool usage context                       │  │
│  │  • buildSummaryPrompt() - End-of-session summary request               │  │
│  │  • buildContinuationPrompt() - Subsequent messages                     │  │
│  │                                                                        │  │
│  │  Prompt includes: project name, tool data, extraction instructions     │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                         │                                                    │
│                         ▼                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  STEP 3: Call LLM API                                                  │  │
│  │  ─────────────────────────────────────────────────────────────────────│  │
│  │                                                                        │  │
│  │  SDKAgent:        query() from @anthropic-ai/claude-agent-sdk          │  │
│  │  GeminiAgent:     POST to generativelanguage.googleapis.com            │  │
│  │  OpenRouterAgent: POST to openrouter.ai/api/v1/chat/completions        │  │
│  │                                                                        │  │
│  │  Multi-turn conversation maintained for context continuity             │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                         │                                                    │
│                         ▼                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  STEP 4: Parse XML Response                                            │  │
│  │  ─────────────────────────────────────────────────────────────────────│  │
│  │  LLM returns structured XML:                                           │  │
│  │                                                                        │  │
│  │  <observation>                                                         │  │
│  │    <type>bugfix</type>                                                 │  │
│  │    <title>Fixed JWT authentication</title>                             │  │
│  │    <narrative>The auth flow was failing...</narrative>                 │  │
│  │    <facts>["JWT expired early", "Clock skew issue"]</facts>            │  │
│  │    <concepts>["auth", "jwt", "security"]</concepts>                    │  │
│  │    <files_modified>["src/auth.ts"]</files_modified>                    │  │
│  │  </observation>                                                        │  │
│  │                                                                        │  │
│  │  Parser: parseObservations(), parseSummary() in sdk/parser.ts          │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                         │                                                    │
│                         ▼                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  STEP 5: Response Processor                                            │  │
│  │  ─────────────────────────────────────────────────────────────────────│  │
│  │  • Atomic SQLite transaction (observations + summary)                  │  │
│  │  • Fire-and-forget ChromaDB sync                                       │  │
│  │  • SSE broadcast to web UI                                             │  │
│  │  • Track discovery_tokens for ROI metrics                              │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Prompt Types

| Prompt | When Used | Purpose |
|--------|-----------|---------|
| `buildInitPrompt()` | First message (prompt #1) | Establish context, project info |
| `buildObservationPrompt()` | PostToolUse hook | Extract insights from tool usage |
| `buildSummaryPrompt()` | Stop hook | Generate end-of-session summary |
| `buildContinuationPrompt()` | Subsequent prompts | Continue multi-turn conversation |

### XML Response Format

The LLM is instructed to return structured XML that can be parsed:

**Observation Response:**
```xml
<observation>
  <type>bugfix|feature|refactor|discovery|decision</type>
  <title>Short descriptive title</title>
  <subtitle>Additional context</subtitle>
  <narrative>Detailed explanation of what happened</narrative>
  <facts>["Specific fact 1", "Specific fact 2"]</facts>
  <concepts>["concept1", "concept2"]</concepts>
  <files_read>["path/to/file.ts"]</files_read>
  <files_modified>["path/to/changed.ts"]</files_modified>
</observation>
```

**Summary Response:**
```xml
<summary>
  <request>What the user asked for</request>
  <investigated>What was explored</investigated>
  <learned>Key learnings</learned>
  <completed>What was accomplished</completed>
  <next_steps>Suggested follow-ups</next_steps>
  <notes>Additional notes</notes>
</summary>
```

### Processing Pipeline

```
PostToolUse Hook                    Stop Hook
       │                                 │
       ▼                                 ▼
┌──────────────────┐            ┌──────────────────┐
│ pending_messages │            │ pending_messages │
│ type: observation│            │ type: summarize  │
└────────┬─────────┘            └────────┬─────────┘
         │                               │
         └───────────────┬───────────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │     SDK Agent       │
              │  (Claude API call)  │
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │  Response Processor │
              └──────────┬──────────┘
                         │
         ┌───────────────┴───────────────┐
         │                               │
         ▼                               ▼
┌──────────────────┐            ┌──────────────────┐
│   observations   │            │ session_summaries│
│   (SQLite)       │            │   (SQLite)       │
└────────┬─────────┘            └────────┬─────────┘
         │                               │
         └───────────────┬───────────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │     ChromaSync      │
              │   (fire-and-forget) │
              └─────────────────────┘
```

## Data Retrieval

### Full-Text Search (SQLite FTS5)

```sql
-- Search observations
SELECT * FROM observations
WHERE id IN (
  SELECT rowid FROM observations_fts
  WHERE observations_fts MATCH 'authentication bug'
);
```

### Semantic Search (ChromaDB)

```typescript
const results = await chromaSync.queryChroma(
  'how to fix auth issues',  // Natural language query
  10,                         // Limit
  { project: 'my-project' }   // Filter
);
// Returns: { ids, distances, metadatas }
```

### Hybrid Search Flow

The SearchManager combines both storage systems for optimal search. SQLite is **always** the source of truth; ChromaDB provides semantic ranking.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SEMANTIC SEARCH FLOW                                 │
│                                                                              │
│  User Query: "how did we fix the auth bug?"                                 │
│                         │                                                    │
│                         ▼                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  STEP 1: ChromaDB Semantic Search                                      │  │
│  │  ─────────────────────────────────────────────────────────────────────│  │
│  │  • Query converted to vector embedding                                 │  │
│  │  • ChromaDB finds semantically similar documents (top 100)             │  │
│  │  • Returns: IDs + distances + metadata                                 │  │
│  │                                                                        │  │
│  │  Result: [obs_123, obs_456, obs_789, summary_42, prompt_15, ...]      │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                         │                                                    │
│                         ▼                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  STEP 2: Recency Filter (90 days)                                      │  │
│  │  ─────────────────────────────────────────────────────────────────────│  │
│  │  • Filter results by created_at_epoch from metadata                    │  │
│  │  • Keep only recent results (within 90-day window)                     │  │
│  │                                                                        │  │
│  │  Result: [obs_123, obs_456, summary_42] (filtered)                    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                         │                                                    │
│                         ▼                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  STEP 3: SQLite Hydration                                              │  │
│  │  ─────────────────────────────────────────────────────────────────────│  │
│  │  • Take IDs from Chroma results                                        │  │
│  │  • Fetch FULL records from SQLite using getObservationsByIds()         │  │
│  │  • SQLite has complete data (narrative, facts, files, etc.)            │  │
│  │                                                                        │  │
│  │  Result: Full observation/summary/prompt objects with all fields       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                         │                                                    │
│                         ▼                                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  STEP 4: Return Formatted Results                                      │  │
│  │  ─────────────────────────────────────────────────────────────────────│  │
│  │  • Results ranked by Chroma's semantic relevance                       │  │
│  │  • Complete data from SQLite for display                               │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why Dual Storage?

| Storage | Role | Strengths |
|---------|------|-----------|
| **SQLite** | Source of truth | Complete data, relational queries, ACID transactions, FTS5 keyword search, date filtering |
| **ChromaDB** | Semantic index | Vector similarity, understands "meaning" not just keywords, conceptual matching |

### Search Strategy Selection

| Query Type | Strategy | Execution Path |
|------------|----------|----------------|
| `query="auth bug"` | **Vector-first** | Chroma semantic → recency filter → SQLite hydrate |
| `query=null, dateStart="2024-01-01"` | **Filter-only** | Direct SQLite (Chroma cannot filter by date) |
| `concept="authentication"` | **Metadata-first** | SQLite filter by concept → Chroma re-rank by relevance |
| `type="decision"` | **Metadata-first** | SQLite filter by type → Chroma semantic ranking |
| `files="src/auth.ts"` | **Metadata-first** | SQLite filter by file → Chroma re-rank |

### Code Example: Hybrid Search

From `SearchManager.ts`:

```typescript
// PATH 2: CHROMA SEMANTIC SEARCH (query text + Chroma available)
if (this.chromaSync) {
  // Step 1: Chroma semantic search (top 100)
  const chromaResults = await this.queryChroma(query, 100, whereFilter);

  if (chromaResults.ids.length > 0) {
    // Step 2: Filter by recency (90 days)
    const ninetyDaysAgo = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
    const recentIds = chromaResults.ids.filter((_id, idx) => {
      const meta = chromaResults.metadatas[idx];
      return meta && meta.created_at_epoch > ninetyDaysAgo;
    });

    // Step 3: Categorize IDs by document type
    for (const item of recentMetadata) {
      const docType = item.meta?.doc_type;
      if (docType === 'observation') obsIds.push(item.id);
      else if (docType === 'session_summary') sessionIds.push(item.id);
      else if (docType === 'user_prompt') promptIds.push(item.id);
    }

    // Step 4: Hydrate from SQLite with additional filters
    observations = this.sessionStore.getObservationsByIds(obsIds, obsOptions);
    sessions = this.sessionStore.getSessionSummariesByIds(sessionIds, {...});
    prompts = this.sessionStore.getUserPromptsByIds(promptIds, {...});
  }
}
```

### Document Splitting Benefits

ChromaDB stores split documents (not full records), which improves search precision:

```
Observation #123 in SQLite (single record with 20+ fields):
├── title: "Fixed JWT auth"
├── narrative: "The authentication flow was failing because..."
├── facts: ["JWT expired early", "Clock skew issue"]
└── concepts: ["auth", "jwt", "security"]

Same record in ChromaDB (split into multiple vector documents):
├── obs_123_narrative → "The authentication flow was failing..."
├── obs_123_fact_0    → "JWT expired early"
└── obs_123_fact_1    → "Clock skew issue"
```

**Why split?** Searching "clock skew" matches the exact fact document with high confidence, rather than matching a large blob where "clock skew" is buried in noise.

### Fallback Behavior

When ChromaDB is unavailable (not installed, connection failed):

1. **Filter-only queries** (no query text): Work normally via direct SQLite
2. **Semantic queries** (with query text): Return error suggesting to install uv/Python
3. **Data integrity**: Never affected - SQLite is always the source of truth

## Data Retention Policy

### No Automatic Deletion

**Claude-mem follows an "EVERYTHING SHOULD SAVE ALWAYS" philosophy.** Data is never automatically deleted.

| Data Type | Retention | Notes |
|-----------|-----------|-------|
| `observations` | **Forever** | Never auto-deleted |
| `session_summaries` | **Forever** | Never auto-deleted |
| `user_prompts` | **Forever** | Never auto-deleted |
| `sdk_sessions` | **Forever** | Never auto-deleted |
| `pending_messages` | Until processed | Deleted after successful processing |
| ChromaDB vectors | **Forever** | Mirrors SQLite data |

### 90-Day Search Window (Not Deletion)

The 90-day window mentioned in code is for **search result filtering**, not data deletion:

```typescript
// From src/services/worker/search/types.ts
export const SEARCH_CONSTANTS = {
  RECENCY_WINDOW_DAYS: 90,
  RECENCY_WINDOW_MS: 90 * 24 * 60 * 60 * 1000,  // ~7.78 billion ms
  DEFAULT_LIMIT: 20,
  CHROMA_BATCH_SIZE: 100
};
```

**What this means:**
- Semantic search prioritizes results from the last 90 days
- Older data **still exists** in both SQLite and ChromaDB
- You can still query older data using:
  - Direct SQLite queries
  - Filter-only searches with date ranges
  - The `get_observations` MCP tool with specific IDs

### Manual Cleanup Options

If you need to delete data, use manual tools:

```bash
# Remove duplicate observations/summaries (keeps newest)
bun run src/bin/cleanup-duplicates.ts

# Direct SQLite access (use with caution)
sqlite3 ~/.claude-mem/claude-mem.db "DELETE FROM observations WHERE ..."
```

### Why No Auto-Deletion?

1. **Memory is the core value** - Deleting memories defeats the purpose
2. **Storage is cheap** - SQLite + ChromaDB are efficient
3. **Unexpected data loss is worse** - Users should explicitly choose to delete
4. **Regulatory compliance** - Some users may need audit trails

## File Locations Summary

| Component | Path |
|-----------|------|
| SQLite Database | `~/.claude-mem/claude-mem.db` |
| ChromaDB Store | `~/.claude-mem/vector-db/` |
| Settings | `~/.claude-mem/settings.json` |
| Plugin Scripts | `~/.claude/plugins/marketplaces/thedotmack/scripts/` |
| Viewer UI | `http://localhost:37777` |
