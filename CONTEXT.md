# asenq

asenq is a local messaging context for named, top-level coding-agent sessions and a human participant. It moves messages between participants; it does not own tasks or coordinate their work.

## Participants

**Harness**:
A coding-agent environment that hosts sessions, such as Claude Code, OpenCode, or omp.

**Session**:
A registered top-level conversation in a harness that can send and receive direct messages. Subagents are not sessions in asenq.
_Avoid_: Agent, worker

**Session name**:
The unique address by which other participants reach a session. A temporarily disconnected session can retain its name while awaiting reconnection.
_Avoid_: Harness name

**Human**:
The person who sends direct messages and receives replies at a reserved address, rather than as a registered session.
_Avoid_: Human session

## Exchanges

**Direct message**:
Text addressed to a session or the human. A broadcast produces a separate direct message for each live target session.
_Avoid_: Channel post, task

**Broadcast**:
A direct-message send to every live session other than the sending session; the human is not a broadcast target.
_Avoid_: Channel post

**Channel**:
A named, shared stream of posts that participants read on demand; it has no recipients or membership.
_Avoid_: Room, group chat

**Channel post**:
Text recorded in a channel for later reading, without a recipient or delivery state.
_Avoid_: Direct message

**Inbox**:
A participant's view of recent direct messages addressed to it, distinct from channel history.
_Avoid_: Channel

## Message meaning and delivery

**Message kind**:
An optional label on a direct message—chat, task, result, or status—not a managed task or workflow state.
_Avoid_: Task state

**Thread**:
An optional free-form label grouping related direct messages; it does not create a managed conversation or task.
_Avoid_: Task

**Reply reference**:
An optional reference to the message being answered, independent of the thread label.
_Avoid_: Thread

**Done marker**:
A sender's optional indication that a direct message is final for a task or thread; it does not close a session or complete a managed task.
_Avoid_: Task completion

**Inbound policy**:
A session's choice to accept, hold, or refuse incoming direct messages. Hold reserves agent-sent messages for a human decision; human-sent messages bypass hold, while refuse rejects both.
_Avoid_: Delivery state

**Held message**:
An agent-sent direct message awaiting a human decision to release it for delivery or drop it.
_Avoid_: Queued message

**Queued message**:
An admitted direct message waiting for delivery to its target session, including when that session is temporarily unavailable.
_Avoid_: Held message

**Delivered message**:
A direct message accepted by the target's delivery mechanism; delivery does not establish that an agent has read or acted on it.
_Avoid_: Read message

**Delivery notice**:
A status message from asenq to a live agent sender when its direct message fails or expires without delivery.
_Avoid_: Reply
