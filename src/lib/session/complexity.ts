import type { Session, ComplexityAssessment } from '@/lib/session/types'

const SIZE_THRESHOLDS = {
  small: 500,
  medium: 2000,
  large: 5000,
} as const

function sizeFromLineEstimate(lineEstimate: number): ComplexityAssessment['size'] {
  if (lineEstimate < SIZE_THRESHOLDS.small) return 'small'
  if (lineEstimate < SIZE_THRESHOLDS.medium) return 'medium'
  if (lineEstimate < SIZE_THRESHOLDS.large) return 'large'
  return 'too_large'
}

// Groups file paths by their first path segment (top-level directory).
// Used to suggest how to split a too-large build into smaller PRs.
function groupByTopLevelDir(paths: string[]): string[][] {
  const groups = new Map<string, string[]>()
  for (const p of paths) {
    const key = p.split('/')[0] ?? p
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(p)
  }
  return Array.from(groups.values())
}

export function assessComplexity(session: Session): ComplexityAssessment {
  const fileCount = session.filesRead.length
  const openQuestionCount = session.openQuestions.length
  const lineEstimate = fileCount * 50
  const size = sizeFromLineEstimate(lineEstimate)

  const tooLarge = size === 'too_large'
  const hasOpenQuestions = openQuestionCount > 0
  const blocked = hasOpenQuestions || tooLarge

  // open_questions blocks first; too_large is secondary
  let blockReason: ComplexityAssessment['blockReason']
  if (hasOpenQuestions) blockReason = 'open_questions'
  else if (tooLarge) blockReason = 'too_large'

  // Split suggestion only makes sense for too_large — not for open questions
  let splitSuggestion: string[][] | undefined
  if (tooLarge) {
    const allRelevantFiles = session.decisions.flatMap(d => d.relevantFiles)
    if (allRelevantFiles.length > 0) {
      splitSuggestion = groupByTopLevelDir(allRelevantFiles)
    }
  }

  return {
    fileCount,
    openQuestionCount,
    lineEstimate,
    size,
    blocked,
    ...(blockReason !== undefined && { blockReason }),
    ...(splitSuggestion !== undefined && { splitSuggestion }),
  }
}
