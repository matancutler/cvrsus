/**
 * §4 — a retrieval aid, not an ontology.
 *
 * Three properties matter and everything here exists to serve them:
 *
 *   Multi-label     nothing forces a candidate down one branch. A person can be
 *                   fintech AND cybersecurity, data science AND engineering.
 *   Canonical       'MS Excel', 'Microsoft Excel' and 'excel' are one concept,
 *                   while the original wording is always kept alongside.
 *   Directional     breadth flows downward only. A candidate who says 'finance'
 *                   accepts credit and VC roles; one who says 'VC' has NOT
 *                   thereby accepted all of finance (§14).
 *
 * That last asymmetry is the whole reason this is a tree rather than a bag of
 * synonyms, and it is the difference between honouring a candidate's stated
 * intent and quietly overriding it.
 */
import { VERSIONS } from './config.js'

export const DIMENSIONS = ['industry', 'function', 'specialization', 'role']

/**
 * id, dimension, label, parent, aliases.
 *
 * Aliases are for wording, not meaning: put 'venture capital' next to 'vc'
 * here, but put 'credit analysis' under finance as its own child concept. If
 * two terms would match different job adverts, they are different concepts.
 */
const CONCEPTS = [
  // ------------------------------------------------------------ industries
  { id: 'finance', dimension: 'industry', label: 'Finance', aliases: ['financial services', 'financial'] },
  { id: 'banking', dimension: 'industry', label: 'Banking', parent: 'finance', aliases: ['retail banking', 'commercial banking', 'investment banking'] },
  { id: 'fintech', dimension: 'industry', label: 'Fintech', parent: 'finance', aliases: ['financial technology', 'payments', 'paytech'] },
  { id: 'venture-capital', dimension: 'industry', label: 'Venture Capital', parent: 'finance', aliases: ['vc', 'venture', 'private equity', 'pe', 'investment fund'] },
  { id: 'insurance', dimension: 'industry', label: 'Insurance', parent: 'finance', aliases: ['insurtech', 'underwriting industry'] },

  { id: 'technology', dimension: 'industry', label: 'Technology', aliases: ['tech', 'it', 'software industry'] },
  { id: 'saas', dimension: 'industry', label: 'SaaS', parent: 'technology', aliases: ['software as a service', 'b2b software', 'cloud software'] },
  { id: 'cybersecurity', dimension: 'industry', label: 'Cybersecurity', parent: 'technology', aliases: ['cyber', 'infosec', 'information security', 'security industry'] },
  { id: 'ai', dimension: 'industry', label: 'AI', parent: 'technology', aliases: ['artificial intelligence', 'machine learning industry', 'genai'] },
  { id: 'gaming', dimension: 'industry', label: 'Gaming', parent: 'technology', aliases: ['games', 'video games', 'gamedev'] },
  { id: 'telecom', dimension: 'industry', label: 'Telecom', parent: 'technology', aliases: ['telecommunications', 'networking industry'] },

  { id: 'healthcare', dimension: 'industry', label: 'Healthcare', aliases: ['health', 'medical', 'health care'] },
  { id: 'biotech', dimension: 'industry', label: 'Biotech', parent: 'healthcare', aliases: ['life sciences', 'pharma', 'pharmaceutical'] },
  { id: 'medtech', dimension: 'industry', label: 'Medical Devices', parent: 'healthcare', aliases: ['medical devices', 'medtech'] },

  { id: 'defence', dimension: 'industry', label: 'Defence', aliases: ['defense', 'military', 'aerospace and defence'] },
  { id: 'aerospace', dimension: 'industry', label: 'Aerospace', parent: 'defence', aliases: ['space', 'aviation'] },

  { id: 'retail', dimension: 'industry', label: 'Retail', aliases: ['e-commerce', 'ecommerce', 'consumer goods', 'fmcg'] },
  { id: 'fashion', dimension: 'industry', label: 'Fashion', parent: 'retail', aliases: ['apparel', 'luxury goods'] },
  { id: 'logistics', dimension: 'industry', label: 'Logistics', aliases: ['supply chain industry', 'shipping', 'freight'] },
  { id: 'manufacturing', dimension: 'industry', label: 'Manufacturing', aliases: ['industrial', 'production industry'] },
  { id: 'energy', dimension: 'industry', label: 'Energy', aliases: ['oil and gas', 'renewables', 'cleantech', 'utilities'] },
  { id: 'education', dimension: 'industry', label: 'Education', aliases: ['edtech', 'academia', 'higher education'] },
  { id: 'government', dimension: 'industry', label: 'Government', aliases: ['public sector', 'civil service', 'ngo', 'non-profit'] },
  { id: 'real-estate', dimension: 'industry', label: 'Real Estate', aliases: ['proptech', 'construction industry'] },
  { id: 'media', dimension: 'industry', label: 'Media', aliases: ['entertainment', 'publishing', 'advertising industry'] },
  { id: 'legal-industry', dimension: 'industry', label: 'Legal Services', aliases: ['law firm', 'legal services'] },

  // ------------------------------------------------------------- functions
  { id: 'engineering', dimension: 'function', label: 'Engineering', aliases: ['software engineering', 'development', 'r&d', 'rnd'] },
  { id: 'data', dimension: 'function', label: 'Data', aliases: ['data science', 'analytics', 'business intelligence'] },
  { id: 'product', dimension: 'function', label: 'Product', aliases: ['product management', 'product owner'] },
  { id: 'design', dimension: 'function', label: 'Design', aliases: ['ux', 'ui', 'user experience', 'creative'] },
  { id: 'sales', dimension: 'function', label: 'Sales', aliases: ['business development', 'bizdev', 'revenue', 'account management'] },
  { id: 'marketing', dimension: 'function', label: 'Marketing', aliases: ['growth', 'brand', 'communications', 'digital marketing'] },
  /*
   * Parented to the finance INDUSTRY on purpose, across dimensions.
   *
   * §4 calls the hierarchy non-exclusive and says relationships exist to help
   * retrieval, not to describe careers perfectly. A candidate who writes
   * "finance" means the field — they are not distinguishing the sector from the
   * job family, and treating those as unrelated roots would exclude them from
   * credit and accounting roles they plainly opted into.
   */
  { id: 'finance-function', dimension: 'function', label: 'Finance & Accounting', parent: 'finance', aliases: ['accounting', 'controlling', 'fp&a', 'treasury', 'audit'] },
  { id: 'operations', dimension: 'function', label: 'Operations', aliases: ['ops', 'supply chain', 'procurement', 'logistics operations'] },
  { id: 'hr', dimension: 'function', label: 'People & HR', aliases: ['human resources', 'people', 'talent acquisition', 'recruitment'] },
  { id: 'legal', dimension: 'function', label: 'Legal & Compliance', aliases: ['compliance', 'regulatory', 'counsel', 'risk and compliance'] },
  { id: 'customer', dimension: 'function', label: 'Customer Success & Support', aliases: ['customer success', 'support', 'account success'] },
  // Same cross-dimension reasoning as finance-function above.
  { id: 'security-function', dimension: 'function', label: 'Security', parent: 'cybersecurity', aliases: ['information security', 'security operations', 'soc'] },
  { id: 'research', dimension: 'function', label: 'Research', aliases: ['scientific research', 'academic research'] },

  // ------------------------------------------------------- specializations
  { id: 'machine-learning', dimension: 'specialization', label: 'Machine Learning', parent: 'data', aliases: ['ml', 'deep learning', 'neural networks', 'nlp', 'computer vision'] },
  { id: 'data-engineering', dimension: 'specialization', label: 'Data Engineering', parent: 'data', aliases: ['etl', 'data pipelines', 'data platform'] },
  { id: 'analytics', dimension: 'specialization', label: 'Analytics', parent: 'data', aliases: ['business analysis', 'reporting', 'bi'] },
  { id: 'backend', dimension: 'specialization', label: 'Backend', parent: 'engineering', aliases: ['server side', 'api development', 'microservices'] },
  { id: 'frontend', dimension: 'specialization', label: 'Frontend', parent: 'engineering', aliases: ['front end', 'web development', 'ui engineering'] },
  { id: 'mobile', dimension: 'specialization', label: 'Mobile', parent: 'engineering', aliases: ['ios', 'android', 'react native'] },
  { id: 'devops', dimension: 'specialization', label: 'DevOps & Infrastructure', parent: 'engineering', aliases: ['sre', 'platform engineering', 'infrastructure', 'cloud engineering'] },
  { id: 'embedded', dimension: 'specialization', label: 'Embedded', parent: 'engineering', aliases: ['firmware', 'hardware software', 'rtos'] },
  { id: 'qa', dimension: 'specialization', label: 'QA & Test', parent: 'engineering', aliases: ['quality assurance', 'test automation', 'sdet'] },
  { id: 'appsec', dimension: 'specialization', label: 'Application Security', parent: 'security-function', aliases: ['product security', 'secure development'] },
  { id: 'threat-intel', dimension: 'specialization', label: 'Threat Intelligence', parent: 'security-function', aliases: ['incident response', 'threat hunting', 'malware analysis'] },
  { id: 'credit-analysis', dimension: 'specialization', label: 'Credit Analysis', parent: 'finance-function', aliases: ['credit risk', 'underwriting', 'lending analysis'] },
  { id: 'financial-modelling', dimension: 'specialization', label: 'Financial Modelling', parent: 'finance-function', aliases: ['valuation', 'financial planning', 'modelling'] },
  { id: 'b2b-sales', dimension: 'specialization', label: 'B2B Sales', parent: 'sales', aliases: ['enterprise sales', 'saas sales', 'solution selling'] },
  { id: 'performance-marketing', dimension: 'specialization', label: 'Performance Marketing', parent: 'marketing', aliases: ['paid acquisition', 'ppc', 'seo', 'sem'] },
  { id: 'fraud-detection', dimension: 'specialization', label: 'Fraud Detection', parent: 'data', aliases: ['fraud', 'anti-fraud', 'aml', 'anti money laundering'] },
  { id: 'supply-chain', dimension: 'specialization', label: 'Supply Chain', parent: 'operations', aliases: ['procurement', 'inventory management', 'demand planning'] },
]

