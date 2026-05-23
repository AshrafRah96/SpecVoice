import { Octokit } from '@octokit/rest'
import { parseOwnerRepo } from '@/lib/github/utils'

export async function createDraftPR(opts: {
  repoUrl: string
  branchName: string
  sessionId: string
  specOutput: string
  firstDecisionSummary?: string
  token?: string
}): Promise<string> {
  const octokit = new Octokit({ auth: opts.token ?? process.env.GITHUB_TOKEN })
  const { owner, repo } = parseOwnerRepo(opts.repoUrl)

  const { data: repoData } = await octokit.repos.get({ owner, repo })
  const base = repoData.default_branch

  const title = opts.firstDecisionSummary
    ? `feat: ${opts.firstDecisionSummary}`
    : `feat: SpecVoice implementation (${opts.sessionId.slice(0, 8)})`

  // specOutput is the full spec — reviewers see what was planned alongside what was built.
  const body = opts.specOutput

  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    head: opts.branchName,
    base,
    title,
    body,
    draft: true,
  })

  return pr.html_url
}
