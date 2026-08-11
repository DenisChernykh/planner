import type { RedisScriptDefinition } from '@/platform/redis/redis-script.runner'

export const CREATE_SESSION_SCRIPT: RedisScriptDefinition = Object.freeze({
  name: 'planner-auth-session-create-v1',
  source: `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1
`,
})

export const TOUCH_SESSION_SCRIPT: RedisScriptDefinition = Object.freeze({
  name: 'planner-auth-session-touch-v1',
  source: `
local payload = redis.call('GET', KEYS[1])
if not payload then return false end
local decoded_ok, decoded = pcall(cjson.decode, payload)
if not decoded_ok or type(decoded) ~= 'table' then
  redis.call('DEL', KEYS[1])
  return false
end
local now_ms = tonumber(ARGV[1])
local idle_ms = tonumber(ARGV[2])
local touch_ms = tonumber(ARGV[3])
local absolute_ms = tonumber(decoded.absoluteExpiresAtMs)
local last_seen_ms = tonumber(decoded.lastSeenAtMs)
if not absolute_ms or not last_seen_ms or absolute_ms <= now_ms or now_ms - last_seen_ms >= idle_ms then
  redis.call('DEL', KEYS[1])
  return false
end
if now_ms - last_seen_ms >= touch_ms then
  decoded.lastSeenAtMs = now_ms
  local ttl_ms = math.min(idle_ms, absolute_ms - now_ms)
  payload = cjson.encode(decoded)
  redis.call('SET', KEYS[1], payload, 'PX', ttl_ms)
end
return payload
`,
})

export const REVOKE_SESSION_SCRIPT: RedisScriptDefinition = Object.freeze({
  name: 'planner-auth-session-revoke-v1',
  source: `
local payload = redis.call('GET', KEYS[1])
if not payload then return 0 end
local decoded_ok, decoded = pcall(cjson.decode, payload)
if not decoded_ok or type(decoded) ~= 'table' then
  redis.call('DEL', KEYS[1])
  return 0
end
if decoded.userId ~= ARGV[1] or decoded.sessionId ~= ARGV[2] then return 0 end
return redis.call('DEL', KEYS[1])
`,
})

export const REDIS_SESSION_SCRIPTS = Object.freeze([
  CREATE_SESSION_SCRIPT,
  TOUCH_SESSION_SCRIPT,
  REVOKE_SESSION_SCRIPT,
])
