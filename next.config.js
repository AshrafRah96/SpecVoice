/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NODE_ENV === 'test' ? '.next-e2e' : '.next',
  turbopack: {
    root: __dirname,
  },
}

module.exports = nextConfig
