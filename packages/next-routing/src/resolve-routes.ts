import type {
  Route,
  RouteInvocation,
  RoutablePathname,
  ResolveRoutesParams,
  ResolveRoutesQuery,
  ResolveRoutesResult,
} from './types'
import { checkHasConditions, checkMissingConditions } from './matchers'
import {
  replaceDestination,
  isExternalDestination,
  applyDestination,
  isRedirectStatus,
  hasRedirectHeaders,
} from './destination'
import { normalizeNextDataUrl, denormalizeNextDataUrl } from './next-data'
import { detectLocale, detectDomainLocale, normalizeLocalePath } from './i18n'

function getHeaderValueCaseInsensitive(
  headers: Record<string, string>,
  targetHeader: string
): string | undefined {
  const targetHeaderLower = targetHeader.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === targetHeaderLower) {
      return value
    }
  }
  return undefined
}

function resolveRedirectLocationWithRequestQuery(
  locationHeader: string,
  requestUrl: URL
): string {
  if (!requestUrl.search) {
    return locationHeader
  }

  try {
    const resolvedLocation = new URL(locationHeader, requestUrl)
    if (resolvedLocation.search) {
      return locationHeader
    }

    resolvedLocation.search = requestUrl.search
    if (resolvedLocation.origin !== requestUrl.origin) {
      return resolvedLocation.toString()
    }

    return `${resolvedLocation.pathname}${resolvedLocation.search}${resolvedLocation.hash}`
  } catch {
    return locationHeader
  }
}

/**
 * Attempts to match a route against the current URL and conditions
 */
function matchRoute(
  route: Route,
  url: URL,
  headers: Headers,
  caseSensitive: boolean
): {
  matched: boolean
  destination?: string
  headers?: Record<string, string>
  regexMatches?: RegExpMatchArray
  hasCaptures?: Record<string, string>
} {
  // Check if source regex matches the pathname
  const regex = new RegExp(route.sourceRegex, caseSensitive ? '' : 'i')
  const regexMatches = url.pathname.match(regex)

  if (!regexMatches) {
    return { matched: false }
  }

  // Check has conditions
  const hasResult = checkHasConditions(route.has, url, headers)
  if (!hasResult.matched) {
    return { matched: false }
  }

  // Check missing conditions
  const missingMatched = checkMissingConditions(route.missing, url, headers)
  if (!missingMatched) {
    return { matched: false }
  }

  // Replace placeholders in destination
  const destination = route.destination
    ? replaceDestination(route.destination, regexMatches, hasResult.captures)
    : undefined
  const resolvedHeaders = route.headers
    ? Object.fromEntries(
        Object.entries(route.headers).map(([key, value]) => [
          replaceDestination(key, regexMatches, hasResult.captures),
          replaceDestination(value, regexMatches, hasResult.captures),
        ])
      )
    : undefined

  return {
    matched: true,
    destination,
    headers: resolvedHeaders,
    regexMatches,
    hasCaptures: hasResult.captures,
  }
}

/**
 * Processes a list of routes and updates the URL if any match
 */
function processRoutes(
  routes: Route[],
  url: URL,
  requestHeaders: Headers,
  responseHeaders: Headers,
  initialOrigin: string,
  caseSensitive: boolean
): {
  url: URL
  externalRewrite?: URL
  redirect?: {
    url: URL
    status: number
  }
  stopped: boolean
  status?: number
} {
  let currentUrl = url
  let currentStatus: number | undefined

  for (const route of routes) {
    const match = matchRoute(route, currentUrl, requestHeaders, caseSensitive)

    if (match.matched) {
      if (match.headers) {
        for (const [key, value] of Object.entries(match.headers)) {
          responseHeaders.set(key, value)
        }
      }

      if (route.status) {
        currentStatus = route.status
      }

      if (
        isRedirectStatus(route.status) &&
        match.headers &&
        hasRedirectHeaders(match.headers)
      ) {
        if (match.destination) {
          const redirectUrl = isExternalDestination(match.destination)
            ? new URL(match.destination)
            : applyDestination(currentUrl, match.destination)

          return {
            url: currentUrl,
            redirect: {
              url: redirectUrl,
              status: route.status!,
            },
            stopped: true,
            status: currentStatus,
          }
        }

        const locationHeader = getHeaderValueCaseInsensitive(
          match.headers,
          'location'
        )
        if (locationHeader) {
          responseHeaders.set(
            'location',
            resolveRedirectLocationWithRequestQuery(locationHeader, currentUrl)
          )
        }

        return {
          url: currentUrl,
          stopped: true,
          status: currentStatus,
        }
      }

      if (match.destination) {
        // Check if it's an external rewrite
        if (isExternalDestination(match.destination)) {
          return {
            url: currentUrl,
            externalRewrite: new URL(match.destination),
            stopped: true,
            status: currentStatus,
          }
        }

        // Apply the destination to update the URL
        currentUrl = applyDestination(currentUrl, match.destination)

        // Check if origin changed (external rewrite)
        if (currentUrl.origin !== initialOrigin) {
          return {
            url: currentUrl,
            externalRewrite: currentUrl,
            stopped: true,
            status: currentStatus,
          }
        }
      }
    }
  }

  return { url: currentUrl, stopped: false, status: currentStatus }
}

const NEXT_DATA_HEADER = 'x-nextjs-data'

/**
 * Output pathnames keyed the way `fsChecker.getItem` compares them in `next start`:
 * without a trailing slash, with the Pages Router root `/index` also reachable as
 * `/`. Requests are decoded before lookup (output pathnames are the decoded form
 * Next emits, requests arrive percent-encoded).
 */
