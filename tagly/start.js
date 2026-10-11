const fs = require('fs'), path = require('path'), { execSync } = require('child_process')
const LOG = path.join(__dirname, 'app.log')
const log = (msg) => { try { fs.appendFileSync(LOG, msg + '\n') } catch(e) {} }
fs.writeFileSync(LOG, '[START]\n')
const port = parseInt(process.env.PORT || '3000', 10)
log(`[PORT] ${port}`)
try { execSync(`lsof -ti :${port} | xargs -r kill -9`, { stdio: 'ignore' }) } catch(e) {}
const BASE_PATH = '/pub/tagly/tagly'
const next = require('next')
const app = next({ dev: false })
const handle = app.getRequestHandler()
app.prepare().then(() => {
  log('[PREPARED]')
  const server = require('http').createServer((req, res) => {
    req.url = BASE_PATH + (req.url || '/')
    handle(req, res, require('url').parse(req.url, true))
  })
  server.on('error', (err) => log(`[ERR] ${err.message}`))
  server.listen(port, () => log(`[READY] ${port}`))
}).catch(err => { log(`[FAIL] ${err.message}`); process.exit(1) })
