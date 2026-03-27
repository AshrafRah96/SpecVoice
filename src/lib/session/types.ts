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

export type BuildStatus = 'idle' | 'ready' | 'building' | 'complete' | 'failed'

export type BuildPhase = 'analyzing' | 'writing' | 'reviewing' | 'cloning' | 'pr'

export interface ComplexityAssessment {
  fileCount: number
  openQuestionCount: number
  lineEstimate: number          // fileCount * 50
  size: 'small' | 'medium' | 'large' | 'too_large'
  blocked: boolean
  blockReason?: 'too_large' | 'open_questions'
  splitSuggestion?: string[][]  // files grouped by top-level directory, only when blocked
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
  | { type: 'build_started'; sessionId: string }
  | { type: 'build_progress'; phase: BuildPhase; detail: string }
  | { type: 'build_complete'; sessionId: string; prUrl: string }
  | { type: 'build_failed'; sessionId: string; error: string }
  | { type: 'build_blocked'; sessionId: string; assessment: ComplexityAssessment }