type PathnameIndex = Map<
  string,
  RoutablePathname | { pathname: string; type?: undefined }
>

function canonicalPathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname
}

function createPathnameIndex(
  pathnames: ResolveRoutesParams['pathnames'],
  basePath: string
): PathnameIndex {
  const index: PathnameIndex = new Map()
  for (const entry of pathnames) {
    const output = typeof entry === 'string' ? { pathname: entry } : entry
    const key = canonicalPathname(output.pathname)
    if (!index.has(key)) {
      index.set(key, output)
    }
    if (key === `${basePath}/index`) {
      const root = basePath || '/'
      if (!index.has(root)) {
        index.set(root, output)
      }
    }
  }
  return index
}

function lookupPathname(
  pathname: string,
  index: PathnameIndex
): RoutablePathname | { pathname: string; type?: undefined } | undefined {
  const canonical = canonicalPathname(pathname)
  const direct = index.get(canonical)
  if (direct) {
    return direct
  }
  if (!canonical.includes('%')) {
    return undefined
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(canonical)
  } catch {
    return undefined
  }
  return decoded !== canonical ? index.get(decoded) : undefined
}

/**
 * Checks if the current pathname matches any of the provided pathnames
 */
function matchesPathname(
  pathname: string,
  pathnames: PathnameIndex
): string | undefined {
  return lookupPathname(pathname, pathnames)?.pathname
}

function matchesPathnameWithLocaleFallback({
  pathname,
  pathnames,
  basePath,
  i18n,
}: {
  pathname: string
  pathnames: PathnameIndex
  basePath: string
  i18n?: ResolveRoutesParams['i18n']
}): string | undefined {
  const directMatch = matchesPathname(pathname, pathnames)
  if (directMatch || !i18n) {
    return directMatch
  }

  const withoutBasePath =
    basePath && pathname.startsWith(basePath)
      ? pathname.slice(basePath.length) || '/'
      : pathname

  for (const locale of i18n.locales) {
    const localePrefix = `/${locale}`
    if (
      withoutBasePath !== localePrefix &&
      !withoutBasePath.startsWith(`${localePrefix}/`)
    ) {
      continue
    }

    const withoutLocale =
      withoutBasePath === localePrefix
        ? '/'
        : withoutBasePath.slice(localePrefix.length) || '/'
    const localeFallbackPathname = basePath
      ? `${basePath}${withoutLocale}`
      : withoutLocale

    const localeFallbackMatch = matchesPathname(
      localeFallbackPathname,
      pathnames
    )
    if (localeFallbackMatch) {
      return localeFallbackMatch
    }
  }

  return undefined
}

function isDynamicTemplatePathname(pathname: string): boolean {
  return /\[[^/]+?\]/.test(pathname)
}

function toResolvedQuery(url: URL): ResolveRoutesQuery {
  const query: ResolveRoutesQuery = {}
  for (const [key, value] of url.searchParams.entries()) {
    const existing = query[key]
    if (existing === undefined) {
      query[key] = value
      continue
    }
    query[key] = Array.isArray(existing)
      ? [...existing, value]
      : [existing, value]
  }
  return query
}

function mergeDestinationQueryIntoUrl(url: URL, destination: string): URL {
  const mergedUrl = new URL(url.toString())
  const destinationSearch = destination.split('?')[1]
  if (!destinationSearch) {
    return mergedUrl
  }

  const destinationParams = new URLSearchParams(destinationSearch)
  const destinationKeys = new Set<string>()
  for (const [key, value] of destinationParams.entries()) {
    if (!destinationKeys.has(key)) {
      mergedUrl.searchParams.delete(key)
      destinationKeys.add(key)
    }
    mergedUrl.searchParams.append(key, value)
  }
  return mergedUrl
}

function withResolvedInvocationTarget({
  result,
  url,
  resolvedPathname,
  invocationPathname,
}: {
  result: ResolveRoutesResult
  url: URL
  resolvedPathname: string
  invocationPathname: string
}): ResolveRoutesResult {
  const resolvedQuery = toResolvedQuery(url)
  return {
    ...result,
    resolvedPathname,
    resolvedQuery,
    invocationTarget: {
      pathname: invocationPathname,
      query: resolvedQuery,
    },
  }
}

/**
 * Matches dynamic routes and extracts route parameters
 */
function matchDynamicRoute(
  pathname: string,
  route: Route,
  caseSensitive: boolean
): {
  matched: boolean
  params?: Record<string, string>
  regexMatches?: RegExpMatchArray
} {
  const regex = new RegExp(route.sourceRegex, caseSensitive ? '' : 'i')
  const match = pathname.match(regex)

  if (!match) {
    return { matched: false }
  }

  const params: Record<string, string> = {}

  // Add numbered matches
  for (let i = 1; i < match.length; i++) {
    if (match[i] !== undefined) {
      params[String(i)] = match[i]
    }
  }

  // Add named matches
  if (match.groups) {
    Object.assign(params, match.groups)
  }

  return { matched: true, params, regexMatches: match }
}

/**
 * Applies headers from onMatch routes
 */
function applyOnMatchHeaders(
  routes: Route[],
  url: URL,
  requestHeaders: Headers,
  responseHeaders: Headers,
  caseSensitive: boolean
): Headers {
  const newHeaders = new Headers(responseHeaders)

  for (const route of routes) {
    const match = matchRoute(route, url, requestHeaders, caseSensitive)

    if (match.matched && match.headers) {
      for (const [key, value] of Object.entries(match.headers)) {
        newHeaders.set(key, value)
      }
    }
  }

  return newHeaders
}

