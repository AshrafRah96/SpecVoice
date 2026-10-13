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

export type RepositoryTier = 'small' | 'mid' | 'large' | 'very-large'

export type RepositoryIndexStatus = 'pending' | 'indexing' | 'ready' | 'partial' | 'failed' | 'expired'

export interface RepositoryProfile {
  repositorySha: string
  fileCount: number
  byteCount: number
  languages: Record<string, number>
  packages: Array<{ path: string; manifest: string; fileCount: number }>
  generatedRoots: string[]
  vendorRoots: string[]
  treeComplete: boolean
  indexStatus: Exclude<RepositoryIndexStatus, 'pending' | 'indexing' | 'expired'>
  tier: RepositoryTier
  error?: string
  profiledAt: string
}

export interface ScopePlan {
  id: string
  repositorySha: string
  includedRoots: string[]
  excludedRoots: string[]
  estimatedFiles: number
  estimatedBytes: number
  dependencyBoundaries: string[]
  reason: string
  status: 'proposed' | 'confirmed' | 'rejected'
  createdAt: string
  confirmedAt?: string
}

export interface RepositorySnapshot {
  profileLease?: string
  id: string
  sessionId: string
  source: { repoUrl?: string; repoLocalPath?: string }
  repositorySha: string | null
  indexStatus: RepositoryIndexStatus
  profile: RepositoryProfile | null
  scopePlan: ScopePlan | null
  createdAt: string
  updatedAt: string
}

export type BuildStatus = 'idle' | 'ready' | 'building' | 'complete' | 'failed'

export type BuildPhase = 'analyzing' | 'writing' | 'reviewing' | 'cloning' | 'pr'

export interface ComplexityAssessment {
  fileCount: number
  openQuestionCount: number
  lineEstimate: number // fileCount * 50
  size: 'small' | 'medium' | 'large' | 'too_large'
  blocked: boolean
  blockReason?: 'too_large' | 'open_questions'
  splitSuggestion?: string[][] // files grouped by top-level directory, only when blocked
}

export interface Session {
  id: string
  currentCallId?: string | null
  callState?: 'active' | 'awaiting_transcript' | 'complete' | 'failed'
  callExpiresAt?: string
  repoUrl?: string
  repoLocalPath?: string
  /** Immutable repository revision selected when the session starts. */
  repositorySha?: string | null
  scopePlan?: ScopePlan | null
  decisions: Decision[]
  openQuestions: OpenQuestion[]
  filesRead: FileRead[]
  specOutput?: string
  status: SessionStatus
  callDurationSecs: number | null
  transcript: string | null
  /** Immutable server-owned origin, carried by events and frozen Build inputs. */
  transcriptRecordedAt?: string
  buildStatus: BuildStatus
  buildAttemptKey?: string | null
  buildRecovery?: { attemptId: string; error: string; retryable: boolean } | null
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
