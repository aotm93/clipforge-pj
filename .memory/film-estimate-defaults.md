---
name: Match film estimates to submitted defaults
description: Film previews and spending caps must use the same resolution and total segment duration as paid submissions.
type: feedback
---

**Why**

The film endpoint now defaults paid requests to 768p (1365 by 768, or 768 by 1365 for portrait), while an estimate without dimensions applies the lowest price tier. Estimating only the first segment understates the cost of a film split across multiple requests.

**How to apply**

Apply the same output defaults to previews, spending gates and paid submissions. Estimate the sum of all requested segment durations. Include the selected provider's base URL and the actual video parameters in preview requests, and require confirmation again when the model or estimate changes.

**Related**

[[film-selected-model]]
