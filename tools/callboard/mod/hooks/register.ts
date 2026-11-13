// The hooks the mod registers, in the order the engine sees them: the bodies are in engine/, one area to a file.
// This file only wires: it decides nothing and holds no state.
import type { Register } from 'claude-code'
import * as c from './core.ts'
import { sessionEnd, promptCompose } from './engine/grants.ts'
import { leadVerbCall, laneCreateCall, laneOpenCall, laneUnparkCall, laneListCall, stopVerbCall, stopVerbFailed } from './engine/lanes.ts'
import { leadOpenCall } from './engine/lead-open.ts'
import { TOOL, requestCompactCall, turnComplete, promptSubmit, turnStart, postToolHook, postCompact } from './engine/compaction.ts'
import { sessionStart } from './engine/tick.ts'
import { commandRun } from './engine/commands.ts'
import { toolCheck, permissionRequest, doneHook } from './engine/answer-hook.ts'
import { promptListCall, promptAnswerCall, promptEscalateCall } from './engine/answer-tiers.ts'
import { usageMeasure } from './engine/usage.ts'

export const register: Register = (on) => {
  on('session.start', sessionStart).catch(($, e, next) => next(e))

  on('command.run', { command: 'callboard' }, ($, e) => commandRun($, e)).catch(() => ({ text: 'Callboard hit an error. Run /callboard status.' }))

  on('tool.call', { tool: `mcp__callboard__${TOOL}` }, requestCompactCall).catch(() => ({ deny: 'callboard: request_compact failed closed.' }))

  for (const verb of c.LEAD_VERBS) {
    on('tool.call', { tool: `mcp__callboard__lane_${verb}` }, ($, e, next) => leadVerbCall($, e, next, verb)).catch(() => ({ deny: `lane_${verb} failed closed.` }))
  }

  on('tool.call', { tool: 'mcp__callboard__lane_create' }, laneCreateCall).catch(() => ({ deny: 'lane_create failed closed.' }))

  on('tool.call', { tool: 'mcp__callboard__lane_open' }, laneOpenCall).catch(() => ({ deny: 'lane_open failed closed.' }))

  on('tool.call', { tool: 'mcp__callboard__lane_unpark' }, laneUnparkCall).catch(() => ({ deny: 'lane_unpark failed closed.' }))

  on('tool.call', { tool: 'mcp__callboard__lane_list' }, laneListCall).catch(() => ({ deny: 'lane_list failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__lead_open' }, leadOpenCall).catch(() => ({ deny: 'lead_open failed closed.' }))

  on('tool.call', { tool: 'mcp__callboard__prompt_list' }, promptListCall).catch(() => ({ deny: 'prompt_list failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__prompt_answer' }, promptAnswerCall).catch(() => ({ deny: 'prompt_answer failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__prompt_escalate' }, promptEscalateCall).catch(() => ({ deny: 'prompt_escalate failed closed.' }))

  for (const verb of c.STOP_VERBS) {
    on('tool.call', { tool: `mcp__callboard__lane_${verb}` }, ($, e, next) => stopVerbCall($, e, next, verb)).catch(($, e, next) => stopVerbFailed($, e, next, verb))
  }

  on('session.measure', usageMeasure).catch(($, e, next) => next(e))

  on('session.end', sessionEnd).catch(($, e, next) => next(e))

  on('turn.complete', turnComplete).catch(($, e, next) => next(e))

  on('prompt.compose', promptCompose).catch(($, e, next) => next(e))

  on('prompt.submit', promptSubmit).catch(($, e, next) => next(e))

  on('turn.start', turnStart).catch(($, e, next) => next(e))

  on('tool.check', toolCheck).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', permissionRequest).catch(($, e, next) => next(e))

  on('classic.PostToolUse', postToolHook).catch(($, e, next) => next(e))
  on('classic.PostToolUseFailure', postToolHook).catch(($, e, next) => next(e))
  on('classic.PermissionDenied', doneHook).catch(($, e, next) => next(e))

  on('classic.PostCompact', postCompact).catch(($, e, next) => next(e))
}