const BY_ID = new Map(CONCEPTS.map((c) => [c.id, c]))

/** label and every alias -> concept id. Built once; lookups are exact. */
const LOOKUP = new Map()
for (const concept of CONCEPTS) {
  const keys = [concept.id, concept.label, ...(concept.aliases ?? [])]
  for (const key of keys) {
    const norm = normalizeText(key)
    // First writer wins, so a concept's own label always beats another's alias.
    if (norm && !LOOKUP.has(norm)) LOOKUP.set(norm, concept.id)
  }
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[._/\\]+/g, ' ')
    .replace(/[^a-z0-9&+ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function getConcept(id) {
  return BY_ID.get(id) ?? null
}

export function allConcepts() {
  return CONCEPTS.map((c) => ({ id: c.id, dimension: c.dimension, label: c.label, parent: c.parent ?? null }))
}

/**
 * Free text -> a canonical concept, or null.
 *
 * Exact match first, then a contained-phrase pass so 'senior backend engineer'
 * still resolves. Single short words are not matched as substrings: 'ai' inside
 * 'chair' is the kind of false positive that quietly ruins a hard filter.
 */
export function resolveConcept(text) {
  const norm = normalizeText(text)
  if (!norm) return null

  const exact = LOOKUP.get(norm)
  if (exact) return BY_ID.get(exact)

  let best = null
  for (const [key, id] of LOOKUP) {
    if (key.length < 4 && key !== norm) continue
    const pattern = new RegExp(`(?:^| )${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$| )`)
    if (!pattern.test(norm)) continue
    // Longest key wins: 'venture capital' should beat a bare 'capital'.
    if (!best || key.length > best.key.length) best = { key, id }
  }

  return best ? BY_ID.get(best.id) : null
}

/** Every concept mentioned anywhere in a block of text, de-duplicated. */
export function conceptsInText(text, { limit = 24 } = {}) {
  const norm = normalizeText(text)
  if (!norm) return []

  const found = new Map()
  for (const [key, id] of LOOKUP) {
    if (key.length < 4) continue
    const pattern = new RegExp(`(?:^| )${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$| )`)
    if (pattern.test(norm) && !found.has(id)) found.set(id, BY_ID.get(id))
  }

  return [...found.values()].slice(0, limit)
}

/** A concept and everything beneath it. Used for breadth, never for narrowing. */
export function descendantIds(conceptId) {
  const out = new Set([conceptId])
  let grew = true
  while (grew) {
    grew = false
    for (const concept of CONCEPTS) {
      if (concept.parent && out.has(concept.parent) && !out.has(concept.id)) {
        out.add(concept.id)
        grew = true
      }
    }
  }
  return out
}

/**
 * Does a stated interest permit this role? (§5, §14)
 *
 * One-directional on purpose. 'finance' permits a credit-analysis role because
 * the candidate named the broader field. 'VC' does not permit a general banking
 * role, because they named the narrower one and we have no mandate to widen it.
 */
export function interestPermits(interestConceptId, roleConceptIds) {
  const permitted = descendantIds(interestConceptId)
  return roleConceptIds.some((id) => permitted.has(id))
}

/**
 * Overlap between two concept sets, credited for near misses.
 *
 * A shared parent counts for less than an exact hit rather than nothing at all:
 * a fintech candidate is genuinely relevant to a banking role, and scoring that
 * as zero is how a taxonomy starts throwing away good people.
 */
export function conceptSimilarity(a, b) {
  if (a.length === 0 || b.length === 0) return null

  const setB = new Set(b)
  let total = 0
  for (const id of a) {
    if (setB.has(id)) { total += 1; continue }
    const concept = BY_ID.get(id)
    const parent = concept?.parent
    if (parent && (setB.has(parent) || b.some((other) => BY_ID.get(other)?.parent === parent))) {
      total += 0.5
    }
  }

  return Math.min(1, total / Math.min(a.length, b.length))
}

export const TAXONOMY_VERSION = VERSIONS.taxonomy
