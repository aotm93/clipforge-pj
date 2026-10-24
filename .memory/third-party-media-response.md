---
name: Parse the documented ai778 media response envelope
description: ai778 creation returns data.task_id while polling can return top-level fields.
type: bugfix
---

**Why**

The hailuo-h3-cankaosheng creation success example returns {code:200,msg,data:{task_id,"任务ids":[id]}}. Reading only top-level task_id caused a paid task to be created without recording or polling its result.

**How to apply**

Accept data.task_id and legacy top-level task_id; accept a single ID in task_ids or 任务ids as fallback. Unwrap data for status responses too, check API-level error codes, and keep paid creation requests non-idempotent. Persist the returned task ID before polling. Use state/is_final and result_url, not the human-readable Chinese status. Missing IDs must warn about possible submission and duplicate charges without dumping response contents. Test the documented nested creation response through the existing storyboard-film route and asset persistence.

**Related**

[[film-selected-model]]
[[film-estimate-defaults]]
