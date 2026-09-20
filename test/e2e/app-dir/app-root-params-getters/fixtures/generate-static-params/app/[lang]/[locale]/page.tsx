import { lang, locale } from 'next/root-params'
import { connection } from 'next/server'
import { Suspense } from 'react'

// Produced once, when the shell is rendered. Re-rendering the shell per request
// would yield a different value, which is how the test tells the two apart.
async function shellToken() {
  'use cache'
  return Math.random().toString(36).slice(2)
}

async function RequestToken() {
  await connection()
  return <span id="request-token">{Math.random().toString(36).slice(2)}</span>
}

export default async function Page() {
  return (
    <>
      <p>
        hello world{' '}
        {JSON.stringify({ lang: await lang(), locale: await locale() })}
      </p>
      <span id="shell-token">{await shellToken()}</span>
      <Suspense fallback={<span id="request-token-pending" />}>
        <RequestToken />
      </Suspense>
    </>
  )
}
