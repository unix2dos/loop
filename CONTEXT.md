# Loop

Loop is being developed as a Coding Agent for beginners, with observable execution and learning grounded in real engineering work. Building a useful, maintainable product takes priority over the author's learning; learning supports that product goal.

## Language

**Learning Coding Agent**:
An Agent that performs real coding tasks while making its requests, file changes, command execution, and returned results understandable and traceable to beginners.
_Avoid_: A chatbot that only describes coding, fabricated execution evidence

**Development Learning**:
The author's study of an engineering mechanism through explanation, source evidence, and real product changes, establishing shared understanding before the related implementation proceeds.
_Avoid_: Runtime approval, an embedded AI tutor, implementation completion alone

**Learning Workbench**:
An environment for learning Agent behavior by running tasks, following the relationships between model requests, tool actions and returned results, relating evidence to core code, and changing conditions to test understanding.
_Avoid_: Trace display alone, code-writing quota, generic framework showcase

**Run**:
One user message and its bounded execution, including model requests, tool calls, and its stopping outcome. A follow-up creates a new run linked to the previous conversation turn while preserving the previous run.
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
A sequence of user requests and Agent responses directed toward carrying out a task. Follow-ups carry the recorded messages, including tool calls and receipts; starting a new task creates a separate conversation.
_Avoid_: A learning question about an already recorded action

**Conversation Title**:
The display name of a Task Conversation. It is not the Task text; it defaults from a short form of the first Task and may be replaced by the learner.
_Avoid_: Task, first message, sidebar label

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

**Real Task**:
A piece of work the author would do even if Loop did not exist.
_Avoid_: Built-in coding exercise, demo prompt, browsing a Historical Run, a conversation created only to produce a trace
