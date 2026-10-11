const BASE = '/pub/tagly/tagly'
module.exports = {
  basePath: BASE,
  assetPrefix: BASE,
  skipTrailingSlashRedirect: true,
  output: 'standalone',
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
}
