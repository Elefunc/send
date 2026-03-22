/// <reference lib="webworker" />
import { crawlWorkspaceEntries, searchEntries, searchResultSignature, type IndexedEntry } from "./file-search"
import { FILE_SEARCH_RESULT_LIMIT, type FileSearchEvent, type FileSearchRequest } from "./file-search-protocol"

type WorkerSession = {
  sessionId: string
  workspaceRoot: string
  resultLimit: number
  latestQuery: string
  queryActive: boolean
  walkComplete: boolean
  disposed: boolean
  entries: IndexedEntry[]
  pendingNotify: ReturnType<typeof setTimeout> | null
  lastSignature: string | null
  completedQuery: string | null
  rootError: string | null
}

const sessions = new Map<string, WorkerSession>()

const emit = (event: FileSearchEvent) => postMessage(event)
const emitError = (session: WorkerSession, message: string) => emit({
  type: "error",
  sessionId: session.sessionId,
  query: session.latestQuery,
  message,
})

const emitCompleteIfNeeded = (session: WorkerSession) => {
  if (!session.walkComplete || !session.queryActive || session.completedQuery === session.latestQuery) return
  session.completedQuery = session.latestQuery
  emit({ type: "complete", sessionId: session.sessionId, query: session.latestQuery })
}

const recompute = (session: WorkerSession) => {
  if (session.disposed || !session.queryActive) return
  const matches = searchEntries(session.entries, session.latestQuery, session.resultLimit)
  const signature = searchResultSignature(session.latestQuery, matches, session.walkComplete)
  if (signature !== session.lastSignature) {
    session.lastSignature = signature
    emit({
      type: "update",
      sessionId: session.sessionId,
      query: session.latestQuery,
      matches,
      walkComplete: session.walkComplete,
    })
  }
  emitCompleteIfNeeded(session)
}

const scheduleRecompute = (session: WorkerSession) => {
  if (session.disposed || !session.queryActive || session.pendingNotify !== null) return
  session.pendingNotify = setTimeout(() => {
    session.pendingNotify = null
    recompute(session)
  }, 12)
}

const createSession = async (request: Extract<FileSearchRequest, { type: "create-session" }>) => {
  const previous = sessions.get(request.sessionId)
  if (previous) {
    previous.disposed = true
    if (previous.pendingNotify) clearTimeout(previous.pendingNotify)
    sessions.delete(request.sessionId)
  }
  const session: WorkerSession = {
    sessionId: request.sessionId,
    workspaceRoot: request.workspaceRoot,
    resultLimit: request.resultLimit ?? FILE_SEARCH_RESULT_LIMIT,
    latestQuery: "",
    queryActive: false,
    walkComplete: false,
    disposed: false,
    entries: [],
    pendingNotify: null,
    lastSignature: null,
    completedQuery: null,
    rootError: null,
  }
  sessions.set(session.sessionId, session)

  try {
    await crawlWorkspaceEntries(session.workspaceRoot, entry => {
      if (session.disposed) return
      session.entries.push(entry)
      scheduleRecompute(session)
    })
    session.walkComplete = true
    recompute(session)
  } catch (error) {
    session.rootError = error instanceof Error ? error.message : `${error}`
    session.walkComplete = true
    emitError(session, session.rootError)
  }
}

const updateQuery = (request: Extract<FileSearchRequest, { type: "update-query" }>) => {
  const session = sessions.get(request.sessionId)
  if (!session || session.disposed) return
  session.latestQuery = request.query
  session.queryActive = true
  session.completedQuery = null
  session.lastSignature = null
  if (session.rootError) {
    emitError(session, session.rootError)
    return
  }
  recompute(session)
}

const disposeSession = (request: Extract<FileSearchRequest, { type: "dispose-session" }>) => {
  const session = sessions.get(request.sessionId)
  if (!session) return
  session.disposed = true
  if (session.pendingNotify) clearTimeout(session.pendingNotify)
  sessions.delete(request.sessionId)
}

self.onmessage = (event: MessageEvent<FileSearchRequest>) => {
  const request = event.data
  if (!request || typeof request !== "object") return
  if (request.type === "create-session") void createSession(request)
  if (request.type === "update-query") updateQuery(request)
  if (request.type === "dispose-session") disposeSession(request)
}