/**
 * Checks dynamic routes for a match and returns result if found
 */
function checkDynamicRoutes(
  dynamicRoutes: Route[],
  url: URL,
  pathnames: PathnameIndex,
  requestHeaders: Headers,
  responseHeaders: Headers,
  onMatchRoutes: Route[],
  basePath: string,
  buildId: string,
  i18n: ResolveRoutesParams['i18n'],
  shouldNormalizeNextData?: boolean,
  isDataUrl?: boolean,
  caseSensitive: boolean = false
): {
  matched: boolean
  result?: ResolveRoutesResult
  resetUrl?: URL
} {
  // Denormalize before checking dynamic routes if this was originally a data URL
  let checkUrl = url
  if (isDataUrl && shouldNormalizeNextData) {
    checkUrl = denormalizeNextDataUrl(url, basePath, buildId)
  }

  for (const route of dynamicRoutes) {
    const match = matchDynamicRoute(checkUrl.pathname, route, caseSensitive)

    if (match.matched) {
      // Check has/missing conditions
      const hasResult = checkHasConditions(route.has, checkUrl, requestHeaders)
      const missingMatched = checkMissingConditions(
        route.missing,
        checkUrl,
        requestHeaders
      )

      if (hasResult.matched && missingMatched) {
        const replacedDestination = route.destination
          ? replaceDestination(
              route.destination,
              match.regexMatches || null,
              hasResult.captures
            )
          : undefined
        // Check if the destination pathname (template path) is in the provided pathnames list
        // For dynamic routes, the destination contains the template path like /dynamic/[slug]
        const pathnameToCheck = replacedDestination
          ? replacedDestination.split('?')[0]
          : checkUrl.pathname
        const matchedPath = matchesPathnameWithLocaleFallback({
          pathname: pathnameToCheck,
          pathnames,
          basePath,
          i18n,
        })
        if (matchedPath) {
          const resolvedUrl = replacedDestination
            ? mergeDestinationQueryIntoUrl(checkUrl, replacedDestination)
            : checkUrl
          const finalHeaders = applyOnMatchHeaders(
            onMatchRoutes,
            resolvedUrl,
            requestHeaders,
            responseHeaders,
            caseSensitive
          )
          const result = withResolvedInvocationTarget({
            result: {
              routeMatches: match.params,
              resolvedHeaders: finalHeaders,
            },
            url: resolvedUrl,
            resolvedPathname: matchedPath,
            invocationPathname: checkUrl.pathname,
          })
          return {
            matched: true,
            result,
            resetUrl: checkUrl, // Return the denormalized URL to reset to
          }
        }
      }
    }
  }

  return { matched: false }
}

function shouldInvokeMiddlewareForRequest(
  middlewareMatchers: Route[] | undefined,
  url: URL,
  requestHeaders: Headers,
  caseSensitive: boolean
): boolean {
  const matchesMiddlewareMatchers = (candidatePathname: string): boolean => {
    if (!middlewareMatchers || middlewareMatchers.length === 0) {
      return false
    }

    for (const matcher of middlewareMatchers) {
      const regex = new RegExp(matcher.sourceRegex, caseSensitive ? '' : 'i')
      const regexMatches = candidatePathname.match(regex)
      if (!regexMatches) {
        continue
      }

      const hasResult = checkHasConditions(matcher.has, url, requestHeaders)
      if (!hasResult.matched) {
        continue
      }

      const missingMatched = checkMissingConditions(
        matcher.missing,
        url,
        requestHeaders
      )
      if (!missingMatched) {
        continue
      }

      return true
    }

    return false
  }

  // Preserve legacy behavior for callers that don't yet provide matchers.
  if (middlewareMatchers === undefined) {
    return true
  }

  if (middlewareMatchers.length === 0) {
    return false
  }

  if (matchesMiddlewareMatchers(url.pathname)) {
    return true
  }

  let decodedPathname = url.pathname
  try {
    decodedPathname = decodeURIComponent(url.pathname)
  } catch {
    return false
  }

  if (decodedPathname === url.pathname) {
    return false
  }

  return matchesMiddlewareMatchers(decodedPathname)
}

type ResolveState = {
  requestHeaders: Headers
}

export async function resolveRoutes(
  params: ResolveRoutesParams
): Promise<ResolveRoutesResult> {
  const index = createPathnameIndex(params.pathnames, params.basePath)
  const state: ResolveState = {
    requestHeaders: new Headers(params.headers),
  }
  const result = await resolveRoutesWithIndex(params, index, state)
  return finalizeResult(result, params, index, state)
}

function finalizeResult(
  result: ResolveRoutesResult,
  { basePath, buildId, i18n, url }: ResolveRoutesParams,
  index: PathnameIndex,
  state: ResolveState
): ResolveRoutesResult {
  if (!result.invocationTarget) {
    return result
  }

  const routeParams =
    (result as InternalResult).params ??
    (result.resolvedPathname &&
    isDynamicTemplatePathname(result.resolvedPathname)
      ? getRouteParams(
          result.resolvedPathname,
          result.invocationTarget.pathname,
          { basePath, buildId, i18n }
        )
      : undefined)

  const locale = i18n
    ? getInvocationLocale(
        [result.invocationTarget.pathname, url.pathname],
        { basePath, buildId, i18n },
        url.hostname
      )
    : undefined
  const headers = Object.fromEntries(state.requestHeaders.entries())

  // `params` is only carried internally until here, callers get it in `invocation`
  const { params: _params, ...rest } = result as InternalResult
  return {
    ...rest,
    ...(result.resolvedPathname
      ? {
          invocation: getInvocation(
            url,
            result.invocationTarget.query,
            lookupPathname(result.resolvedPathname, index)?.type,
            { params: routeParams, locale, headers }
          ),
        }
      : {}),
  }
}

