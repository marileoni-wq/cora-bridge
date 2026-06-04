import os, io, re, uuid, time
from datetime import datetime
from typing import Optional

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
import google.generativeai as genai
from PIL import Image, ImageDraw, ImageFont

app = FastAPI()

# ─── Config ───────────────────────────────────────────────────────────────────

GEMINI_KEY        = os.environ['GEMINI_API_KEY']
GEMINI_MODEL      = os.getenv('GEMINI_MODEL',    'gemini-1.5-flash')
MARIANA_PHONE     = os.environ['MARIANA_PHONE']
ZAPI_INSTANCE     = os.environ['ZAPI_INSTANCE']
ZAPI_TOKEN        = os.environ['ZAPI_TOKEN']
ZAPI_CLIENT_TOKEN = os.environ['ZAPI_CLIENT_TOKEN']
WEBHOOK_SECRET    = os.getenv('WEBHOOK_SECRET',  '')
BRIDGE_URL        = os.getenv('BRIDGE_URL',      'https://cora-bridge.onrender.com')

FONT_DIR  = os.path.join(os.path.dirname(__file__), 'fonts')
ZAPI_BASE = f'https://api.z-api.io/instances/{ZAPI_INSTANCE}/token/{ZAPI_TOKEN}'
ZAPI_HDR  = {'Content-Type': 'application/json', 'Client-Token': ZAPI_CLIENT_TOKEN}

# ─── Gemini ───────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """Você é Cora, Arquiteta de Conteúdo da FIRM Collective.
Está conversando com a Mariana, co-fundadora da FIRM, via WhatsApp. Responda de forma direta e natural.

## Identidade da FIRM Collective
Consultoria de engenharia operacional e arquitetura de receita B2B.
Produtos: Co-Piloto de Fechamento, DFO (Diagnóstico de Fricção Operacional).
Filosofia: WhatsApp é o CRM real. Automação serve o humano, não substitui.

## Tom de voz
SEMPRE: direta e profunda, contraste e paradoxo, conecta filosofia + comercial, humor seco, usa "a gente" e "você", faz afirmações não perguntas genéricas.
NUNCA: "Incrível!", "Fantástico!", jargões de autoajuda, começar com "Você sabia que...", mais de 2 emojis, CTA genérico ("curta e compartilhe").

## 3 Pilares de conteúdo
1. Engenharia de Receita — automação, operação comercial, funis B2B, processos de vendas
2. Mente que Constrói — filosofia estoica, Jung, Saju/BaZi, neuromarketing, psicologia do fundador
3. Bastidores da Construtora — erros reais, decisões difíceis, trajetória da FIRM

## Criação de posts
Quando criar post para Instagram ou LinkedIn:
- Escreva o texto completo do post normalmente
- No FINAL da resposta, adicione o bloco de card:
  [[CARD: HEADLINE EM CAIXA ALTA | subtext curto opcional]]
- Headline: frase de impacto, CAIXA ALTA, máx 40 caracteres
- Subtext: complemento direto, máx 80 caracteres (opcional)
- Exemplo: [[CARD: AUTOMATIZA OU FICA PRA TRÁS | O operacional que te diminui vira trabalho de máquina]]

