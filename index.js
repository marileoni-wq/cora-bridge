const Fastify = require('fastify')
const { WebSocket } = require('ws')
const { randomUUID } = require('crypto')

const app = Fastify({ logger: true })

// Textos recentemente enviados pelo bridge — ignorar ecos
const recentSentTexts = []

// ─── Config ───────────────────────────────────────────────────────────────────

const OPENCLAW_HOST     = process.env.OPENCLAW_HOST     || '143.95.215.63'
const OPENCLAW_PORT     = process.env.OPENCLAW_PORT     || '47716'
const OPENCLAW_TOKEN    = process.env.OPENCLAW_TOKEN    || 'fd2c68de5b12a920df42bd8f2b85d9b144ff616b66739498408e4d1ce52d359d'
const MARIANA_PHONE     = process.env.MARIANA_PHONE     || '5511918300547'
const ZAPI_INSTANCE     = process.env.ZAPI_INSTANCE     || '3F3F72B027C7B281F910B26D6B588ED8'
const ZAPI_TOKEN        = process.env.ZAPI_TOKEN        || 'C84F943ED6E66A1288C9AC21'
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || 'Fc3ba3b04ab424e6280e538af13f8744eS'
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET    || ''

// ─── Z-API send ───────────────────────────────────────────────────────────────

async function sendViaZAPI(phone, message) {
  // Register text BEFORE sending so the echo webhook is ignored
  recentSentTexts.unshift(message)
  if (recentSentTexts.length > 20) recentSentTexts.pop()

  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Client-Token': ZAPI_CLIENT_TOKEN
    },
    body: JSON.stringify({ phone, message })
  })
  return res.json()
}

// ─── OpenClaw injection ────────────────────────────────────────────────────────

function injectToOpenClaw(fromPhone, text) {
  return new Promise((resolve, reject) => {
    const wsUrl = `ws://${OPENCLAW_HOST}:${OPENCLAW_PORT}`
    const ws = new WebSocket(wsUrl, {
      headers: { 'Origin': `http://${OPENCLAW_HOST}:${OPENCLAW_PORT}` }
    })

    let reqId = 1
    let step = 'challenge'
    let done = false

    const finish = (err, result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      ws.terminate()
      err ? reject(err) : resolve(result)
    }

    // 60s total — LLM may take up to ~10s + Z-API send
    const timer = setTimeout(() => finish(new Error('OpenClaw timeout')), 60000)

    function send(obj) {
      try { ws.send(JSON.stringify(obj)) } catch (e) { finish(e) }
    }

    function req(method, params) {
      const id = String(reqId++)
      send({ type: 'req', id, method, params })
    }

    ws.on('message', raw => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }

      // Step 1: respond to challenge
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        step = 'connecting'
        req('connect', {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: 'cli', version: '1.0.0', platform: 'linux', mode: 'cli' },
          scopes: ['operator.admin', 'operator.read', 'operator.write'],
          auth: { token: OPENCLAW_TOKEN }
        })
        return
      }

      if (msg.type !== 'res') return  // ignore events from here on

      if (msg.payload?.error || msg.error) {
        const e = msg.payload?.error || msg.error
        return finish(new Error(e.message || JSON.stringify(e)))
      }

      // Step 2: authenticated → inject
      if (step === 'connecting') {
        step = 'injecting'
        req('agent', {
          message: text,
          agentId: 'main',
          deliver: false,
          idempotencyKey: randomUUID()
        })
        return
      }

      // Step 3a: "accepted" — OpenClaw received it, LLM processing
      if (step === 'injecting' && msg.payload?.status === 'accepted') {
        step = 'waiting'
        app.log.info({ runId: msg.payload.runId }, 'agent accepted, waiting for response')
        return
      }

      // Step 3b: "ok" — LLM done, response ready
      if (step === 'waiting' && msg.payload?.status === 'ok') {
        const responseText = msg.payload?.result?.payloads?.[0]?.text
        app.log.info({ responseText }, 'agent response received')

        if (!responseText) {
          return finish(null, { ok: true, noText: true })
        }

        sendViaZAPI(fromPhone, responseText)
          .then(zapiResult => {
            app.log.info({ zapiResult }, 'sent via Z-API')
            finish(null, { ok: true, delivered: true, zapiResult })
          })
          .catch(err => finish(new Error('Z-API send failed: ' + err.message)))
      }
    })

    ws.on('error', err => finish(err))
    ws.on('close', () => { if (!done) finish(new Error('ws closed unexpectedly')) })
  })
}

// ─── Webhook endpoint ──────────────────────────────────────────────────────────

app.post('/webhook/zapi', async (req, reply) => {
  const body = req.body

  if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return reply.status(401).send({ error: 'unauthorized' })
  }

  const isFromMe  = body.isFromMe === true || body.fromMe === true
  const isGroup   = body.isGroup  === true
  const rawPhone  = (body.phone || '').replace(/\D/g, '')
  const fromPhone = rawPhone.startsWith('55') ? rawPhone : '55' + rawPhone
  const text      = body.text?.message || body.message || body.body || ''
  app.log.info({ rawPhone, fromPhone, isFromMe, isGroup, text }, 'webhook received')

  // Ignore echo: messages sent by this bridge coming back as webhook
  if (text) {
    const idx = recentSentTexts.indexOf(text)
    if (idx !== -1) {
      recentSentTexts.splice(idx, 1)
      return reply.send({ ok: true, skipped: 'echo' })
    }
  }

  if (isGroup) return reply.send({ ok: true, skipped: 'group' })

  if (fromPhone !== MARIANA_PHONE) {
    return reply.send({ ok: true, skipped: `irrelevant: ${fromPhone}` })
  }

  if (!text) return reply.send({ ok: true, skipped: 'no text' })

  try {
    const result = await injectToOpenClaw(fromPhone, text)
    app.log.info({ result }, 'done')
    return reply.send({ ok: true, result })
  } catch (err) {
    app.log.error({ err: err.message }, 'failed')
    return reply.status(500).send({ ok: false, error: err.message })
  }
})

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', async () => ({
  ok: true,
  service: 'cora-bridge',
  ts: new Date().toISOString()
}))

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10)

app.listen({ port: PORT, host: '0.0.0.0' }, err => {
  if (err) { app.log.error(err); process.exit(1) }
  app.log.info(`Cora Bridge running on port ${PORT}`)
})
