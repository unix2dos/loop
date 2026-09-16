# Levon

Levon is an Agent learning workbench, used first by its author and shaped by real experiments.

## Language

**Learning Workbench**:
An environment for inspecting Agent runs, relating evidence to core code, and changing conditions to test understanding.
_Avoid_: Trace display alone, code-writing quota, generic framework showcase

**Run**:
One submitted task and its bounded execution, including model requests, tool calls, and its stopping outcome.
_Avoid_: A guaranteed successful task, an entire user's history

**Trace Event**:
A recorded action or control decision with its actual inputs, outputs, timing, and related code.
_Avoid_: Reconstructed model reasoning, fabricated evidence

**Task Acceptance**:
A judgment about whether the delivered result satisfies the user's task, based on evidence beyond the runtime stopping normally.
_Avoid_: Model self-report, run completion alone

**Learning Progress**:
The author's ability to predict, explain, and independently change Agent behavior. AI may write most code; hearing an explanation alone does not establish mastery.
_Avoid_: Lines hand-written, successful assistant test run, repository size
