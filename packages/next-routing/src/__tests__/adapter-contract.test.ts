import { resolveRoutes } from '../resolve-routes'
import type { MiddlewareContext, ResolveRoutesParams } from '../types'

function createReadableStream(): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.close()
    },
  })
}

function createBaseParams(
  overrides: Partial<ResolveRoutesParams> = {}
): ResolveRoutesParams {
  return {
    url: new URL('https://example.com/'),
    buildId: 'BUILD_ID',
    basePath: '',
    requestBody: createReadableStream(),
    headers: new Headers(),
    pathnames: [],
    routes: {
      beforeMiddleware: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
    },
    invokeMiddleware: async () => ({}),
    ...overrides,
  }
}

const emptyRoutes = {
  beforeMiddleware: [],
  beforeFiles: [],
  afterFiles: [],
  dynamicRoutes: [],
  onMatch: [],
  fallback: [],
}

const i18n = { defaultLocale: 'en', locales: ['en', 'fr'] }

describe('output matching like next start', () => {
  it('matches outputs regardless of a trailing slash', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/other/'),
        pathnames: ['/other'],
      })
    )
    expect(result.resolvedPathname).toBe('/other')
    expect(result.invocationTarget?.pathname).toBe('/other/')
  })

  it('matches percent-encoded requests to decoded output pathnames', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/sticks%20%26%20stones'),
        pathnames: ['/sticks & stones'],
      })
    )
    expect(result.resolvedPathname).toBe('/sticks & stones')
  })

  it('keeps a literal percent in an output pathname matchable', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/100%25'),
        pathnames: ['/100%'],
      })
    )
    expect(result.resolvedPathname).toBe('/100%')
  })

  it('matches the root request to the Pages Router root output, keyed /index', async () => {
    const root = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/'),
        pathnames: ['/index'],
      })
    )
    expect(root.resolvedPathname).toBe('/index')

    const withBasePath = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/base'),
        basePath: '/base',
        pathnames: ['/base/index'],
      })
    )
    expect(withBasePath.resolvedPathname).toBe('/base/index')
  })

  it('prefers an output keyed / over the /index alias', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/'),
        pathnames: [
          { pathname: '/index', type: 'PAGES' },
          { pathname: '/', type: 'PRERENDER' },
        ],
      })
    )
    expect(result.resolvedPathname).toBe('/')
  })

  it('prefers an output over a dynamic route after an afterFiles rewrite', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/rewrite-1'),
        routes: {
          ...emptyRoutes,
          afterFiles: [
            { sourceRegex: '^/rewrite-1$', destination: '/ssr-page' },
          ],
          dynamicRoutes: [
            {
              sourceRegex: '^/(?<nxtPid>[^/]+?)$',
              destination: '/[id]?nxtPid=$nxtPid',
            },
          ],
        },
        pathnames: ['/ssr-page', '/[id]'],
      })
    )
    expect(result.resolvedPathname).toBe('/ssr-page')
    expect(result.routeMatches).toBeUndefined()
    expect(result.invocationTarget?.query).toEqual({})
  })

  it('answers repeated slashes with a redirect to the normalized path', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/a//b?x=1'),
        pathnames: ['/a/b'],
      })
    )
    expect(result.redirect?.status).toBe(308)
    expect(result.resolvedHeaders?.get('location')).toBe('/a/b?x=1')
  })
})

