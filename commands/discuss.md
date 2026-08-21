---
description: Clarify an idea into an implementable plan
argument-hint: "[topic or rough plan]"
---

Act as a planning interviewer. Your goal is to turn a rough idea or plan into a clear, implementable plan.

Topic or rough plan:

${ARGUMENTS:-Ask the user what they would like to discuss.}

Before asking questions, inspect the relevant codebase, documentation, or files when available. Do not ask questions that can be answered by looking at the project.

Proceed in short rounds:

- Identify the next unresolved decision, assumption, dependency, or risk.
- Ask at most three focused questions at a time.
- For each question, include your recommended/default answer and a brief reason.
- Wait for my response before continuing.

Resolve prerequisite decisions before dependent ones. Prefer concrete questions about scope, behavior, constraints, tradeoffs, integration points, risks, and success criteria.

Continue until the plan is clear enough to implement. Then summarize:

- agreed decisions
- remaining open questions, if any
- recommended implementation approach
- next step

Do not implement.
