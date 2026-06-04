const Fastify = require('fastify')
const { WebSocket } = require('ws')
const { randomUUID } = require('crypto')
const { Resvg } = require('@resvg/resvg-js')

const app = Fastify({ logger: true })

// ─── Config ───────────────────────────────────────────────────────────────────

const OPENCLAW_HOST     = process.env.OPENCLAW_HOST     || '143.95.215.63'
const OPENCLAW_PORT     = process.env.OPENCLAW_PORT     || '47716'
const OPENCLAW_TOKEN    = process.env.OPENCLAW_TOKEN    || 'fd2c68de5b12a920df42bd8f2b85d9b144ff616b66739498408e4d1ce52d359d'
const MARIANA_PHONE     = process.env.MARIANA_PHONE     || '5511918300547'
const ZAPI_INSTANCE     = process.env.ZAPI_INSTANCE     || '3F3F72B027C7B281F910B26D6B588ED8'
const ZAPI_TOKEN        = process.env.ZAPI_TOKEN        || 'C84F943ED6E66A1288C9AC21'
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || 'Fc3ba3b04ab424e6280e538af13f8744eS'
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET    || ''
const BRIDGE_URL        = process.env.BRIDGE_URL        || 'https://cora-bridge.onrender.com'

// ─── In-memory image cache ────────────────────────────────────────────────────

const imageCache = new Map()
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000 // 10 min TTL
  for (const [k, v] of imageCache) {
    if (v.createdAt < cutoff) imageCache.delete(k)
  }
}, 60_000)

// ─── Card generator (SVG → PNG, FIRM Collective brand) ───────────────────────

function splitLines(text, maxChars) {
  const words = text.split(' ')
  const lines = []
  let cur = ''
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w
    if (test.length > maxChars) { if (cur) lines.push(cur); cur = w }
    else cur = test
  }
  if (cur) lines.push(cur)
  return lines
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildCardSVG(headline, subtext) {
  const W = 1080, H = 1080

  const headLines = splitLines(headline.toUpperCase(), 16)
  const headFS    = headLines.length === 1 ? 100 : headLines.length === 2 ? 86 : 72
  const headLH    = headFS * 1.18
  const headH     = headLines.length * headLH

  const subLines = subtext ? splitLines(subtext, 38) : []
  const subFS    = 36
  const subLH    = subFS * 1.55
  const subH     = subLines.length * subLH

  const gap      = subLines.length ? 56 : 0
  const totalH   = headH + gap + subH
  const startY   = (H - totalH) / 2

  const headSVG = headLines.map((l, i) =>
    `<text x="540" y="${startY + (i + 0.82) * headLH}"
      font-family="'Arial Black',Arial,Impact,sans-serif"
      font-size="${headFS}" font-weight="900"
      fill="#E8A000" text-anchor="middle" letter-spacing="2">${esc(l)}</text>`
  ).join('\n  ')

  const subY   = startY + headH + gap
  const subSVG = subLines.map((l, i) =>
    `<text x="540" y="${subY + (i + 0.82) * subLH}"
      font-family="Arial,sans-serif"
      font-size="${subFS}" font-weight="400"
      fill="#C8C8C8" text-anchor="middle" letter-spacing="0.5">${esc(l)}</text>`
  ).join('\n  ')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <pattern id="g" width="54" height="54" patternUnits="userSpaceOnUse">
      <path d="M 54 0 L 0 0 0 54" fill="none" stroke="#fff" stroke-width="0.4" opacity="0.06"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="#0B1929"/>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect x="60" y="68" width="56" height="4" fill="#E8A000"/>
  <rect x="60" y="${H - 72}" width="56" height="4" fill="#E8A000"/>
  <text x="60" y="${H - 34}"
    font-family="Arial,sans-serif" font-size="18" font-weight="700"
    fill="#E8A000" opacity="0.55" letter-spacing="5">FIRM COLLECTIVE</text>
  ${headSVG}
  ${subLines.length ? `
  <rect x="440" y="${subY - 20}" width="200" height="1" fill="#E8A000" opacity="0.28"/>
  ${subSVG}` : ''}
</svg>`
}

function generateCardPng(headline, subtext) {
  const svg   = buildCardSVG(headline, subtext)
  const resvg = new Resvg(svg, { fitTo: { mode: 'original' } })
  return resvg.render().asPng()
}

// ─── Parse [[CARD: headline | subtext]] from Cora response ───────────────────

function parseCoraResponse(raw) {
  const match = raw.match(/\[\[CARD:\s*([^|\]]+?)(?:\s*\|\s*([\s\S]*?))?\]\]/i)
  if (!match) return { cleanText: raw.trim(), card: null }
  const headline  = match[1].trim()
  const subtext   = match[2] ? match[2].trim() : null
  const cleanText = raw.replace(/\[\[CARD:[\s\S]*?\]\]/gi, '').trim()
  return { cleanText, card: { headline, subtext } }
}

// ─── Z-API helpers ────────────────────────────────────────────────────────────

async function sendViaZAPI(phone, message) {
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Token': ZAPI_CLIENT_TOKEN },
    body: JSON.stringify({ phone, message })
  })
  return res.json()
}

async function sendImageViaZAPI(phone, imageUrl, caption) {
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-image`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Token': ZAPI_CLIENT_TOKEN },
    body: JSON.stringify({ phone, image: imageUrl, caption: caption || '' })
  })
  return res.json()
}

// ─── Serve generated card images ──────────────────────────────────────────────

