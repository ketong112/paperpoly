// PaperPoly — Polymarket paper trading on Even G2.
// Read: one market (question + Yes/No cents + probability bar + 24h volume).
//   Tap cycles the top-5 markets by volume.
// Write: long-press -> speak ("Yes, ten dollars") -> confirm screen ->
//   one tap places the paper bet. 10 s auto-cancel.
// Tap-only fallback: if voice is unheard/unparseable/mic fails, the confirm
//   screen shows a default YES $10 bet instead — tap still places it, timeout
//   still cancels. No voice is ever required to use the app.
// Backend: our own server on https://paperpoly.go.altare.global (Gamma + CLOB poll,
//   paper ledger, local Whisper STT). No keys, no real money, no login.
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  AudioInputSource,
} from '@evenrealities/even_hub_sdk'
import { parseCommand } from './parse'

const BACKEND = 'https://paperpoly.go.altare.global'
const CONFIRM_TIMEOUT_S = 10
const MARKET_REFRESH_MS = 45_000
const BAR_LEN = 19

interface Market {
  id: string
  question: string
  shortQuestion: string
  outcomes: [string, string]
  yesPrice: number
  noPrice: number
  yesCents: number
  noCents: number
  volume24h: number
}

type Screen =
  | { kind: 'loading' }
  | { kind: 'market' }
  | { kind: 'listening' }
  | { kind: 'thinking'; heard: string }
  | {
      kind: 'confirm'
      market: Market
      side: 'YES' | 'NO'
      amount: number
      price: number
      payout: number
      fallback: boolean
      remaining: number
    }
  | { kind: 'done'; text: string }
  | { kind: 'error'; text: string }

const bridge = await waitForEvenAppBridge()

const mainText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 1,
  containerName: 'main',
  content: 'PaperPoly\nLoading markets…',
  isEventCapture: 1,
})

const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [mainText],
  }),
)
console.log('Page created:', result === 0 ? 'success' : `failed (${result})`)

// Mirror the glasses screen in the companion webview (helps the demo video).
const companion = document.getElementById('app')
if (companion) companion.style.whiteSpace = 'pre-wrap'

// ---------------------------------------------------------------- state
let markets: Market[] = []
let marketIdx = 0
let balance = 1000
let betCount = 0
let screen: Screen = { kind: 'loading' }
let listening = false
let micFrames: Uint8Array[] = []
let micZeroFrames = 0
let micFailed = false
let confirmTimer: number | null = null

// ---------------------------------------------------------------- render
let lastRender = ''
let renderTimer: number | null = null

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

function wrapQuestion(q: string): string {
  const words = q.split(' ')
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > 46 && line) {
      lines.push(line.trim())
      line = w
    } else {
      line = line ? line + ' ' + w : w
    }
    if (lines.length === 2) break
  }
  if (lines.length < 2 && line) lines.push(line.trim())
  let out = lines.slice(0, 2).join('\n')
  if (lines.length === 2 && q.length > lines.join(' ').length + 1) out += '…'
  return out
}

function bar(yesPrice: number): string {
  const filled = Math.round(yesPrice * BAR_LEN)
  return '━'.repeat(filled) + '─'.repeat(BAR_LEN - filled)
}

function screenContent(s: Screen): string {
  switch (s.kind) {
    case 'loading':
      return 'PaperPoly\nLoading markets…'
    case 'market': {
      if (markets.length === 0) return 'PaperPoly\nNo markets yet.\nTap to retry.'
      const m = markets[marketIdx]
      return (
        `${wrapQuestion(m.shortQuestion)}\n` +
        `YES ${m.yesCents}¢ · NO ${m.noCents}¢  ${m.outcomes[0]} / ${m.outcomes[1]}\n` +
        `${bar(m.yesPrice)} ${m.yesCents}%\n` +
        `VOL ${formatVolume(m.volume24h)} · BAL $${balance} · ${marketIdx + 1}/5\n` +
        `Tap: next · Hold: speak`
      )
    }
    case 'listening':
      return 'Listening…\nSpeak now.\nRelease to send.'
    case 'thinking':
      return s.heard ? `Heard: "${s.heard}"\nWorking…` : 'Working…'
    case 'confirm': {
      const cents = Math.round(s.price * 100)
      const head = s.fallback ? 'Voice unclear — default:\n' : ''
      return (
        `${head}BUY ${s.side} ${s.amount}\n` +
        `@ ${cents}¢? WIN $${s.payout.toFixed(2)}\n` +
        `Tap: confirm · ${s.remaining}s`
      )
    }
    case 'done':
      return s.text
    case 'error':
      return `${s.text}\nTap to continue.`
  }
}

