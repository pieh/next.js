/**
 * Replaces $1, $2, etc. and $name placeholders in the destination string
 * with matches from the regex and has conditions
 */
export function replaceDestination(
  destination: string,
  regexMatches: RegExpMatchArray | null,
  hasCaptures: Record<string, string>
): string {
  const values = new Map<string, string>()

  // `has` captures first: a regex group of the same name takes precedence
  for (const [name, value] of Object.entries(hasCaptures)) {
    values.set(name, value)
  }

  if (regexMatches) {
    // Numbered groups, skipping index 0 which is the full match
    for (let i = 1; i < regexMatches.length; i++) {
      values.set(String(i), regexMatches[i] ?? '')
    }

    if (regexMatches.groups) {
      for (const [name, value] of Object.entries(regexMatches.groups)) {
        values.set(name, value ?? '')
      }
    }
  }

  // One pass over the whole destination: replacing placeholders one at a time would let a name
  // that is a prefix of another one corrupt the longer one (`$nxtPid` inside `$nxtPid2`, `$1`
  // inside `$10`), and would re-substitute placeholder-looking text coming from a value.
  // Unknown placeholders are left untouched, as before.
  return destination.replace(
    /\$([A-Za-z_][A-Za-z0-9_]*|[1-9][0-9]*)/g,
    (placeholder, name: string) => values.get(name) ?? placeholder
  )
}

/**
 * Checks if a destination is an external rewrite (starts with http/https)
 */
export function isExternalDestination(destination: string): boolean {
  return destination.startsWith('http://') || destination.startsWith('https://')
}

/**
 * Applies a destination to a URL, updating the pathname or creating a new URL
 * if it's external
 */
export function applyDestination(currentUrl: URL, destination: string): URL {
  if (isExternalDestination(destination)) {
    return new URL(destination)
  }

  // Create a new URL with the updated pathname
  const newUrl = new URL(currentUrl.toString())

  // Handle destinations with query strings
  const [pathname, search] = destination.split('?')
  newUrl.pathname = pathname

  if (search) {
    // Merge query parameters
    const newParams = new URLSearchParams(search)
    for (const [key, value] of newParams.entries()) {
      newUrl.searchParams.set(key, value)
    }
  }

  return newUrl
}

/**
 * Checks if a status code is a redirect status code
 */
export function isRedirectStatus(status: number | undefined): boolean {
  if (!status) return false
  return status >= 300 && status < 400
}

/**
 * Checks if headers contain redirect headers (Location or Refresh)
 */
export function hasRedirectHeaders(headers: Record<string, string>): boolean {
  const lowerCaseKeys = Object.keys(headers).map((k) => k.toLowerCase())
  return lowerCaseKeys.includes('location') || lowerCaseKeys.includes('refresh')
}
