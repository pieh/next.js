# @next/routing

Shared route resolving package for Next.js.

## Overview

This package provides a comprehensive route resolution system that handles rewrites, redirects, middleware invocation, and dynamic route matching with support for conditional routing based on headers, cookies, queries, and host.

## Installation

```bash
npm install @next/routing
```

## Usage

```typescript
import { resolveRoutes } from '@next/routing'

const result = await resolveRoutes({
  url: new URL('https://example.com/api/users'),
  basePath: '',
  requestBody: readableStream,
  headers: new Headers(),
  pathnames: ['/api/users', '/api/posts'],
  routes: {
    beforeMiddleware: [],
    beforeFiles: [],
    afterFiles: [],
    dynamicRoutes: [],
    onMatch: [],
    fallback: [],
  },
  invokeMiddleware: async (ctx) => {
    // Your middleware logic
    return {}
  },
})

if (result.resolvedPathname) {
  console.log('Resolved pathname:', result.resolvedPathname)
  console.log('Resolved query:', result.resolvedQuery)
  console.log('Invocation target:', result.invocationTarget)
}
```

`pathnames` entries can carry the output type (`{ pathname, type }`, types as in the adapter output) so type-dependent rules apply, e.g. an explicitly locale-prefixed request never resolves to an API route.

`invocationTarget` is where the request resolved to after rewrites and middleware, for routing or caching by the destination. To invoke the entrypoint of the matched output, apply `result.invocation` as is: `invocation.url` as `req.url`, `invocation.requestMeta` as request meta, and `invocation.headers` as the request headers. See [Routing with @next/routing](https://nextjs.org/docs/app/api-reference/adapters/routing-with-next-routing).

## Route Resolution Flow

1. **beforeMiddleware routes** - Applied before middleware execution
2. **invokeMiddleware** - Custom middleware logic
3. **beforeFiles routes** - Applied before checking filesystem
4. **Static pathname matching** - Check against provided pathnames
5. **afterFiles routes** - Applied after filesystem checks
6. **dynamicRoutes** - Dynamic route matching with parameter extraction
7. **fallback routes** - Final fallback routes

## Route Configuration

Each route can have:

- `sourceRegex` - Regular expression to match against pathname
- `destination` - Destination path with support for replacements ($1, $name)
- `headers` - Headers to apply on match
- `has` - Conditions that must match
- `missing` - Conditions that must not match
- `status` - HTTP status code (3xx for redirects)

### Redirects

When a route has:
- A redirect status code (300-399)
- Headers containing `Location` or `Refresh`

The routing will end immediately and return a `redirect` result with the destination URL and status code.

### Has/Missing Conditions

Conditions support:

- `header` - Match HTTP headers
- `cookie` - Match cookies
- `query` - Match query parameters
- `host` - Match hostname

Values can be:

- `undefined` - Match if key exists
- String - Direct string match
- Regex string - Match against regex pattern