describe('data requests', () => {
  it('sets x-nextjs-data for data requests and drops a client-sent one', async () => {
    const trailingSlashRedirect = {
      sourceRegex: '^(?:\\/((?:[^/]+\\/)*[^/\\.]+))$',
      headers: { Location: '/$1/' },
      status: 308,
      missing: [{ type: 'header' as const, key: 'x-nextjs-data' }],
    }
    const routes = { ...emptyRoutes, beforeMiddleware: [trailingSlashRedirect] }

    const data = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/_next/data/BUILD_ID/page.json'),
        routes,
        pathnames: ['/_next/data/BUILD_ID/page.json'],
      })
    )
    expect(data.redirect).toBeUndefined()
    expect(data.resolvedPathname).toBe('/_next/data/BUILD_ID/page.json')
    expect(data.invocation?.headers['x-nextjs-data']).toBe('1')

    const spoofed = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/page'),
        headers: new Headers({ 'x-nextjs-data': '1' }),
        routes,
        pathnames: ['/page'],
      })
    )
    // the client's header is ignored, so the trailing-slash redirect still applies
    expect(spoofed.status).toBe(308)
    expect(spoofed.resolvedHeaders?.get('location')).toBe('/page/')
  })

  it('keeps the status of a middleware rewrite', async () => {
    // `NextResponse.rewrite(new URL('/_not-found', request.url), { status: 404 })`
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/rewritten-not-found'),
        routes: {
          ...emptyRoutes,
          middlewareMatchers: [{ sourceRegex: '^.*$' }],
        },
        pathnames: ['/_not-found'],
        invokeMiddleware: async () => ({
          rewrite: new URL('https://example.com/_not-found'),
          status: 404,
        }),
      })
    )
    expect(result.resolvedPathname).toBe('/_not-found')
    expect(result.status).toBe(404)
  })

  it('denormalizes a slashed page path without a slash before .json', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/_next/data/BUILD_ID/ssr-page.json'),
        trailingSlash: true,
        routes: {
          ...emptyRoutes,
          shouldNormalizeNextData: true,
          middlewareMatchers: [{ sourceRegex: '^.*$' }],
        },
        pathnames: ['/_next/data/BUILD_ID/ssr-page-2.json'],
        invokeMiddleware: async () => ({
          rewrite: new URL('https://example.com/ssr-page-2/'),
        }),
      })
    )
    expect(result.resolvedPathname).toBe('/_next/data/BUILD_ID/ssr-page-2.json')
  })

  it('does not trailing-slash redirect data requests with trailingSlash', async () => {
    // Next's own /:notfile rule, without a missing: x-nextjs-data condition
    const addTrailingSlash = {
      sourceRegex:
        '^(?:\\/((?!\\.well-known(?:\\/.*)?)(?:[^/]+\\/)*[^/\\.]+))$',
      headers: { Location: '/$1/' },
      status: 308,
    }
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/_next/data/BUILD_ID/page.json'),
        trailingSlash: true,
        routes: {
          ...emptyRoutes,
          shouldNormalizeNextData: true,
          beforeMiddleware: [addTrailingSlash],
        },
        pathnames: ['/_next/data/BUILD_ID/page.json'],
      })
    )
    expect(result.status).toBeUndefined()
    expect(result.resolvedPathname).toBe('/_next/data/BUILD_ID/page.json')
  })

  it('normalizes data URLs for middleware even without the flag, like next start', async () => {
    const urls: string[] = []
    await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/_next/data/BUILD_ID/test.json'),
        routes: {
          ...emptyRoutes,
          middlewareMatchers: [{ sourceRegex: '^.*$' }],
        },
        invokeMiddleware: async (ctx) => {
          urls.push(ctx.url.pathname)
          return {}
        },
      })
    )
    expect(urls).toEqual(['/test'])
  })

  it('matches a page without a data route before a dynamic route, like next start', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL(
          'https://example.com/_next/data/BUILD_ID/hooks/pushed.json'
        ),
        headers: new Headers({ 'x-nextjs-data': '1' }),
        routes: {
          ...emptyRoutes,
          middlewareMatchers: [{ sourceRegex: '^.*$' }],
          dynamicRoutes: [
            {
              sourceRegex:
                '^/_next/data/BUILD_ID/hooks/(?<nxtPid>[^/]+?)\\.json$',
              destination: '/hooks/[id]?nxtPid=$nxtPid',
            },
          ],
        },
        pathnames: [
          { pathname: '/hooks/pushed', type: 'STATIC_FILE' },
          { pathname: '/hooks/[id]', type: 'STATIC_FILE' },
        ],
      })
    )
    expect(result.resolvedPathname).toBe('/hooks/pushed')
  })

  it('invokes data requests matched through dynamic routes as data URLs', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/_next/data/BUILD_ID/blog/post.json'),
        routes: {
          ...emptyRoutes,
          shouldNormalizeNextData: true,
          dynamicRoutes: [
            {
              sourceRegex: '^/blog/(?<nxtPslug>[^/]+?)$',
              destination: '/blog/[slug]?nxtPslug=$nxtPslug',
            },
          ],
        },
        pathnames: ['/blog/[slug]'],
      })
    )
    expect(result.resolvedPathname).toBe('/blog/[slug]')
    expect(result.invocationTarget?.pathname).toBe(
      '/_next/data/BUILD_ID/blog/post.json'
    )
  })
})