app.get('/img/:id', async (req, reply) => {
  const img = imageCache.get(req.params.id)
  if (!img) return reply.status(404).send('not found')
  reply.header('Content-Type', 'image/png')
  return reply.send(img.buffer)
})

// ─── OpenClaw injection ────────────────────────────────────────────────────────

function injectToOpenClaw(text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${OPENCLAW_HOST}:${OPENCLAW_PORT}`, {
      headers: { 'Origin': `http://${OPENCLAW_HOST}:${OPENCLAW_PORT}` }
    })

    let reqId = 1, step = 'challenge', done = false

    const finish = (err, result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      ws.terminate()
      err ? reject(err) : resolve(result)
    }

    const timer = setTimeout(() => finish(new Error('OpenClaw timeout')), 90_000)

    function send(obj) { try { ws.send(JSON.stringify(obj)) } catch (e) { finish(e) } }
    function req(method, params) { send({ type: 'req', id: String(reqId++), method, params }) }

    ws.on('message', raw => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }

      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        step = 'connecting'
        req('connect', {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'cli', version: '1.0.0', platform: 'linux', mode: 'cli' },
          scopes: ['operator.admin', 'operator.read', 'operator.write'],
          auth: { token: OPENCLAW_TOKEN }
        })
        return
      }

      if (msg.type !== 'res') return

      if (msg.payload?.error || msg.error) {
        const e = msg.payload?.error || msg.error
        return finish(new Error(e.message || JSON.stringify(e)))
      }

      if (step === 'connecting') {
        step = 'injecting'
        const ctx = `[Mensagem da Mariana via WhatsApp]
Responda diretamente e com naturalidade.
NÃO use ferramentas de envio (message.send, whatsapp.send, openai-image-gen etc) — o bridge faz a entrega automaticamente.
NÃO mencione erros técnicos, canais, gateway ou quota para a Mariana.

QUANDO criar conteúdo para post (Instagram ou LinkedIn):
- Escreva o texto completo do post normalmente
- No FINAL da resposta, adicione um bloco de card assim:
  [[CARD: HEADLINE PRINCIPAL | subtext ou hook curto (opcional)]]
- Headline: frase de impacto em caixa alta, máx 40 caracteres
- Subtext: complemento curto e direto, máx 80 caracteres

Exemplo:
[[CARD: AUTOMATIZA OU FICA PRA TRÁS | O operacional que te diminui vira trabalho de máquina]]\n\n${text}`
        req('agent', {
          message: ctx,
          agentId: 'main',
          deliver: false,
          idempotencyKey: randomUUID()
        })
        return
      }

      if (step === 'injecting' && msg.payload?.status === 'accepted') {
        step = 'waiting'
        return
      }

      if (step === 'waiting' && msg.payload?.status === 'ok') {
        const responseText = msg.payload?.result?.payloads?.[0]?.text
        if (!responseText) return finish(null, { ok: true, noText: true })

        const { cleanText, card } = parseCoraResponse(responseText)
        app.log.info({ hasCard: !!card, headline: card?.headline }, 'parsed response')

        async function deliver() {
          if (card) {
            // Generate branded card PNG
            const pngBuf = generateCardPng(card.headline, card.subtext)
            const imgId  = randomUUID()
            imageCache.set(imgId, { buffer: pngBuf, createdAt: Date.now() })
            const imageUrl = `${BRIDGE_URL}/img/${imgId}`
            app.log.info({ imageUrl }, 'card generated')

            // Caption = post text (truncated to 900 chars for WhatsApp)
            const caption = cleanText.length > 900
              ? cleanText.substring(0, 897) + '…'
              : cleanText

            await sendImageViaZAPI(MARIANA_PHONE, imageUrl, caption)

            // If text was too long for caption, send the rest
            if (cleanText.length > 900) {
              await sendViaZAPI(MARIANA_PHONE, cleanText)
            }
          } else {
            await sendViaZAPI(MARIANA_PHONE, cleanText)
          }
        }

        deliver()
          .then(() => finish(null, { ok: true, delivered: true }))
          .catch(err => finish(new Error('Delivery failed: ' + err.message)))
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

  const isFromMe    = body.isFromMe === true || body.fromMe === true
  const isGroup     = body.isGroup  === true
  const text        = body.text?.message || body.message || body.body || ''
  const webhookType = body.type || ''

  app.log.info({ isFromMe, isGroup, text: text.substring(0, 80), webhookType, fromApi: body.fromApi }, 'webhook')

  if (webhookType === 'DeliveryCallback')  return reply.send({ ok: true, skipped: 'delivery' })
  if (body.fromApi === true)               return reply.send({ ok: true, skipped: 'api-echo' })
  if (isGroup)                             return reply.send({ ok: true, skipped: 'group' })
  if (!isFromMe)                           return reply.send({ ok: true, skipped: 'not-from-me' })
  if (!text)                               return reply.send({ ok: true, skipped: 'no-text' })

  try {
    const result = await injectToOpenClaw(text)
    return reply.send({ ok: true, result })
  } catch (err) {
    app.log.error({ err: err.message }, 'failed')
    return reply.status(500).send({ ok: false, error: err.message })
  }
})

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', async () => ({
  ok: true, service: 'cora-bridge', ts: new Date().toISOString()
}))

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10)
app.listen({ port: PORT, host: '0.0.0.0' }, err => {
  if (err) { app.log.error(err); process.exit(1) }
  app.log.info(`Cora Bridge running on port ${PORT}`)
})