## Regras absolutas
- NUNCA use travessões (—) como separadores em nenhuma parte do texto
- Responda sempre em português
- Nunca mencione erros técnicos ou limitações de sistema para a Mariana"""

genai.configure(api_key=GEMINI_KEY)
_model = genai.GenerativeModel(model_name=GEMINI_MODEL, system_instruction=SYSTEM_PROMPT)

# Conversation history (últimas 20 trocas)
_history: list = []

async def ask_cora(text: str) -> str:
    global _history
    chat    = _model.start_chat(history=_history[-40:])  # 20 pares user/model
    reply   = chat.send_message(text)
    _history.append({'role': 'user',  'parts': [text]})
    _history.append({'role': 'model', 'parts': [reply.text]})
    return reply.text

# ─── Card generator (Pillow) ──────────────────────────────────────────────────

def _split(text: str, max_chars: int) -> list[str]:
    words, lines, cur = text.split(), [], ''
    for w in words:
        test = (cur + ' ' + w).strip()
        if len(test) > max_chars:
            if cur: lines.append(cur)
            cur = w
        else:
            cur = test
    if cur: lines.append(cur)
    return lines

def _font(name: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(os.path.join(FONT_DIR, name), size)
    except Exception:
        return ImageFont.load_default()

def generate_card(headline: str, subtext: Optional[str] = None) -> bytes:
    W, H, PAD = 1080, 1080, 72
    NAVY = (12, 24, 40, 255)

    base = Image.new('RGBA', (W, H), NAVY)

    # Grid overlay
    grid = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd   = ImageDraw.Draw(grid)
    for x in range(0, W + 54, 54):
        gd.line([(x, 0), (x, H)], fill=(255, 255, 255, 31), width=1)
    for y in range(0, H + 54, 54):
        gd.line([(0, y), (W, y)], fill=(255, 255, 255, 31), width=1)
    base = Image.alpha_composite(base, grid)
    d    = ImageDraw.Draw(base)

    # Fonts
    f_bold_82  = _font('Inter-Bold.ttf',    82)
    f_bold_68  = _font('Inter-Bold.ttf',    68)
    f_bold_22  = _font('Inter-Bold.ttf',    22)
    f_reg_34   = _font('Inter-Regular.ttf', 34)
    f_reg_22   = _font('Inter-Regular.ttf', 22)
    f_reg_18   = _font('Inter-Regular.ttf', 18)
    f_reg_13   = _font('Inter-Regular.ttf', 13)
    f_reg_12   = _font('Inter-Regular.ttf', 12)

    W35  = (255, 255, 255, 89)   # 35% white
    W45  = (255, 255, 255, 114)  # 45% white
    W40  = (255, 255, 255, 102)  # 40% white
    W90  = (255, 255, 255, 229)  # 90% white
    FULL = (255, 255, 255, 255)
    GRAY = (136, 153, 170, 255)  # #8899AA

    # Corner marks
    d.text((46, 42),       '+', font=f_reg_18, fill=W35)
    d.text((W - 58, 42),   '+', font=f_reg_18, fill=W35)
    d.text((46, H - 52),   '+', font=f_reg_18, fill=W35)
    d.text((W - 58, H-52), '+', font=f_reg_18, fill=W35)

    # Top meta
    d.text((PAD, 78), '• FRM · 001', font=f_reg_13, fill=W45)
    meta_r = 'INSTAGRAM · POST'
    bx     = d.textbbox((0, 0), meta_r, font=f_reg_12)
    d.text((W - PAD - (bx[2] - bx[0]), 78), meta_r, font=f_reg_12, fill=W35)

    # Headline
    head_lines = _split(headline, 22)
    head_fs    = 82 if len(head_lines) <= 2 else 68
    head_font  = f_bold_82 if head_fs == 82 else f_bold_68
    head_lh    = int(head_fs * 1.22)
    head_y     = 240
    for i, line in enumerate(head_lines):
        d.text((PAD, head_y + i * head_lh), line, font=head_font, fill=FULL)

    # Subtext
    if subtext:
        body_y     = head_y + len(head_lines) * head_lh + 52
        body_lines = _split(subtext, 42)
        body_lh    = int(34 * 1.65)
        for i, line in enumerate(body_lines):
            d.text((PAD, body_y + i * body_lh), line, font=f_reg_34, fill=GRAY)

    # Footer
    d.text((PAD,       H - 66), 'Firm',       font=f_bold_22, fill=W90)
    d.text((PAD + 62,  H - 66), 'Collective', font=f_reg_22,  fill=W90)
    at   = '@FIRMCOLLECTIVE'
    abx  = d.textbbox((0, 0), at, font=f_reg_12)
    d.text((W - PAD - (abx[2] - abx[0]), H - 66), at, font=f_reg_12, fill=W40)

    buf = io.BytesIO()
    base.convert('RGB').save(buf, format='PNG', optimize=True)
    return buf.getvalue()

# ─── Parse [[CARD:]] ──────────────────────────────────────────────────────────

def parse_card(raw: str):
    m = re.search(r'\[\[CARD:\s*([^|\]]+?)(?:\s*\|\s*([\s\S]*?))?\]\]', raw, re.IGNORECASE)
    if not m:
        return raw.strip(), None, None
    headline  = m.group(1).strip()
    subtext   = m.group(2).strip() if m.group(2) else None
    clean     = re.sub(r'\[\[CARD:[\s\S]*?\]\]', '', raw, flags=re.IGNORECASE).strip()
    return clean, headline, subtext

# ─── In-memory image cache (10 min TTL) ───────────────────────────────────────

_cache: dict = {}

def _evict():
    cutoff = time.time() - 600
    for k in list(_cache):
        if _cache[k]['ts'] < cutoff:
            del _cache[k]

# ─── Z-API ────────────────────────────────────────────────────────────────────

async def send_text(phone: str, msg: str):
    async with httpx.AsyncClient(timeout=30) as c:
        await c.post(f'{ZAPI_BASE}/send-text', headers=ZAPI_HDR,
                     json={'phone': phone, 'message': msg})

async def send_image(phone: str, url: str, caption: str = ''):
    async with httpx.AsyncClient(timeout=30) as c:
        await c.post(f'{ZAPI_BASE}/send-image', headers=ZAPI_HDR,
                     json={'phone': phone, 'image': url, 'caption': caption})

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get('/img/{img_id}')
async def serve_img(img_id: str):
    _evict()
    entry = _cache.get(img_id)
    if not entry:
        return JSONResponse({'error': 'not found'}, status_code=404)
    return Response(content=entry['data'], media_type='image/png')


@app.post('/webhook/zapi')
async def webhook(request: Request):
    body = await request.json()

    if WEBHOOK_SECRET and request.headers.get('x-webhook-secret') != WEBHOOK_SECRET:
        return JSONResponse({'error': 'unauthorized'}, status_code=401)

    is_from_me = body.get('isFromMe') or body.get('fromMe')
    is_group   = body.get('isGroup', False)
    from_api   = body.get('fromApi', False)
    text       = (body.get('text') or {}).get('message') \
              or body.get('message') or body.get('body') or ''
    wh_type    = body.get('type', '')

    if wh_type == 'DeliveryCallback': return JSONResponse({'ok': True, 'skipped': 'delivery'})
    if from_api:                       return JSONResponse({'ok': True, 'skipped': 'api-echo'})
    if is_group:                       return JSONResponse({'ok': True, 'skipped': 'group'})
    if not is_from_me:                 return JSONResponse({'ok': True, 'skipped': 'not-from-me'})
    if not text:                       return JSONResponse({'ok': True, 'skipped': 'no-text'})

    try:
        reply                 = await ask_cora(text)
        clean, headline, sub  = parse_card(reply)

        if headline:
            png    = generate_card(headline, sub)
            img_id = str(uuid.uuid4())
            _cache[img_id] = {'data': png, 'ts': time.time()}
            img_url = f'{BRIDGE_URL}/img/{img_id}'
            caption = clean[:900] + '…' if len(clean) > 900 else clean
            await send_image(MARIANA_PHONE, img_url, caption)
            if len(clean) > 900:
                await send_text(MARIANA_PHONE, clean)
        else:
            await send_text(MARIANA_PHONE, clean)

        return JSONResponse({'ok': True})

    except Exception as e:
        return JSONResponse({'ok': False, 'error': str(e)}, status_code=500)


@app.get('/health')
async def health():
    return {'ok': True, 'service': 'cora-bridge-py',
            'model': GEMINI_MODEL, 'ts': datetime.utcnow().isoformat()}
