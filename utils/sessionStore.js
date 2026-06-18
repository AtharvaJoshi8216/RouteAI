const sessions = new Map();

/*
sessionId -> {

  provider,

  taskType,

  complexity,

  messages: [],

  createdAt,

  lastUsed

}
*/

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function setSession(sessionId, provider, taskType, complexity) {

  const existing =
    sessions.get(sessionId);

  if (existing) {

    existing.provider = provider;

    if (taskType)
        existing.taskType = taskType;

    if (complexity)
        existing.complexity = complexity;

    existing.lastUsed = Date.now();

    return;
}

  sessions.set(sessionId, {

    provider,

    taskType,

    complexity,

    messages: [],

    createdAt: Date.now(),

    lastUsed: Date.now(),

  });
}

function updateSession(sessionId) {

  const session =
    sessions.get(sessionId);

  if (session) {
    session.lastUsed = Date.now();
  }
}

function addMessage(
  sessionId,
  role,
  content
) {

  const session =
    sessions.get(sessionId);

  if (!session) return;

  session.messages.push({
    role,
    content,
  });

  // KEEP LAST 6 MESSAGES ONLY

  if (session.messages.length > 6) {
    session.messages.shift();
  }
}

function getMessages(sessionId) {

  const session =
    sessions.get(sessionId);

  return session?.messages || [];
}

function clearMessages(sessionId) {

  const session =
    sessions.get(sessionId);

  if (session) {
    session.messages = [];
  }
}

function getTaskType(sessionId) {

    return sessions.get(sessionId)?.taskType;

}

function getComplexity(sessionId) {

    return sessions.get(sessionId)?.complexity;

}

module.exports = {
  getSession,
  setSession,
  updateSession,
  addMessage,
  getMessages,
  clearMessages,
  getTaskType,
  getComplexity
};