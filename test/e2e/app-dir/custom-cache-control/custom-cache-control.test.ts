import { nextTestSetup } from 'e2e-utils'
import { expectDirectives } from 'next-test-utils'

describe('custom-cache-control', () => {
  const { next, isNextDev, isNextDeploy } = nextTestSetup({
    files: __dirname,
  })

  if (isNextDeploy) {
    // customizing these headers won't apply on environments
    // where headers are applied outside of the Next.js server
    it('should skip for deploy', () => {})
    return
  }

  it('should have custom cache-control for app-ssg prerendered', async () => {
    const res = await next.fetch('/app-ssg/first')
    expectDirectives(
      res.headers.get('cache-control'),
      isNextDev ? ['no-store'] : ['s-maxage=30']
    )
  })

  it('should have custom cache-control for app-ssg lazy', async () => {
    const res = await next.fetch('/app-ssg/lazy')
    expectDirectives(
      res.headers.get('cache-control'),
      isNextDev ? ['no-store'] : ['s-maxage=31']
    )
  })
  ;(process.env.__NEXT_CACHE_COMPONENTS ? it.skip : it)(
    'should have default cache-control for app-ssg another',
    async () => {
      const res = await next.fetch('/app-ssg/another')
      expectDirectives(
        res.headers.get('cache-control'),
        isNextDev
          ? ['no-store']
          : ['s-maxage=120', 'stale-while-revalidate=31535880']
      )
    }
  )

  it('should have custom cache-control for app-ssr', async () => {
    const res = await next.fetch('/app-ssr')
    expectDirectives(
      res.headers.get('cache-control'),
      isNextDev ? ['no-store'] : ['s-maxage=32']
    )
  })

  it('should have custom cache-control for auto static page', async () => {
    const res = await next.fetch('/pages-auto-static')
    expectDirectives(
      res.headers.get('cache-control'),
      isNextDev ? ['no-store'] : ['s-maxage=33']
    )
  })

  it('should have custom cache-control for pages-ssg prerendered', async () => {
    const res = await next.fetch('/pages-ssg/first')
    expectDirectives(
      res.headers.get('cache-control'),
      isNextDev ? ['no-store'] : ['s-maxage=34']
    )
  })

  it('should have custom cache-control for pages-ssg lazy', async () => {
    const res = await next.fetch('/pages-ssg/lazy')
    expectDirectives(
      res.headers.get('cache-control'),
      isNextDev ? ['no-store'] : ['s-maxage=35']
    )
  })

  it('should have default cache-control for pages-ssg another', async () => {
    const res = await next.fetch('/pages-ssg/another')
    expectDirectives(
      res.headers.get('cache-control'),
      isNextDev
        ? ['no-store']
        : ['s-maxage=120', 'stale-while-revalidate=31535880']
    )
  })

  it('should have default cache-control for pages-ssr', async () => {
    const res = await next.fetch('/pages-ssr')
    expectDirectives(
      res.headers.get('cache-control'),
      isNextDev ? ['no-store'] : ['s-maxage=36']
    )
  })
})
