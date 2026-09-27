export type RouteHas =
  | {
      type: 'header' | 'cookie' | 'query'
      key: string
      value?: string
    }
  | {
      type: 'host'
      key?: undefined
      value: string
    }

export type Route = {
  // regex as string can have named or un-named matches
  sourceRegex: string
  // destination can have matches to replace in destination
  // keyed by $1 for un-named and $name for named
  destination?: string
  headers?: Record<string, string>
  has?: RouteHas[]
  missing?: RouteHas[]
  status?: number
}

export type MiddlewareContext = {
  url: URL
  headers: Headers
  requestBody: ReadableStream
}

export type MiddlewareResult = {
  bodySent?: boolean
  requestHeaders?: Headers
  responseHeaders?: Headers
  redirect?: {
    url: URL
    status: number
  }
  rewrite?: URL
  // a rewrite's own status, which the final response keeps like in `next start`
  // (`NextResponse.rewrite(url, { status: 404 })`)
  status?: number
}

/**
 * Output types as the adapter output names them (`AdapterOutputType` in `next`).
 */
export type RoutablePathnameType =
  | 'PAGES'
  | 'PAGES_API'
  | 'APP_PAGE'
  | 'APP_ROUTE'
  | 'PRERENDER'
  | 'STATIC_FILE'
  | 'MIDDLEWARE'

export type RoutablePathname = {
  pathname: string
  /**
   * Type of the output the pathname belongs to, copied from the adapter output.
   * `public/` files, which are not adapter outputs, are `STATIC_FILE`.
   */
  type: RoutablePathnameType
  /**
   * The route the output renders, with its dynamic segments (`PRERENDER.route`
   * in the adapter output, a page's own pathname), when it differs from
   * `pathname`: a root param shell `/en/posts/[slug]` of
   * `/[locale]/posts/[slug]`. Params are matched against it.
   */
  route?: string
}

export type ResolveRoutesParams = {
  url: URL
  buildId: string
  basePath: string
  requestBody: ReadableStream
  headers: Headers
  /**
   * Pathnames of the outputs requests can resolve to, as keyed in the adapter
   * output. Passing the output type lets type-dependent rules apply, e.g. an
   * explicitly locale-prefixed request never resolves to an API route.
   */
  pathnames: Array<string | RoutablePathname>
  /**
   * `config.trailingSlash`, for the URL handed to middleware.
   */
  trailingSlash?: boolean
  /**
   * `config.skipProxyUrlNormalize` (or `skipMiddlewareUrlNormalize`): hand
   * middleware data URLs as they were requested.
   */
  skipMiddlewareUrlNormalize?: boolean
  i18n?: {
    defaultLocale: string
    domains?: Array<{
      defaultLocale: string
      domain: string
      http?: true
      locales?: string[]
    }>
    localeDetection?: false
    locales: string[]
  }
  routes: {
    /**
     * When false (default), route matching is case-insensitive to mirror
     * Next.js default behavior. When true, matches are case-sensitive.
     */
    caseSensitive?: boolean
    beforeMiddleware: Array<Route>
    /**
     * Middleware matcher definitions used to decide whether middleware should
     * be invoked for the current request.
     */
    middlewareMatchers?: Array<Route>
    beforeFiles: Array<Route>
    afterFiles: Array<Route>
    dynamicRoutes: Array<Route>
    onMatch: Array<Route>
    fallback: Array<Route>
    shouldNormalizeNextData?: boolean
  }
  invokeMiddleware: (ctx: MiddlewareContext) => Promise<MiddlewareResult>
}

export type ResolveRoutesQueryValue = string | string[]
export type ResolveRoutesQuery = Record<string, ResolveRoutesQueryValue>

export type RouteInvocationTarget = {
  /**
   * Concrete pathname that should be invoked after routing resolution.
   */
  pathname: string
  /**
   * Concrete query that should be invoked after routing resolution.
   */
  query: ResolveRoutesQuery
}

export type ResolveRoutesResult = {
  middlewareResponded?: boolean
  externalRewrite?: URL
  redirect?: {
    url: URL
    status: number
  }
  /**
   * Resolved pathname selected by route matching. For dynamic routes this is
   * the matched template pathname.
   */
  resolvedPathname?: string
  /**
   * Merged query produced by rewrite/middleware routing.
   *
   * @deprecated Use `invocation.requestMeta.query`.
   */
  resolvedQuery?: ResolveRoutesQuery
  /**
   * Where the request resolved to after rewrites and middleware: route or cache
   * by it. To invoke the entrypoint use `invocation`. Without `resolvedPathname`
   * it is the target of a middleware rewrite that no output matches: respond 404
   * for it, as `next start` does.
   */
  invocationTarget?: RouteInvocationTarget
  resolvedHeaders?: Headers
  status?: number
  /**
   * Raw regex groups of the matched dynamic route.
   *
   * @deprecated Use `invocation.requestMeta.params`, the params a route module
   * expects.
   */
  routeMatches?: Record<string, string>
  /**
   * How to invoke the entrypoint of the output matching `resolvedPathname`, so
   * that it behaves like under `next start`. Apply as is.
   */
  invocation?: RouteInvocation
}

export type RouteInvocation = {
  /**
   * `req.url`: the URL as requested (path and query), not the rewrite target.
   * Route handlers read the query from it only, so for `APP_ROUTE` and
   * `PAGES_API` outputs the rewrite query is folded in.
   */
  url: string
  /**
   * Request meta to pass to the entrypoint, next to the platform's own
   * (`waitUntil`, `revalidate`, `render404`, ...).
   */
  requestMeta: {
    initURL: string
    /** Query after rewrites and middleware. */
    query: ResolveRoutesQuery
    /** Route params by name, decoded, catch-all segments as arrays. */
    params?: Record<string, string | string[]>
    /** Locale to render in, including after a middleware rewrite to another one. */
    locale?: string
  }
  /**
   * Request headers to invoke the entrypoint with: the incoming ones with
   * middleware request-header overrides applied, and `x-nextjs-data` set for
   * data requests (and only for them).
   */
  headers: Record<string, string>
}
