'use strict'
// Rules the extension's files share: the session id and lane name grammars and the pid check.
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/

// Whether a process answers a signal 0 (one owned by another user answers EPERM, and is alive).
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return !!err && err.code === 'EPERM'
  }
}

module.exports = { SID_RE, NAME_RE, pidAlive }
