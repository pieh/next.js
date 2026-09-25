import { resolveRoutes } from '../resolve-routes'
import type { ResolveRoutesParams } from '../types'

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
