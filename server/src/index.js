import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { assertConnection, pool } from './db.js'
import { demoRequests } from './routes/demoRequests.js'

const app = express()
const PORT = Number(process.env.PORT || 4000)

// Two proxies sit in front of the app: CloudFront, then nginx. Each appends
// to X-Forwarded-For, so Express must skip both to reach the real client.
// At 1 it stopped at the CloudFront edge address and the rate limiter keyed
// every visitor behind one edge to the same bucket.
app.set('trust proxy', 2)
app.disable('x-powered-by')

const origins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

// In production the API is same-origin (nginx proxies /api), so CORS only
// matters for local development against the Vite dev server.
app.use(
  cors({
    origin: origins.length ? origins : false,
    methods: ['GET', 'POST'],
  }),
)

app.use(express.json({ limit: '16kb' }))

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ status: 'ok', database: 'up' })
  } catch {
    res.status(503).json({ status: 'degraded', database: 'down' })
  }
})

app.use('/api/demo-requests', demoRequests)

app.use((_req, res) => res.status(404).json({ error: 'Not found.' }))

// Central error handler: log the real reason, return an opaque message so
// driver internals and SQL never reach the browser.
app.use((err, _req, res, _next) => {
  console.error('[api]', err)
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' })
})

async function start() {
  try {
    await assertConnection()
    console.log('[api] database connection ok')
  } catch (err) {
    console.error('[api] cannot reach the database:', err.message)
    process.exit(1)
  }

  const server = app.listen(PORT, () => {
    console.log(`[api] listening on http://127.0.0.1:${PORT}`)
  })

  const shutdown = async (signal) => {
    console.log(`[api] ${signal} received, shutting down`)
    server.close()
    await pool.end()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

start()
