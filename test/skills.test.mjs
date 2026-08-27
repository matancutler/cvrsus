import { detectSkills, textHasSkill } from '../server/src/skills.js'
import { createReporter } from './helpers.mjs'

const { check, section, finish } = createReporter()

section('Case-sensitive boundary handling')
check('"WCAG" does not yield C', !detectSkills('Familiar with WCAG 2.1 AA').includes('C'))
check('"HR" does not yield R', !detectSkills('Worked closely with HR and PR teams').includes('R'))
check('"CRM" yields neither R nor C', (() => {
  const skills = detectSkills('Managed the CRM rollout')
  return !skills.includes('R') && !skills.includes('C')
})())
check('"Golang" still yields Go', detectSkills('Backend written in Golang').includes('Go'))
check('real "C" is still detected', detectSkills('Languages: C, Python, Rust').includes('C'))
check('real "R" is still detected', detectSkills('Statistics in R and SAS').includes('R'))
check('lowercase "go" verb does not yield Go', !detectSkills('willing to go the extra mile').includes('Go'))

section('Plus and hash boundaries')
check('"C++" does not also yield C', !detectSkills('Proficient in C++').includes('C'))
check('"C++" yields C++', detectSkills('Proficient in C++').includes('C++'))
check('"C#" yields C#', detectSkills('Built services in C#').includes('C#'))
check('"C#" does not also yield C', !detectSkills('Built services in C#').includes('C'))

section('Alias resolution')
check('"ReactJS" yields React', detectSkills('ReactJS developer').includes('React'))
check('"k8s" yields Kubernetes', detectSkills('Deployed on k8s').includes('Kubernetes'))
check('"postgres" yields PostgreSQL', detectSkills('postgres tuning').includes('PostgreSQL'))
check('no match inside a longer word', !detectSkills('nojavascriptx').includes('JavaScript'))

section('Custom (non-taxonomy) skills')
check('custom skill matches case-insensitively', textHasSkill('Experience with Contentful CMS', 'contentful'))
check('custom skill respects word boundaries', !textHasSkill('Contentfulness training', 'contentful'))

finish()
