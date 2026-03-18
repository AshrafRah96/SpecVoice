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

export type BuildStatus = 'idle' | 'ready' | 'building' | 'complete' | 'error'

export type BuildPhase = 'analyzing' | 'writing' | 'reviewing'

export interface ComplexityAssessment {
  level: 'low' | 'medium' | 'high'
  reasoning: string
}

export interface Session {
  id: string
  repoUrl?: string
  repoLocalPath?: string
  decisions: Decision[]
  openQuestions: OpenQuestion[]
  filesRead: FileRead[]
  specOutput?: string
  status: SessionStatus
  callDurationSecs: number | null
  transcript: string | null
  buildStatus: BuildStatus
  prUrl: string | null
  complexityAssessment: ComplexityAssessment | null
  createdAt: string
  updatedAt: string
}

export type SessionEvent =
  | { type: 'session_updated'; session: Session }
  | { type: 'call_ended'; sessionId: string; callDurationSecs: number | null }
