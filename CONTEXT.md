# asenq

asenq is a local messaging context for named, top-level coding-agent sessions and a human participant. It moves messages between participants; it does not own tasks or coordinate their work.

## Participants

**Harness**:
A coding-agent environment that hosts sessions, such as Claude Code, OpenCode, or omp.

**Session**:
A registered top-level conversation in a harness that can send and receive direct messages. Subagents are not sessions in asenq.
_Avoid_: Agent, worker

**Session name**:
The unique address by which other participants reach a session; no live session may take a name another live session holds or still answers to as a former name. A temporarily disconnected session can retain its name while awaiting reconnection.
_Avoid_: Harness name

**Default name**:
The name a session gets when it registers without one: its harness followed by a word pair, such as `claude-arctic-fox`. The same harness session always gets the same default name.
_Avoid_: Random name, generated id

**Session identity**:
The durable identity of a session across name changes, harness resumes and temporary disconnections. A later session reusing its name has a different identity.
_Avoid_: Session name

**Former name**:
A name a session identity used to have. Messages addressed to a former name reach the same identity until the session is closed.
_Avoid_: Alias

**Replacement**:
The human's or an orchestrator's act of moving a session identity's role, channel memberships and waiting messages onto a newly registered session that asenq did not recognise as the same one.
_Avoid_: Rejoin

**Role**:
What a session does in a group of sessions: **orchestrator** (directs work) or **worker** (does the work it is given). A role tells the session its job; it is not an address.
_Avoid_: Manager, agent type

**Human**:
The person who sends direct messages and receives replies at a reserved address, rather than as a registered session.
_Avoid_: Human session

## Exchanges

**Direct message**:
Text addressed to a session or the human. A broadcast produces a separate direct message for each live target session.
_Avoid_: Channel post, task

**Broadcast**:
A direct-message send to every live session that shares a channel with the sending session; a sender in no channel reaches every live session. The human is not a broadcast target.
_Avoid_: Channel post

**Channel**:
A named, shared stream of posts that participants read on demand. A channel has members, any mix of orchestrators and workers; a post reaches a member only by mentioning it.
_Avoid_: Room, group chat

**Channel member**:
A session listed as belonging to a channel. Membership groups sessions so participants can see who works together; it does not by itself make a post a delivery.
_Avoid_: Recipient, subscriber

**Mention**:
A channel member's name, a role (every member with that role), or `all` (every other member), marked in a channel post so that the post is also delivered to those members as a direct message. Only members can be mentioned; the human never is.
_Avoid_: Subscription

**Channel post**:
Text recorded in a channel for later reading, without a recipient or delivery state.
_Avoid_: Direct message

**Inbox**:
A participant's view of recent direct messages addressed to it, distinct from channel history.
_Avoid_: Channel

**Session conversation**:
The chronological direct-message history involving one session identity, including its exchanges with the human and with other sessions. It is not a thread.
_Avoid_: Thread

**Archived conversation**:
A removed session's conversation, readable while its messages are retained. A session asenq removed on its own still receives queued messages until retention removes it; a closed session's conversation receives nothing.
_Avoid_: Gone session

**Stale session**:
A session that is disconnected, or did not answer its most recent ping. A running session that has simply been quiet is not stale. Only stale sessions are closed by "close all stale".
_Avoid_: Idle session

**Closed session**:
A session the human removed on purpose before asenq would have removed it on its own. Its conversation becomes an archived conversation.
_Avoid_: Deleted session

**Purge**:
The human's permanent deletion of archived conversations and removed session identities, ahead of normal retention.
_Avoid_: Close, prune

**Inbox position**:
A session identity's own reading position in its inbox, measured in the order messages were delivered to it. Asking for unread messages returns those delivered after it, oldest delivery first, and moves it past what was returned; a held or queued message becomes unread only once it is delivered. It is separate from the human's read markers.
_Avoid_: Read marker, cursor

**Read marker**:
The human's shared reading position for incoming messages from one session or posts in one channel, independent of delivery status.
_Avoid_: Delivery receipt

**Unread reminder**:
One eligible message deliberately marked unread without moving the read marker back across the rest of the conversation or channel.
_Avoid_: Queued message

## Message meaning and delivery

**Message kind**:
An optional label on a direct message—chat, task, result, status, or control—not a managed task or workflow state.

**Control message**:
A direct message of kind control asking the target to pause, resume, or cancel its current work. asenq marks it urgent; it does not stop the session itself.
_Avoid_: Command

**File reference**:
A path, content hash, and short summary carried by a direct message in place of a long body, read by the receiver on demand.
_Avoid_: Attachment
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
An admitted direct message waiting for delivery to its target session identity, including while that session is offline, until it returns or the message expires.
_Avoid_: Held message

**Delivered message**:
A direct message accepted by the target's delivery mechanism; delivery does not establish that an agent has read or acted on it.
_Avoid_: Read message

**Replied message**:
A delivered direct message that a later message references as the one it answers.
_Avoid_: Read message, acknowledged

**Delivery notice**:
A status message from asenq to a live agent sender when its direct message fails or expires without delivery.
_Avoid_: Reply
