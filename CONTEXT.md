# Loop

Loop is a teaching-oriented Agent learning workbench, used first by its author and shaped by real experiments.

## Language

**Learning Workbench**:
An environment for learning Agent behavior by running tasks, following the relationships between model requests, tool actions and returned results, relating evidence to core code, and changing conditions to test understanding.
_Avoid_: Trace display alone, code-writing quota, generic framework showcase

**Run**:
One submitted task and its bounded execution, including model requests, tool calls, and its stopping outcome.
_Avoid_: A guaranteed successful task, an entire user's history

**Trace Event**:
A recorded action or control decision with its actual inputs, outputs, timing, and related code.
_Avoid_: Reconstructed model reasoning, fabricated evidence

**Trace Relationship**:
An observable connection between a request, an action, its returned result, and a later request, supported by the recorded run evidence.
_Avoid_: Time adjacency alone, an invented explanation of the model's internal reasoning

**Task Conversation**:
A sequence of user requests and Agent responses directed toward carrying out a task.
_Avoid_: A learning question about an already recorded action

**Learning Question**:
A question about a selected run or event, answered from recorded evidence to help the learner understand its behavior without continuing the task's actions.
_Avoid_: An implicit instruction to execute another tool or resume a task

**Historical Run**:
A preserved record of an ended run, inspected using the evidence and code captured at that time. Viewing it does not execute actions or continue the original task.
_Avoid_: Live task, automatic recovery, current workspace state

**Task Acceptance**:
A judgment about whether the delivered result satisfies the user's task, based on evidence beyond the runtime stopping normally.
_Avoid_: Model self-report, run completion alone

**Learning Progress**:
The author's ability to predict, explain, and independently change Agent behavior. AI may write most code; hearing an explanation alone does not establish mastery.
_Avoid_: Lines hand-written, successful assistant test run, repository size
