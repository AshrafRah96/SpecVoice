import { Dashboard } from '@/components/Dashboard'
import { OperatorLogin } from '@/components/OperatorLogin'
import { cookies } from 'next/headers'
import { getOperatorAuth, OPERATOR_COOKIE } from '@/lib/security/operator'

export default async function Home() {
  const token = (await cookies()).get(OPERATOR_COOKIE)?.value
  let authenticated = false
  try {
    authenticated = await getOperatorAuth().valid(token)
  } catch {
    /* Login reports setup/storage failures without exposing credentials. */
  }
  return authenticated ? <Dashboard /> : <OperatorLogin />
}
