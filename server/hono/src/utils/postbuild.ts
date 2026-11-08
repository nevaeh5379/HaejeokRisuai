import fs from 'node:fs'

// This script is expected to run in root dir
fs.cpSync('./dist', 'server/hono/static', { recursive: true })
fs.cpSync('./dist', 'server/hono/.vercel/output/static', { recursive: true })
