import { beforeAll, beforeEach, vi } from 'vitest'
import { getOperatorAuth, OPERATOR_COOKIE } from '@/lib/security/operator'
import { TEST_OPERATOR_HASH, TEST_OPERATOR_PASSPHRASE } from './operator-fixture'

let cookie: string
beforeAll(async () => {
  vi.stubEnv('SPECVOICE_OPERATOR_PASSWORD_HASH', TEST_OPERATOR_HASH)
  cookie = `${OPERATOR_COOKIE}=${(await getOperatorAuth().login(TEST_OPERATOR_PASSPHRASE)).token}`
})
beforeEach(() => vi.stubEnv('SPECVOICE_OPERATOR_PASSWORD_HASH', TEST_OPERATOR_HASH))
export function operatorHeaders() {
  return { Cookie: cookie }
}
