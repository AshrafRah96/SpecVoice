export interface Decision {
  id: string
  summary: string
  rationale: string
  alternativesConsidered: string[]
  relevantFiles: string[]
  timestamp: string
}

export interface OpenQuestion {
  id: string
  question: string
  context: string
  timestamp: string
}

export interface FileRead {
  path: string
  timestamp: string
  characterCount: number
}

export type SessionStatus = 'active' | 'complete' | 'error'

export interface Session {
  id: string
  repoUrl?: string
  repoLocalPath?: string
  decisions: Decision[]
  openQuestions: OpenQuestion[]
  filesRead: FileRead[]
  specOutput?: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
}

export interface SessionEvent {
  type: 'session_updated'
  session: Session
}