function renderNow() {
  const content = screenContent(screen)
  if (content === lastRender) return
  lastRender = content
  if (companion) companion.textContent = content
  void bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: 1, containerName: 'main', content }),
  )
}

function scheduleRender() {
  if (renderTimer !== null) return
  renderTimer = window.setTimeout(() => {
    renderTimer = null
    renderNow()
  }, 120) // debounce display writes — BLE render queue is slow
}

function setScreen(s: Screen) {
  if (confirmTimer !== null) {
    window.clearInterval(confirmTimer)
    confirmTimer = null
  }
  screen = s
  if (s.kind === 'confirm') {
    confirmTimer = window.setInterval(() => {
      if (screen.kind !== 'confirm') return
      screen.remaining -= 1
      if (screen.remaining <= 0) {
        console.log('confirm timeout — cancelled')
        setScreen({ kind: 'market' })
      } else {
        scheduleRender()
      }
    }, 1000)
  }
  scheduleRender()
}

// ---------------------------------------------------------------- backend
async function fetchJson(path: string, init?: RequestInit, timeoutMs = 8000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BACKEND}${path}`, init)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function loadMarkets() {
  try {
    const data = await fetchJson('/markets')
    if (Array.isArray(data.markets) && data.markets.length > 0) {
      markets = data.markets as Market[]
      if (marketIdx >= markets.length) marketIdx = 0
      console.log(`markets loaded: ${markets.length}`)
      if (screen.kind === 'loading') setScreen({ kind: 'market' })
      else scheduleRender()
    }
  } catch (err) {
    console.log('markets fetch failed:', (err as Error)?.message ?? err)
  }
}

async function loadPortfolio() {
  try {
    const data = await fetchJson('/portfolio')
    if (typeof data.balance === 'number') balance = data.balance
    if (Array.isArray(data.bets)) betCount = data.bets.length
    scheduleRender()
  } catch {
    /* balance stays at last known value */
  }
}

// ---------------------------------------------------------------- voice
function encodeWav(frames: Uint8Array[]): Blob {
  let total = 0
  for (const f of frames) total += f.length
  const pcm = new Uint8Array(total)
  let off = 0
  for (const f of frames) {
    pcm.set(f, off)
    off += f.length
  }
  const header = new ArrayBuffer(44)
  const v = new DataView(header)
  const writeStr = (pos: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(pos + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + total, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, 16000, true)
  v.setUint32(28, 32000, true) // byte rate
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  v.setUint32(40, total, true)
  return new Blob([header, pcm.buffer as ArrayBuffer], { type: 'audio/wav' })
}

function showConfirm(market: Market, side: 'YES' | 'NO', amount: number, fallback: boolean) {
  const price = side === 'YES' ? market.yesPrice : market.noPrice
  const payout = amount / price
  console.log(`confirm: ${side} ${amount} @ ${price} (fallback=${fallback})`)
  setScreen({ kind: 'confirm', market, side, amount, price, payout, fallback, remaining: CONFIRM_TIMEOUT_S })
}

async function finishVoice() {
  const market = markets[marketIdx]
  if (!market) {
    setScreen({ kind: 'market' })
    return
  }
  const totalBytes = micFrames.reduce((s, f) => s + f.length, 0)
  console.log(`voice: ${micFrames.length} frames, ${totalBytes} bytes, zeroFrames=${micZeroFrames}`)
  // Too short to hold speech (or mic never delivered) -> default bet.
  if (micFailed || totalBytes < 3200) {
    showConfirm(market, 'YES', 10, true)
    return
  }
  setScreen({ kind: 'thinking', heard: '' })
  try {
    const wav = encodeWav(micFrames)
    const data = await fetchJson(
      '/stt',
      { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav },
      65_000,
    )
    const heard = String(data.text || '').trim()
    console.log(`stt: ${JSON.stringify(heard)}`)
    setScreen({ kind: 'thinking', heard: heard || '(nothing heard)' })
    const parsed = parseCommand(heard)
    if (parsed) {
      showConfirm(market, parsed.side, parsed.amount, false)
    } else {
      showConfirm(market, 'YES', 10, true)
    }
  } catch (err) {
    console.log('stt failed:', (err as Error)?.message ?? err)
    showConfirm(market, 'YES', 10, true)
  }
}

async function placeBet() {
  if (screen.kind !== 'confirm') return
  const { market, side, amount } = screen
  try {
    const data = await fetchJson('/bet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketId: market.id, side, amount }),
    })
    balance = data.balance
    betCount += 1
    const bet = data.bet
    const cents = Math.round(bet.price * 100)
    console.log(`bet placed: ${bet.id} ${side} ${amount} @ ${cents}c`)
    setScreen({ kind: 'done', text: `Bet placed ✓\n${side} ${amount} @ ${cents}¢\nBAL $${balance}` })
    window.setTimeout(() => {
      if (screen.kind === 'done') setScreen({ kind: 'market' })
    }, 2500)
  } catch (err) {
    console.log('bet failed:', (err as Error)?.message ?? err)
    setScreen({ kind: 'error', text: 'Bet failed.\nCheck the server.' })
  }
}

// ---------------------------------------------------------------- events
// Reads the event type out of one envelope.
//
// CLICK_EVENT is 0, and protobuf omits zero-value fields on the wire, so a
// single tap arrives as an envelope whose `eventType` is `undefined`. The
// default has to be resolved INSIDE the envelope check. Writing
// `event.sysEvent?.eventType ?? OsEventTypeList.CLICK_EVENT` instead would
// read CLICK on events that carry no `sysEvent` at all, so every scroll,
// exit and audio frame would fire the tap handler.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  void bridge.audioControl(false)
  unsubscribe()
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  // Audio PCM frames arrive separately from gestures.
  const pcm = event.audioEvent?.audioPcm
  if (pcm && listening) {
    micFrames.push(pcm)
    let allZero = true
    for (let i = 0; i < pcm.length; i++) {
      if (pcm[i] !== 0) { allZero = false; break }
    }
    if (allZero) micZeroFrames += 1
    return
  }

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  // Double-tap -> system exit dialog (mode 1). Root-level check: it must
  // fire no matter which screen is showing, so users can always exit.
  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    cleanup()
    void bridge.shutDownPageContainer(1)
    return
  }

  // Long-press starts voice capture; release sends it for transcription.
  if (sysType === OsEventTypeList.LONG_PRESS_EVENT || textType === OsEventTypeList.LONG_PRESS_EVENT) {
    if (screen.kind === 'market' && markets.length > 0 && !listening) {
      listening = true
      micFrames = []
      micZeroFrames = 0
      micFailed = false
      void bridge.audioControl(true, AudioInputSource.Glasses).then(ok => {
        if (!ok) {
          micFailed = true
          console.log('audioControl(true) returned false')
        }
      })
      setScreen({ kind: 'listening' })
    }
    return
  }
  if (sysType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT || textType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) {
    if (listening) {
      listening = false
      void bridge.audioControl(false)
      void finishVoice()
    }
    return
  }

  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    if (screen.kind === 'market') {
      if (markets.length === 0) {
        void loadMarkets()
      } else {
        marketIdx = (marketIdx + 1) % markets.length
        scheduleRender()
      }
    } else if (screen.kind === 'confirm') {
      void placeBet()
    } else if (screen.kind === 'done' || screen.kind === 'error') {
      setScreen({ kind: 'market' })
    }
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)

// ---------------------------------------------------------------- boot
void loadMarkets()
void loadPortfolio()
window.setInterval(() => {
  if (!listening) void loadMarkets()
}, MARKET_REFRESH_MS)
renderNow()
