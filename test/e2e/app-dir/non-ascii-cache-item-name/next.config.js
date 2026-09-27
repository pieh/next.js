/**
 * @type {import('next').NextConfig}
 */
// A deployment checks the constraint through the real cache implementation,
// which serializes cache metadata into request headers itself. Everywhere else
// the fixture supplies a handler that applies the same conversion. Other
// platforms' deploy scripts set `PLATFORM_PROVIDES_CACHE_HANDLER` to opt in.
const platformProvidesCacheHandler =
  process.env.VERCEL || process.env.PLATFORM_PROVIDES_CACHE_HANDLER
const nextConfig = platformProvidesCacheHandler
  ? {}
  : {
      cacheHandler: require.resolve('./cache-handler.js'),
      // The in-memory cache would answer repeat lookups without consulting the
      // handler, which is where the local assertions read from.
      cacheMaxMemorySize: 0,
    }

module.exports = nextConfig
