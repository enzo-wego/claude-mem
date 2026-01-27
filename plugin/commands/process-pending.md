---
description: "Trigger processing of pending messages in the queue"
argument-hint: "[session_limit] - max sessions to process (default: 50)"
---

You are helping the user trigger processing of pending messages in the claude-mem queue.

## Step 1: Check current queue status

First, show the user what's pending:

```bash
curl -s http://127.0.0.1:37777/api/pending-queue | jq '{
  pending: .queue.totalPending,
  processing: .queue.totalProcessing,
  failed: .queue.totalFailed,
  stuck: .queue.stuckCount,
  sessionsWithWork: (.sessionsWithPendingWork | length)
}'
```

If there are no pending messages, inform the user and stop.

## Step 2: Trigger processing

```bash
curl -s -X POST http://127.0.0.1:37777/api/pending-queue/process \
  -H "Content-Type: application/json" \
  -d '{"sessionLimit": ${ARGUMENTS:-50}}'
```

## Step 3: Report results

Parse the response and report:
- How many sessions were started
- How many were skipped (already running)
- Total sessions with pending work

If `sessionsStarted > 0`, inform the user that processing has begun and they can check progress in the viewer UI at http://localhost:37777.
