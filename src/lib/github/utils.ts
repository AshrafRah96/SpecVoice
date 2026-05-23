export function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } {
  const url = repoUrl.trim().replace(/\/$/, '').replace(/\.git$/, '')
  const fullMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/)
  if (fullMatch) return { owner: fullMatch[1], repo: fullMatch[2] }
  const slugMatch = url.match(/^([^/]+)\/([^/]+)$/)
  if (slugMatch) return { owner: slugMatch[1], repo: slugMatch[2] }
  throw new Error(
    `Unrecognised GitHub repo URL: ${repoUrl}. ` +
      "Expected 'https://github.com/owner/repo' or 'owner/repo'."
  )
}
