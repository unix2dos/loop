# Loop

Loop is a teaching-oriented Agent learning workbench, used first by its author and shaped by real experiments.

## Language

**Learning Workbench**:
An environment for learning Agent behavior by running tasks, following the relationships between model requests, tool actions and returned results, relating evidence to core code, and changing conditions to test understanding.
_Avoid_: Trace display alone, code-writing quota, generic framework showcase

**Run**:
One submitted task and its bounded execution, including model requests, tool calls, and its stopping outcome.
_Avoid_: A guaranteed successful task, an entire user's history

**Harness**:
The runtime surrounding the model that prepares context, routes tool calls, returns tool results, enforces execution limits, and records what happened. A Harness control event is one observable action of that runtime, not its full set of responsibilities.
_Avoid_: The model itself, a model message role, tool dispatch alone

**Model Round**:
One model request and the tool processing it initiates before the next model request or the end of the run. Several tool calls proposed together belong to the same model round; a request with no tool calls is also a model round.
_Avoid_: User conversation turn, one round per tool call, a completed user task

**Conversation Turn**:
One user request and the Agent's work toward responding to it, potentially spanning several model rounds.
_Avoid_: One model request, one tool call

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
