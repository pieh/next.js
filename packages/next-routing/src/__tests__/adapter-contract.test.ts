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
})
