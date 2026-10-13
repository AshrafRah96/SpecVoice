import { Octokit } from '@octokit/rest'
import { parseOwnerRepo } from '@/lib/github/utils'

export async function createDraftPR(opts: {
  repoUrl: string
  branchName: string
  sessionId: string
  specOutput: string
  firstDecisionSummary?: string
  token?: string
  signal?: AbortSignal
}): Promise<string> {
  const octokit = new Octokit({
    auth: opts.token ?? process.env.GITHUB_TOKEN,
    request: { timeout: 30_000, signal: opts.signal },
  })
  const { owner, repo } = parseOwnerRepo(opts.repoUrl)

  const { data: repoData } = await octokit.repos.get({ owner, repo })
  const base = repoData.default_branch

  const { data: existing } = await octokit.pulls.list({
    owner,
    repo,
    head: `${owner}:${opts.branchName}`,
    state: 'all',
    per_page: 1,
  })
  if (existing[0]) return existing[0].html_url

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

export async function remoteBranchCommit(
  repoUrl: string,
  branchName: string,
  token?: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  const { owner, repo } = parseOwnerRepo(repoUrl)
  const client = new Octokit({ auth: token ?? process.env.GITHUB_TOKEN, request: { timeout: 30_000, signal } })
  try {
    const { data } = await client.repos.getBranch({ owner, repo, branch: branchName })
    return data.commit.sha
  } catch (error) {
    if ((error as { status?: number }).status === 404) return undefined
    throw error
  }
}
