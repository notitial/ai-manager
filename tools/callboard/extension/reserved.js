'use strict'
// Reserved lane names, matched by skeleton as the mod does (mod/hooks/core.ts reservedHit): upper case, no - or _, no
// trailing digits, look-alike digits read as letters (1 is I or L). MANAGER_, MANAGER-2 and MANAG3R are reserved.
// v15.1: the built-in list only. Names a machine reserves with /callboard reserve live in the mod's store; the mod refuses them for every new
// lane record it writes and refuses to reserve a name a record carries, so such a record is rare (a root lanes.json entry, or one written in the
// moment of a reserve); the extension does not protect it.
const RESERVED = ['MANAGER']

const FOLD = { L: 'I', 1: 'I', 0: 'O', 5: 'S', 3: 'E', 4: 'A', 8: 'B', 7: 'T', 6: 'G', 9: 'G', 2: 'Z' }
function skeletons(name) {
  const base = String(name).toLowerCase().replace(/rn/g, 'm').replace(/vv/g, 'w').toUpperCase().replace(/[-_]/g, '')
  const out = new Set()
  for (const v of [base, base.replace(/[0-9]+$/, '')]) out.add(v.replace(/[L0-9]/g, (ch) => FOLD[ch] ?? ch))
  return [...out]
}

function reservedHit(name) {
  const bad = RESERVED.flatMap(skeletons)
  return RESERVED.includes(String(name).toUpperCase()) || skeletons(name).some((k) => bad.includes(k))
}

// A folder too broad to hold lead-made lanes (same rules as the mod's pinRefusal).
const BROAD_HOME = ['Documents', 'Desktop', 'Downloads', 'Library', 'Public', 'Movies', 'Music', 'Pictures', 'Applications']
function pinRefusal(pin, home) {
  if (typeof pin !== 'string' || !/^\/[\x21-\x7e]*$/.test(pin) || pin.split('/').some((s) => s === '..' || s === '.') || pin.includes('//')) return 'pin-path'
  if (pin === '/') return 'pin-broad'
  const parts = pin.split('/').filter(Boolean)
  if (parts.length < 3) return 'pin-broad'
  if (['tmp', 'var', 'private', 'Volumes', 'etc', 'usr', 'opt', 'bin', 'sbin', 'System', 'Library', 'Applications'].includes(parts[0]) && parts.length < 4) return 'pin-broad'
  if (pin === home || (pin.startsWith(`${home}/`) && (BROAD_HOME.includes(pin.slice(home.length + 1)) || pin.startsWith(`${home}/Library/`)))) return 'pin-broad'
  return undefined
}

module.exports = { RESERVED, reservedHit, pinRefusal }
