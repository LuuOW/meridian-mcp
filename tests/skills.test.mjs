import { test } from 'node:test'
import assert from 'node:assert'

// Skip these if the skills directory isn't present (CI environment)
import { existsSync } from 'node:fs'
const HAS_SKILLS = existsSync(process.env.MERIDIAN_SKILLS_ROOT || '/opt/skills')

const { listSkillsFromDisk, getSkill } = await import('../src/skills.mjs')

test('listSkillsFromDisk returns an array', { skip: !HAS_SKILLS }, () => {
  const skills = listSkillsFromDisk()
  assert.ok(Array.isArray(skills))
  assert.ok(skills.length > 0, 'expected at least one skill')
})

test('getSkill rejects invalid slug', () => {
  assert.throws(() => getSkill('../etc/passwd'), /invalid skill slug/)
  assert.throws(() => getSkill('has spaces'),    /invalid skill slug/)
})