type RouteParams = Record<string, string | string[]>
// params found while matching, moved into `invocation` by finalizeResult
type InternalResult = ResolveRoutesResult & { params?: RouteParams }

function getInvocation(
  requestUrl: URL,
  query: ResolveRoutesQuery,
  outputType: RoutablePathname['type'] | undefined,
  {
    params,
    locale,
    headers,
  }: {
    params: RouteParams | undefined
    locale: string | undefined
    headers: Record<string, string>
  }
): RouteInvocation {
  const invokeUrl = new URL(requestUrl.toString())
  // route handlers read search params from the URL only, there is no other
  // channel for the query a rewrite added
  if (outputType === 'APP_ROUTE' || outputType === 'PAGES_API') {
    for (const [key, valueOrValues] of Object.entries(query)) {
      invokeUrl.searchParams.delete(key)
      for (const value of Array.isArray(valueOrValues)
        ? valueOrValues
        : [valueOrValues]) {
        invokeUrl.searchParams.append(key, value)
      }
    }
  }
  return {
    url: `${invokeUrl.pathname}${invokeUrl.search}`,
    requestMeta: {
      initURL: requestUrl.toString(),
      query,
      ...(params ? { params } : {}),
      ...(locale ? { locale } : {}),
    },
    headers,
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

type PathContext = {
  basePath: string
  buildId: string
  i18n: ResolveRoutesParams['i18n']
}

/** A pathname as its page path: without basePath, `/_next/data/<buildId>/…json`. */
function toPagePath(
  pathname: string,
  { basePath, buildId }: PathContext
): string {
  let page =
    basePath && pathname.startsWith(basePath)
      ? pathname.slice(basePath.length) || '/'
      : pathname
  const dataPrefix = `/_next/data/${buildId}/`
  if (page.startsWith(dataPrefix)) {
    const rest = page.slice(dataPrefix.length).replace(/\.json$/, '')
    page = rest === 'index' ? '/' : `/${rest}`
  }
  return page
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Route params as route modules expect them (decoded, catch-all segments as
 * arrays), by matching the invoked path against the output's template, like
 * Next's route matcher does. Unlike the dynamic route's regex groups this does
 * not depend on how Next names them (`nxtP<param>`, or generated keys).
 */
function getRouteParams(
  template: string,
  pathname: string,
  context: PathContext
): Record<string, string | string[]> | undefined {
  const templatePage = toPagePath(template, context)
  const names: Array<{ name: string; catchAll: boolean }> = []
  let source = ''
  for (const segment of templatePage.split('/').slice(1)) {
    const optionalCatchAll = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(segment)
    const catchAll = /^\[\.\.\.([^\]]+)\]$/.exec(segment)
    const dynamic = /^\[([^\]]+)\]$/.exec(segment)
    if (optionalCatchAll) {
      names.push({ name: optionalCatchAll[1], catchAll: true })
      source += '(?:/(.+?))?'
    } else if (catchAll) {
      names.push({ name: catchAll[1], catchAll: true })
      source += '/(.+?)'
    } else if (dynamic) {
      names.push({ name: dynamic[1], catchAll: false })
      source += '/([^/]+?)'
    } else if (segment) {
      source += `/${escapeRegex(segment)}`
    }
  }
  if (names.length === 0) {
    return undefined
  }
  const regex = new RegExp(`^${source}/?$`)

  const page = toPagePath(pathname, context)
  const candidates = [page]
  if (context.i18n) {
    const { pathname: withoutLocale, detectedLocale } = normalizeLocalePath(
      page,
      context.i18n.locales
    )
    if (detectedLocale) {
      candidates.push(withoutLocale)
    }
  }
  for (const candidate of candidates) {
    const match = regex.exec(candidate)
    if (!match) {
      continue
    }
    const params: Record<string, string | string[]> = {}
    names.forEach(({ name, catchAll }, index) => {
      const value = match[index + 1]
      if (value === undefined) {
        return
      }
      params[name] = catchAll
        ? value.split('/').filter(Boolean).map(safeDecode)
        : safeDecode(value)
    })
    return Object.keys(params).length > 0 ? params : undefined
  }
  return undefined
}

function getPathnameLocale(
  pathname: string,
  {
    basePath,
    buildId,
    i18n,
  }: {
    basePath: string
    buildId: string
    i18n: NonNullable<ResolveRoutesParams['i18n']>
  }
): string | undefined {
  let rest =
    basePath && pathname.startsWith(basePath)
      ? pathname.slice(basePath.length)
      : pathname
  const dataPrefix = `/_next/data/${buildId}/`
  if (rest.startsWith(dataPrefix)) {
    // the index data path of a locale is `<locale>.json`
    rest = `/${rest.slice(dataPrefix.length).replace(/\.json$/, '')}`
  }
  return normalizeLocalePath(rest, i18n.locales).detectedLocale
}

function getInvocationLocale(
  pathnames: string[],
  context: {
    basePath: string
    buildId: string
    i18n: NonNullable<ResolveRoutesParams['i18n']>
  },
  hostname: string
): string {
  for (const pathname of pathnames) {
    const locale = getPathnameLocale(pathname, context)
    if (locale) {
      return locale
    }
  }
  return (
    detectDomainLocale(context.i18n.domains, hostname)?.defaultLocale ||
    context.i18n.defaultLocale
  )
}

/**
 * After a rewrite, the filesystem wins over dynamic routes, as in `next start`
 * (`fsChecker.getItem` before dynamic routes): `/rewrite → /ssr-page` next to
 * `pages/[id]` is `/ssr-page`, not `/[id]`. Tries the locale-less spelling too,
 * since non-localized outputs are keyed without a locale.
 */
function findStaticPathname(
  pageUrl: URL,
  {
    index,
    basePath,
    buildId,
    i18n,
    isDataUrl,
  }: {
    index: PathnameIndex
    basePath: string
    buildId: string
    i18n: ResolveRoutesParams['i18n']
    isDataUrl: boolean
  }
): { pathname: string; url: URL } | undefined {
  const candidates = [pageUrl]
  if (i18n) {
    const rest =
      basePath && pageUrl.pathname.startsWith(basePath)
        ? pageUrl.pathname.slice(basePath.length) || '/'
        : pageUrl.pathname
    const localeResult = normalizeLocalePath(rest, i18n.locales)
    if (localeResult.detectedLocale) {
      const withoutLocale = new URL(pageUrl.toString())
      withoutLocale.pathname = `${basePath}${localeResult.pathname === '/' && basePath ? '' : localeResult.pathname}`
      candidates.push(withoutLocale)
    }
  }
  for (const candidate of candidates) {
    const url = isDataUrl
      ? denormalizeNextDataUrl(candidate, basePath, buildId)
      : candidate
    const match = lookupPathname(url.pathname, index)
    if (match && !isDynamicTemplatePathname(match.pathname)) {
      return { pathname: match.pathname, url }
    }
  }
  return undefined
}

/**
 * A data URL as its page path, the way `next start` normalizes it
 * (`middleware_next_data`): with the trailing slash `trailingSlash` gives page
 * paths, so the internal trailing-slash redirect does not fire on it.
 */
function normalizeDataUrl(
  url: URL,
  { basePath, buildId, trailingSlash }: ResolveRoutesParams
): URL {
  const normalized = normalizeNextDataUrl(url, basePath, buildId)
  const { pathname } = normalized
  if (
    trailingSlash &&
    pathname !== (basePath || '/') &&
    !pathname.endsWith('/') &&
    !pathname.slice(pathname.lastIndexOf('/')).includes('.')
  ) {
    normalized.pathname += '/'
  }
  return normalized
}

async function resolveRoutesWithIndex(
  params: ResolveRoutesParams,
  pathnames: PathnameIndex,
  state: ResolveState
): Promise<ResolveRoutesResult> {
  const {
    url: initialUrl,
    basePath,
    requestBody,
    routes,
    invokeMiddleware,
    buildId,
    i18n,
  } = params

  const { caseSensitive = false } = routes

  let currentUrl = new URL(initialUrl.toString())
  let currentRequestHeaders = state.requestHeaders
  let currentResponseHeaders = new Headers()
  let currentStatus: number | undefined
  let pendingLocaleRedirect:
    | {
        url: URL
        status: number
      }
    | undefined
  let pendingBeforeMiddlewareStop:
    | {
        status: number | undefined
      }
    | undefined
  const initialOrigin = initialUrl.origin

  // Data URLs are routed as their page path when there is middleware, like
  // `next start`'s middleware_next_data (`shouldNormalizeNextData` covers
  // middleware with pages only). Without middleware the client resolves rewrites
  // itself and requests the destination's data URL, so `next start` routes the
  // data URL as it is.
  const dataPrefix = `${basePath}/_next/data/${buildId}/`
  const hasDataPrefix = initialUrl.pathname.startsWith(dataPrefix)
  const isDataUrl =
    hasDataPrefix &&
    (!!routes.shouldNormalizeNextData ||
      (routes.middlewareMatchers?.length ?? 0) > 0)
  if (isDataUrl) {
    currentUrl = normalizeDataUrl(currentUrl, params)
  }
  // Route modules and middleware key data-request behaviour off this header, so
  // it is set from the URL and never trusted from the client.
  currentRequestHeaders.delete(NEXT_DATA_HEADER)
  if (hasDataPrefix) {
    currentRequestHeaders.set(NEXT_DATA_HEADER, '1')
  }

  // Handle i18n locale detection and redirects
  if (i18n && !isDataUrl) {
    const pathname = currentUrl.pathname.startsWith(basePath)
      ? currentUrl.pathname.slice(basePath.length) || '/'
      : currentUrl.pathname

    // Skip locale handling for _next and api routes
    if (!pathname.startsWith('/_next/') && !pathname.startsWith('/api/')) {
      const hostname = currentUrl.hostname
      const cookieHeader = currentRequestHeaders.get('cookie') || undefined
      const acceptLanguageHeader =
        currentRequestHeaders.get('accept-language') || undefined

      // Detect locale from path first
      const pathLocaleResult = normalizeLocalePath(pathname, i18n.locales)
      const localeInPath = !!pathLocaleResult.detectedLocale

      // Detect domain locale
      const domainLocale = detectDomainLocale(i18n.domains, hostname)
      const defaultLocale = domainLocale?.defaultLocale || i18n.defaultLocale

      // Determine target locale if locale detection is enabled
      let targetLocale = pathLocaleResult.detectedLocale || defaultLocale

      // Match Next.js behavior: preferred-locale auto-detection redirects only
      // on index requests, not on arbitrary non-locale pathnames.
      const shouldDetectPreferredLocale =
        i18n.localeDetection !== false &&
        !localeInPath &&
        pathLocaleResult.pathname === '/'

      if (shouldDetectPreferredLocale) {
        const detectedResult = detectLocale({
          pathname,
          hostname,
          cookieHeader,
          acceptLanguageHeader,
          i18n,
        })

        targetLocale = detectedResult.locale

        // Check if we need to redirect based on domain or locale mismatch
        if (targetLocale !== defaultLocale) {
          const targetDomain = detectDomainLocale(
            i18n.domains,
            undefined,
            targetLocale
          )

          // Redirect to different domain if target locale has a different configured domain
          if (targetDomain && targetDomain.domain !== hostname) {
            const scheme = targetDomain.http ? 'http' : 'https'
            const localePrefix =
              targetLocale === targetDomain.defaultLocale
                ? ''
                : `/${targetLocale}`
            const redirectUrl = new URL(
              `${scheme}://${targetDomain.domain}${basePath}${localePrefix}${pathname}${currentUrl.search}`
            )

            pendingLocaleRedirect = {
              url: redirectUrl,
              status: 307,
            }
          }

          // If no dedicated domain for target locale, or we're already on the right domain,
          // redirect to add locale prefix on same domain
          if (
            !targetDomain ||
            (targetDomain && targetDomain.domain === hostname)
          ) {
            const redirectUrl = new URL(currentUrl.toString())
            redirectUrl.pathname = `${basePath}/${targetLocale}${pathname}`

            pendingLocaleRedirect = {
              url: redirectUrl,
              status: 307,
            }
          }
        }
      }

      // Prefix the locale internally for route resolution (without redirecting)
      if (!localeInPath && !pendingLocaleRedirect) {
        const localeToPrefix =
          targetLocale || domainLocale?.defaultLocale || i18n.defaultLocale
        currentUrl.pathname = `${basePath}/${localeToPrefix}${pathname}`
      }
    }
  }

  // Process beforeMiddleware routes
  const beforeMiddlewareResult = processRoutes(
    routes.beforeMiddleware,
    currentUrl,
    currentRequestHeaders,
    currentResponseHeaders,
    initialOrigin,
    caseSensitive
  )

  if (beforeMiddlewareResult.status) {
    currentStatus = beforeMiddlewareResult.status
  }

  if (beforeMiddlewareResult.redirect) {
    return {
      redirect: beforeMiddlewareResult.redirect,
      resolvedHeaders: currentResponseHeaders,
      status: currentStatus,
    }
  }

  if (beforeMiddlewareResult.externalRewrite) {
    return {
      externalRewrite: beforeMiddlewareResult.externalRewrite,
      resolvedHeaders: currentResponseHeaders,
      status: currentStatus,
    }
  }

  if (beforeMiddlewareResult.stopped) {
    pendingBeforeMiddlewareStop = {
      status: currentStatus,
    }
  }

  currentUrl = beforeMiddlewareResult.url

  let middlewareInvocationUrl = currentUrl

  // Denormalize before invoking middleware if this was originally a data URL
  if (isDataUrl) {
    middlewareInvocationUrl = denormalizeNextDataUrl(
      currentUrl,
      basePath,
      buildId
    )
  }

  const shouldInvokeMiddleware = shouldInvokeMiddlewareForRequest(
    routes.middlewareMatchers,
    currentUrl,
    currentRequestHeaders,
    caseSensitive
  )

  if (shouldInvokeMiddleware) {
    // Invoke middleware
    const middlewareResult = await invokeMiddleware({
      url: middlewareInvocationUrl,
      headers: currentRequestHeaders,
      requestBody,
    })

    // Check if middleware sent the response body
    if (middlewareResult.bodySent) {
      return { middlewareResponded: true }
    }

    // Apply request headers from middleware
    if (middlewareResult.requestHeaders) {
      currentRequestHeaders = new Headers(middlewareResult.requestHeaders)
      if (hasDataPrefix) {
        currentRequestHeaders.set(NEXT_DATA_HEADER, '1')
      }
      state.requestHeaders = currentRequestHeaders
    }

    // Apply response headers from middleware
    if (middlewareResult.responseHeaders) {
      middlewareResult.responseHeaders.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') {
          currentResponseHeaders.append(key, value)
        } else {
          currentResponseHeaders.set(key, value)
        }
      })
    }

    // Handle middleware redirect
    if (middlewareResult.redirect) {
      if (!currentResponseHeaders.has('location')) {
        currentResponseHeaders.set(
          'Location',
          middlewareResult.redirect.url.toString()
        )
      }
      return {
        resolvedHeaders: currentResponseHeaders,
        status: middlewareResult.redirect.status,
      }
    }

    // Handle middleware rewrite
    if (middlewareResult.rewrite) {
      currentUrl = middlewareResult.rewrite

      // Check if it's an external rewrite
      if (currentUrl.origin !== initialOrigin) {
        return {
          externalRewrite: currentUrl,
          resolvedHeaders: currentResponseHeaders,
          status: currentStatus,
        }
      }
    }
  }

  if (pendingLocaleRedirect) {
    if (!currentResponseHeaders.has('location')) {
      currentResponseHeaders.set(
        'location',
        pendingLocaleRedirect.url.toString()
      )
    }
    return {
      redirect: pendingLocaleRedirect,
      resolvedHeaders: currentResponseHeaders,
    }
  }

  if (pendingBeforeMiddlewareStop) {
    return {
      resolvedHeaders: currentResponseHeaders,
      status: pendingBeforeMiddlewareStop.status,
    }
  }

  // Normalize again after middleware if this was originally a data URL
  if (isDataUrl) {
    currentUrl = normalizeDataUrl(currentUrl, params)
  }

  // Process beforeFiles routes
  const beforeFilesResult = processRoutes(
    routes.beforeFiles,
    currentUrl,
    currentRequestHeaders,
    currentResponseHeaders,
    initialOrigin,
    caseSensitive
  )

  if (beforeFilesResult.status) {
    currentStatus = beforeFilesResult.status
  }

  if (beforeFilesResult.redirect) {
    return {
      redirect: beforeFilesResult.redirect,
      resolvedHeaders: currentResponseHeaders,
      status: currentStatus,
    }
  }

  if (beforeFilesResult.externalRewrite) {
    return {
      externalRewrite: beforeFilesResult.externalRewrite,
      resolvedHeaders: currentResponseHeaders,
      status: currentStatus,
    }
  }

  if (beforeFilesResult.stopped) {
    return {
      resolvedHeaders: currentResponseHeaders,
      status: currentStatus,
    }
  }

  currentUrl = beforeFilesResult.url

  // Denormalize before checking pathnames if this was originally a data URL
  if (isDataUrl) {
    currentUrl = denormalizeNextDataUrl(currentUrl, basePath, buildId)
  }

  // Check if pathname matches any provided pathnames (pathnames are in denormalized form)
  let matchedPath = matchesPathname(currentUrl.pathname, pathnames)
  if (matchedPath) {
    return resolveMatchedPathname(currentUrl, matchedPath)
  }

  // Normalize again before processing afterFiles if this was originally a data URL
  if (isDataUrl) {
    currentUrl = normalizeDataUrl(currentUrl, params)
  }

  const staticLookup = {
    index: pathnames,
    basePath,
    buildId,
    i18n,
    isDataUrl,
  }

  // Process afterFiles routes, then fallback routes: both rewrite, then resolve
  // the destination against outputs and dynamic routes.
  for (const routeList of [routes.afterFiles, routes.fallback]) {
    for (const route of routeList) {
      const match = matchRoute(
        route,
        currentUrl,
        currentRequestHeaders,
        caseSensitive
      )

      if (!match.matched) {
        continue
      }

      if (match.headers) {
        for (const [key, value] of Object.entries(match.headers)) {
          currentResponseHeaders.set(key, value)
        }
      }

      if (route.status) {
        currentStatus = route.status
      }

      if (!match.destination) {
        continue
      }

      // Check if route has redirect status and Location/Refresh header
      if (
        isRedirectStatus(route.status) &&
        match.headers &&
        hasRedirectHeaders(match.headers)
      ) {
        const redirectUrl = isExternalDestination(match.destination)
          ? new URL(match.destination)
          : applyDestination(currentUrl, match.destination)

        return {
          redirect: {
            url: redirectUrl,
            status: route.status!,
          },
          resolvedHeaders: currentResponseHeaders,
          status: currentStatus,
        }
      }

      // Check if it's an external rewrite
      if (isExternalDestination(match.destination)) {
        return {
          externalRewrite: new URL(match.destination),
          resolvedHeaders: currentResponseHeaders,
          status: currentStatus,
        }
      }

      // Apply destination
      currentUrl = applyDestination(currentUrl, match.destination)

      // Check if origin changed
      if (currentUrl.origin !== initialOrigin) {
        return {
          externalRewrite: currentUrl,
          resolvedHeaders: currentResponseHeaders,
          status: currentStatus,
        }
      }

      const staticMatch = findStaticPathname(currentUrl, staticLookup)
      if (staticMatch) {
        return resolveMatchedPathname(staticMatch.url, staticMatch.pathname)
      }

      const dynamicResult = checkDynamicRoutes(
        routes.dynamicRoutes,
        currentUrl,
        pathnames,
        currentRequestHeaders,
        currentResponseHeaders,
        routes.onMatch,
        basePath,
        buildId,
        i18n,
        true,
        isDataUrl,
        caseSensitive
      )
      if (dynamicResult.matched && dynamicResult.result) {
        return { ...dynamicResult.result, status: currentStatus }
      }

      // A rewrite to a dynamic route's template pathname itself
      const pathnameCheckUrl = isDataUrl
        ? denormalizeNextDataUrl(currentUrl, basePath, buildId)
        : currentUrl
      matchedPath = matchesPathname(pathnameCheckUrl.pathname, pathnames)
      if (matchedPath) {
        const finalHeaders = applyOnMatchHeaders(
          routes.onMatch,
          pathnameCheckUrl,
          currentRequestHeaders,
          currentResponseHeaders,
          caseSensitive
        )
        return withResolvedInvocationTarget({
          result: {
            resolvedHeaders: finalHeaders,
            status: currentStatus,
          },
          url: pathnameCheckUrl,
          resolvedPathname: matchedPath,
          invocationPathname: pathnameCheckUrl.pathname,
        })
      }
    }

    if (routeList === routes.afterFiles) {
      // Check dynamic routes between afterFiles and fallback
      const dynamicResult = resolveDynamicRoute()
      if (dynamicResult) {
        return dynamicResult
      }
    }
  }

  // No match found
  return {
    resolvedHeaders: currentResponseHeaders,
    status: currentStatus,
  }

  /**
   * An output matched `url`. A dynamic route resolving to the same output (or
   * the output being a template) still contributes its route matches, e.g. the
   * params of a prerendered `/posts/my-post`.
   */
  function resolveMatchedPathname(
    matchUrl: URL,
    outputPathname: string
  ): ResolveRoutesResult {
    let templateParams: RouteParams | undefined
    for (const route of routes.dynamicRoutes) {
      const match = matchDynamicRoute(matchUrl.pathname, route, caseSensitive)

      if (!match.matched) {
        continue
      }

      const hasResult = checkHasConditions(
        route.has,
        matchUrl,
        currentRequestHeaders
      )
      const missingMatched = checkMissingConditions(
        route.missing,
        matchUrl,
        currentRequestHeaders
      )

      if (!hasResult.matched || !missingMatched) {
        continue
      }

      const replacedDestination = route.destination
        ? replaceDestination(
            route.destination,
            match.regexMatches || null,
            hasResult.captures
          )
        : undefined
      const pathnameToCheck = replacedDestination
        ? replacedDestination.split('?')[0]
        : matchUrl.pathname
      const dynamicMatchedPath = matchesPathnameWithLocaleFallback({
        pathname: pathnameToCheck,
        pathnames,
        basePath,
        i18n,
      })
      if (!dynamicMatchedPath) {
        // When a dynamic route rewrites to a non-template/static destination
        // that isn't part of pathnames, preserve route params for the currently
        // matched concrete pathname.
        if (isDynamicTemplatePathname(pathnameToCheck)) {
          continue
        }

        const resolvedUrl = replacedDestination
          ? mergeDestinationQueryIntoUrl(matchUrl, replacedDestination)
          : matchUrl
        const finalHeaders = applyOnMatchHeaders(
          routes.onMatch,
          resolvedUrl,
          currentRequestHeaders,
          currentResponseHeaders,
          caseSensitive
        )
        return withResolvedInvocationTarget({
          result: {
            routeMatches: match.params,
            resolvedHeaders: finalHeaders,
            status: currentStatus,
          },
          url: resolvedUrl,
          resolvedPathname: outputPathname,
          invocationPathname: matchUrl.pathname,
        })
      }

      const shouldUseDynamicMatch =
        dynamicMatchedPath === outputPathname ||
        isDynamicTemplatePathname(outputPathname)
      if (!shouldUseDynamicMatch) {
        // A concrete output of a dynamic page (a prerendered `/ssg/hello` of
        // `/ssg/[slug]`): the module still needs the params, and after a
        // middleware rewrite it cannot derive them from `req.url`.
        if (!templateParams && isDynamicTemplatePathname(dynamicMatchedPath)) {
          templateParams = getRouteParams(
            dynamicMatchedPath,
            matchUrl.pathname,
            {
              basePath,
              buildId,
              i18n,
            }
          )
        }
        continue
      }

      const resolvedUrl = replacedDestination
        ? mergeDestinationQueryIntoUrl(matchUrl, replacedDestination)
        : matchUrl
      const finalHeaders = applyOnMatchHeaders(
        routes.onMatch,
        resolvedUrl,
        currentRequestHeaders,
        currentResponseHeaders,
        caseSensitive
      )
      return withResolvedInvocationTarget({
        result: {
          routeMatches: match.params,
          resolvedHeaders: finalHeaders,
          status: currentStatus,
        },
        url: resolvedUrl,
        resolvedPathname: dynamicMatchedPath,
        invocationPathname: matchUrl.pathname,
      })
    }

    // No dynamic route matched, return without route matches
    const finalHeaders = applyOnMatchHeaders(
      routes.onMatch,
      matchUrl,
      currentRequestHeaders,
      currentResponseHeaders,
      caseSensitive
    )
    return withResolvedInvocationTarget({
      result: {
        resolvedHeaders: finalHeaders,
        status: currentStatus,
        ...(templateParams ? { params: templateParams } : {}),
      },
      url: matchUrl,
      resolvedPathname: outputPathname,
      invocationPathname: matchUrl.pathname,
    })
  }

  function resolveDynamicRoute(): ResolveRoutesResult | undefined {
    return resolveDynamicRouteFor(currentUrl)
  }

  function resolveDynamicRouteFor(
    candidateUrl: URL
  ): ResolveRoutesResult | undefined {
    for (const route of routes.dynamicRoutes) {
      const match = matchDynamicRoute(
        candidateUrl.pathname,
        route,
        caseSensitive
      )

      if (!match.matched) {
        continue
      }

      // Check has/missing conditions
      const hasResult = checkHasConditions(
        route.has,
        candidateUrl,
        currentRequestHeaders
      )
      const missingMatched = checkMissingConditions(
        route.missing,
        candidateUrl,
        currentRequestHeaders
      )

      if (!hasResult.matched || !missingMatched) {
        continue
      }

      const replacedDestination = route.destination
        ? replaceDestination(
            route.destination,
            match.regexMatches || null,
            hasResult.captures
          )
        : undefined
      // Check if the destination pathname (template path) is in the provided pathnames list
      // For dynamic routes, the destination contains the template path like /dynamic/[slug]
      const pathnameToCheck = replacedDestination
        ? replacedDestination.split('?')[0]
        : candidateUrl.pathname
      const dynamicMatchedPath = matchesPathnameWithLocaleFallback({
        pathname: pathnameToCheck,
        pathnames,
        basePath,
        i18n,
      })
      if (!dynamicMatchedPath) {
        continue
      }

      const resolvedUrl = replacedDestination
        ? mergeDestinationQueryIntoUrl(candidateUrl, replacedDestination)
        : candidateUrl
      const finalHeaders = applyOnMatchHeaders(
        routes.onMatch,
        resolvedUrl,
        currentRequestHeaders,
        currentResponseHeaders,
        caseSensitive
      )
      return withResolvedInvocationTarget({
        result: {
          routeMatches: match.params,
          resolvedHeaders: finalHeaders,
          status: currentStatus,
        },
        url: resolvedUrl,
        resolvedPathname: dynamicMatchedPath,
        // data requests are invoked as data URLs whichever way they matched
        invocationPathname: isDataUrl
          ? denormalizeNextDataUrl(candidateUrl, basePath, buildId).pathname
          : candidateUrl.pathname,
      })
    }
    return undefined
  }
}
