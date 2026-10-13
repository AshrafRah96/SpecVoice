import type { SessionStore } from './store'

type RepositoryMethod =
  | 'createSession'
  | 'getSession'
  | 'listSessions'
  | 'updateSession'
  | 'setBuildStatus'
  | 'setPrUrl'
  | 'setComplexityAssessment'
  | 'addDecision'
  | 'recordFileRead'
  | 'flagQuestion'
  | 'setSpec'
  | 'endCall'
  | 'tryStartBuild'
  | 'blockBuild'
  | 'failBuild'
  | 'emitBuildProgress'
  | 'completeBuild'
  | 'getSnapshot'
  | 'readEvents'
  | 'watch'

// Memory stays synchronous for domain tests; callers await either adapter.
export type SessionRepository = {
  [K in RepositoryMethod]: (
    ...args: Parameters<SessionStore[K]>
  ) => ReturnType<SessionStore[K]> | Promise<ReturnType<SessionStore[K]>>
}
