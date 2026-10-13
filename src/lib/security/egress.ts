export function allowedHost(hostname: string, rules: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return rules.some(rule => {
    const normalized = rule.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
    return host === normalized || host.endsWith(`.${normalized}`)
  })
}