describe('i18n like next start', () => {
  const pageMatcher = {
    sourceRegex:
      '^(?:\\/((?!_next\\/)[^/.]{1,}))\\/((?!api|_next\\/static).*)$',
  }

  it('adds the default locale to data requests before matching middleware', async () => {
    const invokeMiddleware = jest.fn(async () => ({}))
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/_next/data/BUILD_ID/test.json'),
        i18n,
        routes: {
          ...emptyRoutes,
          shouldNormalizeNextData: true,
          middlewareMatchers: [pageMatcher],
        },
        pathnames: ['/_next/data/BUILD_ID/en/test.json'],
        invokeMiddleware,
      })
    )
    expect(invokeMiddleware).toHaveBeenCalledTimes(1)
    expect(result.resolvedPathname).toBe('/_next/data/BUILD_ID/en/test.json')
    expect(result.invocation?.requestMeta.locale).toBe('en')
  })

  it('does not run an exclusion matcher on API routes', async () => {
    const invokeMiddleware = jest.fn(async () => ({}))
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/api/hello'),
        i18n,
        routes: { ...emptyRoutes, middlewareMatchers: [pageMatcher] },
        pathnames: [{ pathname: '/api/hello', type: 'PAGES_API' }],
        invokeMiddleware,
      })
    )
    expect(invokeMiddleware).not.toHaveBeenCalled()
    expect(result.resolvedPathname).toBe('/api/hello')
  })

  it('runs an /api matcher on API routes', async () => {
    const invokeMiddleware = jest.fn(async () => ({}))
    await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/api/hello'),
        i18n,
        routes: {
          ...emptyRoutes,
          middlewareMatchers: [
            {
              sourceRegex: '^(?:\\/((?!_next\\/)[^/.]{1,}))\\/api(?:\\/(.*))?$',
            },
          ],
        },
        pathnames: [{ pathname: '/api/hello', type: 'PAGES_API' }],
        invokeMiddleware,
      })
    )
    expect(invokeMiddleware).toHaveBeenCalledTimes(1)
  })

  it('404s an explicitly locale-prefixed API request', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/fr/api/hello'),
        i18n,
        pathnames: [{ pathname: '/api/hello', type: 'PAGES_API' }],
      })
    )
    expect(result.resolvedPathname).toBeUndefined()
    expect(result.invocationTarget).toBeUndefined()
  })

  it('serves a locale-less rewrite of an explicitly localized request to an API route', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/en/rewrite-api/hello'),
        i18n,
        routes: {
          ...emptyRoutes,
          beforeFiles: [
            {
              sourceRegex:
                '^/(?<locale>[^/]+?)/rewrite-api(?:/(?<path>.+?))?(?:/)?$',
              destination: '/api/$path',
            },
          ],
        },
        pathnames: [{ pathname: '/api/hello', type: 'PAGES_API' }],
      })
    )
    expect(result.resolvedPathname).toBe('/api/hello')
  })

  it('serves the root for the default locale instead of redirecting', async () => {
    const removeTrailingSlash = {
      sourceRegex: '^(?:\\/((?:[^/]+\\/)*[^/]+))\\/$',
      headers: { Location: '/$1' },
      status: 308,
    }
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/'),
        i18n,
        routes: { ...emptyRoutes, beforeMiddleware: [removeTrailingSlash] },
        pathnames: ['/en'],
      })
    )
    expect(result.status).toBeUndefined()
    expect(result.redirect).toBeUndefined()
    expect(result.resolvedPathname).toBe('/en')
  })

  it('serves the root with trailingSlash instead of redirecting', async () => {
    const addTrailingSlash = {
      sourceRegex:
        '^(?:\\/((?!\\.well-known(?:\\/.*)?)(?:[^/]+\\/)*[^/\\.]+))$',
      headers: { Location: '/$1/' },
      status: 308,
    }
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/'),
        i18n,
        trailingSlash: true,
        routes: { ...emptyRoutes, beforeMiddleware: [addTrailingSlash] },
        pathnames: ['/en'],
      })
    )
    expect(result.status).toBeUndefined()
    expect(result.resolvedPathname).toBe('/en')
  })

  it('redirects to the detected locale like next start', async () => {
    const withoutSlash = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/?x=1'),
        headers: new Headers({ 'accept-language': 'fr' }),
        i18n,
      })
    )
    expect(withoutSlash.redirect?.url.pathname).toBe('/fr')
    expect(withoutSlash.redirect?.url.search).toBe('?x=1')
    const withSlash = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/'),
        headers: new Headers({ 'accept-language': 'fr' }),
        i18n,
        trailingSlash: true,
      })
    )
    expect(withSlash.redirect?.url.pathname).toBe('/fr/')
  })

  it('passes middleware the URL as requested', async () => {
    const urls: string[] = []
    const invokeMiddleware = async (ctx: MiddlewareContext) => {
      urls.push(ctx.url.pathname)
      return {}
    }
    const routes = {
      ...emptyRoutes,
      shouldNormalizeNextData: true,
      middlewareMatchers: [{ sourceRegex: '^.*$' }],
    }
    await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/about'),
        i18n,
        routes,
        pathnames: ['/about'],
        invokeMiddleware,
      })
    )
    await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/_next/data/BUILD_ID/about.json'),
        i18n,
        routes,
        pathnames: ['/_next/data/BUILD_ID/en/about.json'],
        invokeMiddleware,
      })
    )
    expect(urls).toEqual(['/about', '/about'])
  })

  it('passes middleware data URLs as their page path, with trailingSlash and unless skipMiddlewareUrlNormalize', async () => {
    const urls: string[] = []
    const invokeMiddleware = async (ctx: MiddlewareContext) => {
      urls.push(ctx.url.pathname)
      return {}
    }
    const base = {
      url: new URL('https://example.com/_next/data/BUILD_ID/ssr-page.json'),
      routes: {
        ...emptyRoutes,
        shouldNormalizeNextData: true,
        middlewareMatchers: [{ sourceRegex: '^.*$' }],
      },
      pathnames: ['/_next/data/BUILD_ID/ssr-page.json'],
      invokeMiddleware,
    }
    await resolveRoutes(createBaseParams({ ...base, trailingSlash: true }))
    await resolveRoutes(
      createBaseParams({ ...base, skipMiddlewareUrlNormalize: true })
    )
    expect(urls).toEqual(['/ssr-page/', '/_next/data/BUILD_ID/ssr-page.json'])
  })

  it('reports the locale of a middleware rewrite target', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/about'),
        i18n,
        routes: {
          ...emptyRoutes,
          middlewareMatchers: [{ sourceRegex: '^.*$' }],
        },
        pathnames: ['/about'],
        invokeMiddleware: async () => ({
          rewrite: new URL('https://example.com/fr/about'),
        }),
      })
    )
    expect(result.resolvedPathname).toBe('/about')
    expect(result.invocation?.requestMeta.locale).toBe('fr')
  })
})

