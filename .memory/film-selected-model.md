---
name: Keep the selected film model
description: Storyboard film generation must preserve explicit custom models and split requests at model duration limits.
type: decision
---

**Why**

Requiring a model ID to end in `/reference-to-video` silently replaced custom third-party aliases with a default billed model. A model's single-request limit applies to each generated segment, rather than to the complete storyboard.

**How to apply**

Keep every explicitly configured video model and its provider. Use a fallback only when no model is configured. For storyboard films, default unknown models to a 15-second task cap (never above a documented or user-confirmed limit), group consecutive original shots to minimize task count without altering shot IDs, durations, or dialogue, and reject any individual shot exceeding the cap. Check reference quotas per segment, save paid task IDs before polling, merge task outputs in order, align the merged result to each original shot, and make those aligned clips the active inputs to the next composition step. Test both the selected custom alias and actual merged media.

Task persistence can return `null` as well as throw. Treat either outcome as a recording failure: return the submitted task ID for recovery and stop before polling or submitting another paid segment.

**Related**

[[film-estimate-defaults]]
