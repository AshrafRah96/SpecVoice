# Manual acceptance

Use the private Compose dashboard configured by `bash scripts/setup-local.sh`. Keep provider ingress separate from the dashboard. The supported HTTP contracts are in [API reference](../api-reference.md); use an operator login cookie for Session routes and a fresh call capability only for voice tools.

## Repeatable local proof

Run `npm run test:e2e` for browser/Session/scope behavior and `npm run test:compose` for the actual deployment, durable restart, ingress and proxy checks. Both supply synthetic credentials and isolate storage. The PostgreSQL suite covers duplicate receipts, stale leases and transactional rollback; Docker isolation and backup suites cover execution and restore. These scripts replace the old unsigned curl sequence, which no longer matched authentication.

## Live operator check

Follow the bounded [live acceptance procedure](../evaluation.md#live-acceptance) with synthetic content and a dedicated disposable GitHub repository. Confirm microphone/audio, private call authentication, tool evidence, a signed post-call callback, a successful container test run and a draft PR. Never disable HMAC to make a smoke test pass.

If a call ends without a callback, inspect the provider webhook delivery and local ingress URL/signing-secret configuration. **Mark call failed** explicitly abandons a lost callback; a delayed callback can no longer replace the saved Session transcript. Starting a new call gets a fresh capability.

If publication fails after push, retry recovery from the dashboard. A new Build generates again and may spend model quota. Do not infer live correctness from fixture-only checks or report an external destination as verified without a restore drill on it.
