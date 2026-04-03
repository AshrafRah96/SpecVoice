import { Octokit } from '@octokit/rest'

function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } {
  const url = repoUrl.trim().replace(/\/$/, '').replace(/\.git$/, '')
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/)
  if (match) return { owner: match[1], repo: match[2] }
  throw new Error(
    `Unrecognised GitHub repo URL: ${repoUrl}. Expected 'https://github.com/owner/repo'.`
  )
}

export async function createDraftPR(opts: {
  repoUrl: string
  branchName: string
  sessionId: string
  specOutput: string
  firstDecisionSummary?: string
}): Promise<string> {
  // Read token from process.env directly — GITHUB_TOKEN is optional in the env
  // schema, so importing the `env` singleton would throw in test contexts.
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
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