describe('middleware rewrites', () => {
  it('reports the target of a rewrite no output matches', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/page'),
        routes: {
          ...emptyRoutes,
          middlewareMatchers: [{ sourceRegex: '^.*$' }],
        },
        pathnames: ['/page'],
        invokeMiddleware: async () => ({
          rewrite: new URL('https://example.com/missing?x=1'),
        }),
      })
    )
    expect(result.resolvedPathname).toBeUndefined()
    expect(result.invocationTarget?.pathname).toBe('/missing')
    expect(result.invocationTarget?.query).toEqual({ x: '1' })
  })
})

describe('rewrite headers', () => {
  const routes = {
    ...emptyRoutes,
    beforeFiles: [{ sourceRegex: '^/a$', destination: '/b?x=1' }],
  }

  it('sets x-nextjs-rewritten-path/-query for RSC requests', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/a'),
        headers: new Headers({ rsc: '1' }),
        routes,
        pathnames: ['/b'],
      })
    )
    expect(result.resolvedHeaders?.get('x-nextjs-rewritten-path')).toBe('/b')
    expect(result.resolvedHeaders?.get('x-nextjs-rewritten-query')).toBe('x=1')
  })

  it('leaves the request query and internal route params out of the query header', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/photos/1?_rsc=abc'),
        headers: new Headers({ rsc: '1', 'next-url': '/photos' }),
        routes: {
          ...emptyRoutes,
          beforeFiles: [
            {
              sourceRegex: '^/photos/(?<nxtIid>[^/]+?)(?:/)?$',
              destination: '/photos/(.)$nxtIid?nxtIid=$nxtIid',
              has: [{ type: 'header', key: 'next-url', value: '/photos' }],
            },
          ],
        },
        pathnames: ['/photos/(.)[id]'],
      })
    )
    expect(result.resolvedHeaders?.get('x-nextjs-rewritten-path')).toBe(
      '/photos/(.)1'
    )
    expect(result.resolvedHeaders?.has('x-nextjs-rewritten-query')).toBe(false)
  })

  it('does not set them for other requests', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/a'),
        routes,
        pathnames: ['/b'],
      })
    )
    expect(result.resolvedHeaders?.has('x-nextjs-rewritten-path')).toBe(false)
  })
})

