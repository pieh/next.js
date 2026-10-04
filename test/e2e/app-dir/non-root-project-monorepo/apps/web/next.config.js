/**
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  experimental: {
    instantInsights: {
      validationLevel: 'manual-warning',
    },
  },
}

// Deploy tests read this from the build logs: server bundles embed the build's source paths.
console.log(`PROJECT_DIR_URL: ${require('url').pathToFileURL(__dirname).href}/`)

module.exports = nextConfig
