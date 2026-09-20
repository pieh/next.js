import { nextTestSetup } from 'e2e-utils'
import cheerio from 'cheerio'
import { join } from 'path'

describe('app-root-param-getters - generateStaticParams', () => {
  const { next, isNextDev } = nextTestSetup({
    files: join(__dirname, 'fixtures', 'generate-static-params'),
  })

  it('should be statically prerenderable', async () => {
    const params = { lang: 'en', locale: 'us' }
    const load = async () => {
      const response = await next.fetch(`/${params.lang}/${params.locale}`)
      expect(response.status).toBe(200)
      return cheerio.load(await response.text())
    }

    const $ = await load()
    expect($('p').text()).toBe(`hello world ${JSON.stringify(params)}`)

    if (isNextDev) return

    // Reading root params must not make the page dynamic: the shell is rendered
    // once and reused, while the part behind the Suspense boundary is rendered
    // for each request. Both tokens are random, so a shell that was re-rendered
    // would bring a new value with it.
    const $2 = await load()
    expect($2('#shell-token').text()).toBe($('#shell-token').text())
    expect($2('#request-token').text()).not.toBe($('#request-token').text())
  })

  it('should be part of the static shell', async () => {
    const params = { lang: 'en', locale: 'us' }
    const browser = await next.browser(
      `/${params.lang}/${params.locale}/other/1`,
      {
        // prevent streaming (dynamic) content from being inserted into the DOM
        disableJavaScript: true,
      }
    )
    expect(await browser.elementByCss('main > p#root-params').text()).toBe(
      JSON.stringify(params)
    )
  })

  it('should allow reading root params that were not prerendered', async () => {
    const params = { lang: 'sth', locale: 'else' }
    const $ = await next.render$(`/${params.lang}/${params.locale}`)
    expect($('p').text()).toBe(`hello world ${JSON.stringify(params)}`)
  })

  it('should allow reading root params inside generateStaticParams', async () => {
    // The [slug] segment's generateStaticParams uses `lang()` to produce
    // slugs like "en-post". If root params are available during
    // generateStaticParams, this page should be statically prerenderable.
    const response = await next.fetch('/en/us/other/en-post')
    expect(response.status).toBe(200)
    const $ = cheerio.load(await response.text())
    expect($('#root-params').text()).toBe(
      JSON.stringify({ lang: 'en', locale: 'us' })
    )
    expect($('#dynamic-params').text()).toBe('en-post')
  })
})
