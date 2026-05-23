import type { Session, ComplexityAssessment } from '@/lib/session/types'
import { assessComplexity } from '@/lib/session/complexity'

export type ValidationResult =
  | { type: 'ok'; repoUrl: string; assessment: ComplexityAssessment }
  | { type: 'blocked'; assessment: ComplexityAssessment }
  | { type: 'failed'; error: string }

export type PrereqCheck = () => { ok: boolean; error?: string }

export function validateBuild(session: Session, prereqs: PrereqCheck): ValidationResult {
  const assessment = assessComplexity(session)

  if (assessment.blocked) {
    return { type: 'blocked', assessment }
  }

  const prereq = prereqs()
  if (!prereq.ok) {
    return { type: 'failed', error: prereq.error! }
  }

  if (!session.repoUrl) {
    return { type: 'failed', error: 'Session has no repository URL. Cannot clone and build.' }
  }

  return { type: 'ok', repoUrl: session.repoUrl, assessment }
}
