const Fastify = require('fastify')
const { WebSocket } = require('ws')
const { randomUUID } = require('crypto')
const { Resvg } = require('@resvg/resvg-js')
const path = require('path')

const app = Fastify({ logger: true })

const FONT_DIR = path.join(__dirname, 'fonts')

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
  const W = 1080, H = 1080, PAD = 72

  const headLines = splitLines(headline, 22)
  const headFS    = headLines.length <= 2 ? 82 : 68
  const headLH    = headFS * 1.22
  const headY     = 240

  const bodyLines = subtext ? splitLines(subtext, 42) : []
  const bodyFS    = 34
  const bodyLH    = bodyFS * 1.65
  const bodyY     = headY + headLines.length * headLH + 52

  const headSVG = headLines.map((l, i) =>
    `<text x="${PAD}" y="${headY + i * headLH}"
      font-family="Inter" font-size="${headFS}" font-weight="700"
      fill="#FFFFFF" letter-spacing="-0.5">${esc(l)}</text>`
  ).join('\n  ')

  const bodySVG = bodyLines.map((l, i) =>
    `<text x="${PAD}" y="${bodyY + i * bodyLH}"
      font-family="Inter" font-size="${bodyFS}" font-weight="400"
      fill="#8899AA" letter-spacing="0">${esc(l)}</text>`
  ).join('\n  ')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <pattern id="grid" width="54" height="54" patternUnits="userSpaceOnUse">
      <path d="M 54 0 L 0 0 0 54" fill="none" stroke="#FFFFFF" stroke-width="0.5" opacity="0.12"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="#0C1828"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>

  <!-- Corner marks -->
  <text x="46" y="60" font-family="Inter" font-size="18" font-weight="400" fill="#FFFFFF" opacity="0.35">+</text>
  <text x="${W - 58}" y="60" font-family="Inter" font-size="18" font-weight="400" fill="#FFFFFF" opacity="0.35">+</text>
  <text x="46" y="${H - 34}" font-family="Inter" font-size="18" font-weight="400" fill="#FFFFFF" opacity="0.35">+</text>
  <text x="${W - 58}" y="${H - 34}" font-family="Inter" font-size="18" font-weight="400" fill="#FFFFFF" opacity="0.35">+</text>

  <!-- Top meta -->
  <text x="${PAD}" y="96"
    font-family="Inter" font-size="13" font-weight="400"
    fill="#FFFFFF" opacity="0.45" letter-spacing="2">• FRM · 001</text>
  <text x="${W - PAD}" y="96" text-anchor="end"
    font-family="Inter" font-size="12" font-weight="400"
    fill="#FFFFFF" opacity="0.35" letter-spacing="2">INSTAGRAM · POST</text>

  <!-- Headline -->
  ${headSVG}

  <!-- Body (no divider) -->
  ${bodySVG}

  <!-- Footer -->
  <text x="${PAD}" y="${H - 48}"
    font-family="Inter" font-size="22" font-weight="700"
    fill="#FFFFFF" opacity="0.9">Firm</text>
  <text x="${PAD + 62}" y="${H - 48}"
    font-family="Inter" font-size="22" font-weight="400"
    fill="#FFFFFF" opacity="0.9">Collective</text>
  <text x="${W - PAD}" y="${H - 48}" text-anchor="end"
    font-family="Inter" font-size="12" font-weight="400"
    fill="#FFFFFF" opacity="0.4" letter-spacing="3">@FIRMCOLLECTIVE</text>
</svg>`
}

function generateCardPng(headline, subtext) {
  const svg = buildCardSVG(headline, subtext)
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [
        path.join(FONT_DIR, 'Inter-Bold.ttf'),
        path.join(FONT_DIR, 'Inter-Regular.ttf')
      ],
      loadSystemFonts: false,
      defaultFontFamily: 'Inter'
    }
  })
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
NUNCA use travessões (—) como separadores em nenhuma parte do texto ou card.

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
