const Fastify = require('fastify')
const { WebSocket } = require('ws')
const { randomUUID } = require('crypto')

const app = Fastify({ logger: true })

// ─── Config ───────────────────────────────────────────────────────────────────

const OPENCLAW_HOST = process.env.OPENCLAW_HOST || '143.95.215.63'
const OPENCLAW_PORT = process.env.OPENCLAW_PORT || '47716'
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || 'fd2c68de5b12a920df42bd8f2b85d9b144ff616b66739498408e4d1ce52d359d'
const MARIANA_PHONE  = process.env.MARIANA_PHONE  || '5511918300547'
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '' // opcional: proteção extra

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

    const timer = setTimeout(() => finish(new Error('OpenClaw timeout')), 20000)

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

      if (msg.type === 'event' && msg.event !== 'connect.challenge') return

      // Step 1: respond to challenge
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        step = 'connecting'
        send({
          type: 'req',
          id: String(reqId++),
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: 'cli', version: '1.0.0', platform: 'linux', mode: 'cli' },
            scopes: ['operator.admin', 'operator.read', 'operator.write'],
            auth: { token: OPENCLAW_TOKEN }
          }
        })
        return
      }

      if (msg.type === 'res') {
        if (msg.error) {
          return finish(new Error(msg.error.message))
        }

        // Step 2: authenticated → inject message as agent turn
        if (step === 'connecting') {
          step = 'injecting'

          // Format message so Cora understands the context
          const agentMessage = `📱 Mensagem recebida via WhatsApp de +${fromPhone}:\n"${text}"`

          req('agent', {
            message: agentMessage,
            agentId: 'main',
            deliver: true,
            idempotencyKey: randomUUID()
          })
          return
        }

        // Step 3: agent turn queued
        if (step === 'injecting') {
          finish(null, { ok: true, queued: true })
        }
      }
    })

    ws.on('error', err => finish(err))
    ws.on('close', () => { if (!done) finish(new Error('ws closed unexpectedly')) })
  })
}

// ─── Webhook endpoint ──────────────────────────────────────────────────────────

app.post('/webhook/zapi', async (req, reply) => {
  const body = req.body

  // Optional: validate webhook secret
  if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return reply.status(401).send({ error: 'unauthorized' })
  }

  // Z-API webhook payload (multi-device format)
  // Received message: body.phone, body.text.message, body.isFromMe
  // For group messages, body.isGroup is true

  const isFromMe  = body.isFromMe === true || body.fromMe === true
  const isGroup   = body.isGroup  === true
  const rawPhone  = (body.phone || '').replace(/\D/g, '')
  // Normalize: accept with or without country code 55
  const fromPhone = rawPhone.startsWith('55') ? rawPhone : '55' + rawPhone
  const text      = body.text?.message || body.message || body.body || ''

  app.log.info({ rawPhone, fromPhone, isFromMe, isGroup, text }, 'webhook received')

  // Skip groups
  if (isGroup) {
    return reply.send({ ok: true, skipped: 'group' })
  }

  // Since Mariana's phone IS the Z-API instance, her messages come as fromMe=true
  // and body.phone = recipient. We process:
  //   1. fromMe=true  + phone=MARIANA_PHONE  → she messaged herself (self-chat)
  //   2. fromMe=false + phone=MARIANA_PHONE  → someone messaged her
  if (fromPhone !== MARIANA_PHONE) {
    return reply.send({ ok: true, skipped: `irrelevant: ${fromPhone}` })
  }

  if (!text) {
    return reply.send({ ok: true, skipped: 'no text' })
  }

  try {
    const result = await injectToOpenClaw(fromPhone, text)
    app.log.info({ result }, 'injected to OpenClaw')
    return reply.send({ ok: true, result })
  } catch (err) {
    app.log.error({ err: err.message }, 'failed to inject to OpenClaw')
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
