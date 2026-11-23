// Voice command parser for PaperPoly — pure functions, no SDK dependency.
//
//   "Yes, ten dollars"        -> { side: "YES", amount: 10 }
//   "no twenty dollars"       -> { side: "NO",  amount: 20 }
//   "buy yes 5"               -> { side: "YES", amount: 5 }
//   "yes $100"                -> { side: "YES", amount: 100 }
//   "twenty five dollars on no" -> { side: "NO", amount: 25 }
//
// Rules:
//   - Side comes from the words "yes"/"no" (first one wins). No side word
//     defaults to YES — the confirm screen always shows the side, and a tap
//     can still cancel, so a wrong default costs nothing.
//   - Amount comes from digits first ("10", "$10", "10.5"), otherwise from
//     number words (one..nineteen, twenty..ninety, hundred, thousand).
//   - Valid amounts are 1..1000. Anything else (no amount, amount out of
//     range) returns null and the caller falls back to the default bet.

export type Side = 'YES' | 'NO'

export interface ParsedCommand {
  side: Side
  amount: number
}

const ONES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}

const NUMBER_WORDS = new Set([
  ...Object.keys(ONES), ...Object.keys(TENS), 'hundred', 'thousand', 'a', 'an',
])

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9$.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse a run of number words ("twenty five", "one hundred", "a thousand"). */
export function parseNumberWords(words: string[]): number | null {
  let total = 0
  let current = 0
  let seen = false
  for (const w of words) {
    if (w === 'a' || w === 'an') {
      current += 1
      seen = true
    } else if (w in ONES) {
      current += ONES[w]
      seen = true
    } else if (w in TENS) {
      current += TENS[w]
      seen = true
    } else if (w === 'hundred') {
      current = (current === 0 ? 1 : current) * 100
      seen = true
    } else if (w === 'thousand') {
      total += (current === 0 ? 1 : current) * 1000
      current = 0
      seen = true
    } else {
      return null
    }
  }
  if (!seen) return null
  return total + current
}

export function parseCommand(text: string): ParsedCommand | null {
  const clean = normalize(text)
  if (!clean) return null
  const tokens = clean.split(' ')

  // Side: first "yes"/"no" wins; default YES.
  let side: Side = 'YES'
  for (const t of tokens) {
    if (t === 'yes') { side = 'YES'; break }
    if (t === 'no') { side = 'NO'; break }
  }

  // Amount: digits first.
  const digitMatch = clean.match(/\$?\s*(\d+(?:\.\d+)?)/)
  let amount: number | null = null
  if (digitMatch) {
    amount = Number(digitMatch[1])
  } else {
    // Amount: longest run of number words.
    let best: number | null = null
    let run: string[] = []
    const flush = () => {
      if (run.length > 0) {
        const v = parseNumberWords(run)
        if (v !== null && (best === null || v > best)) best = v
        run = []
      }
    }
    for (const t of tokens) {
      if (NUMBER_WORDS.has(t)) run.push(t)
      else flush()
    }
    flush()
    amount = best
  }

  if (amount === null || !Number.isFinite(amount)) return null
  amount = Math.round(amount * 100) / 100
  if (amount < 1 || amount > 1000) return null
  return { side, amount }
}