describe('invocation', () => {
  it('reports params by name, decoded, with catch-all segments as arrays', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/shop/caf%C3%A9/a/b%20c'),
        routes: {
          ...emptyRoutes,
          dynamicRoutes: [
            {
              sourceRegex: '^/shop/(?<nxtPslug>[^/]+?)/(?<nxtPrest>.+?)$',
              destination: '/shop/[slug]/[...rest]',
            },
          ],
        },
        pathnames: ['/shop/[slug]/[...rest]'],
      })
    )
    expect(result.invocation?.requestMeta.params).toEqual({
      slug: 'café',
      rest: ['a', 'b c'],
    })
  })

  it('reports params whatever Next named the regex groups', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/p/42'),
        routes: {
          ...emptyRoutes,
          // a param name Next can't use as a group name gets a generated key
          dynamicRoutes: [
            {
              sourceRegex: '^/p/(?<a>[^/]+?)$',
              destination: '/p/[post-id]?nxtPa=$a',
            },
          ],
        },
        pathnames: ['/p/[post-id]'],
      })
    )
    expect(result.invocation?.requestMeta.params).toEqual({ 'post-id': '42' })
  })

  it('reports params for localized data requests and optional catch-alls', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/_next/data/BUILD_ID/fr/docs.json'),
        i18n,
        routes: {
          ...emptyRoutes,
          shouldNormalizeNextData: true,
          dynamicRoutes: [
            {
              sourceRegex:
                '^/(?<nextLocale>[^/]+?)/docs(?:/(?<nxtPslug>.+?))?$',
              destination: '/$nextLocale/docs/[[...slug]]',
            },
          ],
        },
        pathnames: ['/docs/[[...slug]]'],
      })
    )
    expect(result.resolvedPathname).toBe('/docs/[[...slug]]')
    expect(result.invocation?.requestMeta.params).toBeUndefined()
    expect(result.invocation?.requestMeta.locale).toBe('fr')
  })

  it('localizes a middleware rewrite target without a locale for dynamic routes', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/fr/foo/bar'),
        i18n,
        routes: {
          ...emptyRoutes,
          middlewareMatchers: [{ sourceRegex: '^.*$' }],
          dynamicRoutes: [
            {
              sourceRegex:
                '^[/]?(?<nextLocale>[^/]{1,})/api/proxy(?:/(?<nxtPslug>.+?))?(?:/)?$',
              destination:
                '/$nextLocale/api/proxy/[[...slug]]?nxtPslug=$nxtPslug',
            },
          ],
        },
        pathnames: [{ pathname: '/api/proxy/[[...slug]]', type: 'PAGES_API' }],
        invokeMiddleware: async (ctx) => ({
          rewrite: new URL('/api/proxy/bar', ctx.url),
        }),
      })
    )
    expect(result.resolvedPathname).toBe('/api/proxy/[[...slug]]')
    expect(result.invocation?.requestMeta.params).toEqual({ slug: ['bar'] })
    expect(result.invocation?.requestMeta.locale).toBe('fr')
  })

  it('targets a static file without the locale a middleware rewrite added', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/_next/static/chunks/a.js?dpl=x'),
        i18n,
        routes: {
          ...emptyRoutes,
          middlewareMatchers: [{ sourceRegex: '^.*$' }],
        },
        pathnames: [
          { pathname: '/_next/static/chunks/a.js', type: 'STATIC_FILE' },
        ],
        invokeMiddleware: async (ctx) => ({
          rewrite: new URL('/en/_next/static/chunks/a.js?dpl=x', ctx.url),
        }),
      })
    )
    expect(result.resolvedPathname).toBe('/_next/static/chunks/a.js')
    expect(result.invocationTarget).toEqual({
      pathname: '/_next/static/chunks/a.js',
      query: { dpl: 'x' },
    })
  })

  it('reports no params for a static page next to a dynamic route', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/api/hello?a=b'),
        routes: {
          ...emptyRoutes,
          dynamicRoutes: [
            {
              sourceRegex: '^/api/(?<nxtPid>[^/]+?)(?:/)?$',
              destination: '/api/[id]?nxtPid=$nxtPid',
            },
          ],
        },
        pathnames: [
          { pathname: '/api/hello', type: 'PAGES_API' },
          { pathname: '/api/[id]', type: 'PAGES_API' },
        ],
      })
    )
    expect(result.resolvedPathname).toBe('/api/hello')
    expect(result.invocation?.requestMeta.params).toBeUndefined()
  })

  it('leaves the locale out of the params of a root catch-all', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/about'),
        i18n,
        routes: {
          ...emptyRoutes,
          dynamicRoutes: [
            {
              sourceRegex:
                '^[/]?(?<nextLocale>[^/]{1,})(?:/(?<nxtPslug>.+?))?(?:/)?$',
              destination: '/$nextLocale/[[...slug]]?nxtPslug=$nxtPslug',
            },
          ],
        },
        pathnames: [{ pathname: '/[[...slug]]', type: 'PAGES' }],
      })
    )
    expect(result.resolvedPathname).toBe('/[[...slug]]')
    expect(result.invocation?.requestMeta.params).toEqual({ slug: ['about'] })
  })

  it('reports params of the route for a root param shell', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/en/posts/two'),
        routes: {
          ...emptyRoutes,
          dynamicRoutes: [
            {
              sourceRegex: '^/en/posts/(?<nxtPslug>[^/]+?)(?:/)?$',
              destination: '/en/posts/[slug]?nxtPslug=$nxtPslug',
            },
          ],
        },
        pathnames: [
          {
            pathname: '/en/posts/[slug]',
            type: 'PRERENDER',
            route: '/[locale]/posts/[slug]',
          },
        ],
      })
    )
    expect(result.resolvedPathname).toBe('/en/posts/[slug]')
    expect(result.invocation?.requestMeta.params).toEqual({
      locale: 'en',
      slug: 'two',
    })
  })

  it('reports params for a concrete output of a dynamic page after a middleware rewrite', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/to-ssg'),
        routes: {
          ...emptyRoutes,
          middlewareMatchers: [{ sourceRegex: '^.*$' }],
          dynamicRoutes: [
            {
              sourceRegex: '^/ssg/(?<nxtPslug>[^/]+?)$',
              destination: '/ssg/[slug]?nxtPslug=$nxtPslug',
            },
          ],
        },
        pathnames: ['/ssg/hello', '/ssg/[slug]'],
        invokeMiddleware: async () => ({
          rewrite: new URL('https://example.com/ssg/hello'),
        }),
      })
    )
    expect(result.resolvedPathname).toBe('/ssg/hello')
    expect(result.routeMatches).toBeUndefined()
    expect(result.invocation?.requestMeta.params).toEqual({ slug: 'hello' })
  })

  it('returns the invocation: requested URL, rewrite result as request meta', async () => {
    const routes = {
      ...emptyRoutes,
      beforeFiles: [{ sourceRegex: '^/a$', destination: '/b?x=1' }],
    }
    const page = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/a?y=2'),
        routes,
        pathnames: [{ pathname: '/b', type: 'PAGES' }],
      })
    )
    expect(page.invocation).toEqual({
      url: '/a?y=2',
      requestMeta: {
        initURL: 'https://example.com/a?y=2',
        query: { y: '2', x: '1' },
      },
      headers: {},
    })

    // route handlers only read the URL, so the rewrite query is folded in
    const route = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/a?y=2'),
        routes,
        pathnames: [{ pathname: '/b', type: 'APP_ROUTE' }],
      })
    )
    expect(route.invocation?.url).toBe('/a?y=2&x=1')
  })

  it('reports request headers with middleware overrides applied', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/page'),
        headers: new Headers({ 'x-original': '1' }),
        routes: {
          ...emptyRoutes,
          middlewareMatchers: [{ sourceRegex: '^.*$' }],
        },
        pathnames: ['/page'],
        invokeMiddleware: async (ctx) => {
          const requestHeaders = new Headers(ctx.headers)
          requestHeaders.set('x-from-middleware', 'yes')
          return { requestHeaders }
        },
      })
    )
    expect(result.invocation?.headers).toEqual({
      'x-original': '1',
      'x-from-middleware': 'yes',
    })
  })
})

describe('middleware response headers', () => {
  it('are returned apart from the headers routing rules add', async () => {
    const result = await resolveRoutes(
      createBaseParams({
        url: new URL('https://example.com/page'),
        pathnames: ['/page'],
        routes: {
          ...emptyRoutes,
          beforeMiddleware: [
            { sourceRegex: '^/page$', headers: { 'x-from-rule': 'rule' } },
          ],
          middlewareMatchers: [{ sourceRegex: '.*' }],
        },
        invokeMiddleware: async () => ({
          responseHeaders: new Headers({ 'x-from-middleware': 'middleware' }),
        }),
      })
    )
    expect(result.resolvedPathname).toBe('/page')
    expect(result.resolvedHeaders?.get('x-from-rule')).toBe('rule')
    expect(result.resolvedHeaders?.has('x-from-middleware')).toBe(false)
    expect(result.middlewareResponseHeaders?.get('x-from-middleware')).toBe(
      'middleware'
    )
    expect(result.middlewareResponseHeaders?.has('x-from-rule')).toBe(false)
  })
})
