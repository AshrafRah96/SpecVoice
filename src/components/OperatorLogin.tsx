'use client'

import { useState } from 'react'
import { Button } from './ui/button'

export function OperatorLogin() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-background">
      <form
        className="w-full max-w-sm space-y-4 rounded-lg border p-6"
        onSubmit={async event => {
          event.preventDefault()
          const form = event.currentTarget
          setBusy(true)
          setError('')
          try {
            const response = await fetch('/api/operator', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ passphrase: new FormData(form).get('passphrase') }),
            })
            if (!response.ok) throw new Error((await response.json()).error ?? 'Sign-in failed')
            form.reset()
            window.location.reload()
          } catch (error) {
            setError(error instanceof Error ? error.message : 'Sign-in failed')
          } finally {
            setBusy(false)
          }
        }}
      >
        <h1 className="text-xl font-semibold">Sign in to SpecVoice</h1>
        <label className="block" htmlFor="passphrase">
          Operator passphrase
        </label>
        <input
          className="w-full rounded border bg-background p-2"
          id="passphrase"
          name="passphrase"
          type="password"
          autoComplete="current-password"
          required
          maxLength={1024}
        />
        <Button disabled={busy} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </form>
    </main>
  )
}
