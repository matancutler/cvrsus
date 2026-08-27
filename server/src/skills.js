/**
 * Canonical skill taxonomy.
 *
 * Each entry maps one canonical name to the ways it actually shows up in CVs.
 * `cased: true` means the alias only counts when the capitalisation matches --
 * needed for short words that are also ordinary English ("Go", "R", "Excel").
 */
export const SKILLS = [
  // --- Programming languages ---
  { name: 'JavaScript', category: 'Languages', aliases: ['javascript', 'js', 'es6', 'ecmascript'] },
  { name: 'TypeScript', category: 'Languages', aliases: ['typescript', 'ts'] },
  { name: 'Python', category: 'Languages', aliases: ['python', 'python3'] },
  { name: 'Java', category: 'Languages', aliases: ['java'] },
  { name: 'C#', category: 'Languages', aliases: ['c#', 'csharp', 'c sharp', '.net'] },
  { name: 'C++', category: 'Languages', aliases: ['c++', 'cpp'] },
  { name: 'C', category: 'Languages', aliases: ['C'], cased: true },
  { name: 'Go', category: 'Languages', aliases: ['Go', 'Golang', 'golang'], cased: true },
  { name: 'Rust', category: 'Languages', aliases: ['rust'] },
  { name: 'Ruby', category: 'Languages', aliases: ['ruby'] },
  { name: 'PHP', category: 'Languages', aliases: ['php'] },
  { name: 'Swift', category: 'Languages', aliases: ['swift'] },
  { name: 'Kotlin', category: 'Languages', aliases: ['kotlin'] },
  { name: 'Scala', category: 'Languages', aliases: ['scala'] },
  { name: 'R', category: 'Languages', aliases: ['R'], cased: true },
  { name: 'MATLAB', category: 'Languages', aliases: ['matlab'] },
  { name: 'Perl', category: 'Languages', aliases: ['perl'] },
  { name: 'Objective-C', category: 'Languages', aliases: ['objective-c', 'objective c'] },
  { name: 'Dart', category: 'Languages', aliases: ['dart'] },
  { name: 'Elixir', category: 'Languages', aliases: ['elixir'] },
  { name: 'Haskell', category: 'Languages', aliases: ['haskell'] },
  { name: 'Shell scripting', category: 'Languages', aliases: ['bash', 'shell scripting', 'zsh', 'powershell'] },

  // --- Frontend ---
  { name: 'React', category: 'Frontend', aliases: ['react', 'react.js', 'reactjs'] },
  { name: 'Vue', category: 'Frontend', aliases: ['vue', 'vue.js', 'vuejs'] },
  { name: 'Angular', category: 'Frontend', aliases: ['angular', 'angularjs'] },
  { name: 'Svelte', category: 'Frontend', aliases: ['svelte', 'sveltekit'] },
  { name: 'Next.js', category: 'Frontend', aliases: ['next.js', 'nextjs'] },
  { name: 'HTML', category: 'Frontend', aliases: ['html', 'html5'] },
  { name: 'CSS', category: 'Frontend', aliases: ['css', 'css3'] },
  { name: 'Sass', category: 'Frontend', aliases: ['sass', 'scss'] },
  { name: 'Tailwind CSS', category: 'Frontend', aliases: ['tailwind', 'tailwindcss'] },
  { name: 'Redux', category: 'Frontend', aliases: ['redux'] },
  { name: 'jQuery', category: 'Frontend', aliases: ['jquery'] },
  { name: 'Webpack', category: 'Frontend', aliases: ['webpack'] },
  { name: 'Vite', category: 'Frontend', aliases: ['vite'] },
  { name: 'Accessibility', category: 'Frontend', aliases: ['accessibility', 'a11y', 'wcag'] },

  // --- Backend & APIs ---
  { name: 'Node.js', category: 'Backend', aliases: ['node.js', 'nodejs', 'node js'] },
  { name: 'Express', category: 'Backend', aliases: ['express', 'express.js'] },
  { name: 'Django', category: 'Backend', aliases: ['django'] },
  { name: 'Flask', category: 'Backend', aliases: ['flask'] },
  { name: 'FastAPI', category: 'Backend', aliases: ['fastapi'] },
  { name: 'Spring', category: 'Backend', aliases: ['spring', 'spring boot', 'springboot'] },
  { name: 'Rails', category: 'Backend', aliases: ['rails', 'ruby on rails'] },
  { name: 'Laravel', category: 'Backend', aliases: ['laravel'] },
  { name: 'ASP.NET', category: 'Backend', aliases: ['asp.net', 'aspnet'] },
  { name: 'REST APIs', category: 'Backend', aliases: ['rest', 'rest api', 'restful', 'rest apis'] },
  { name: 'GraphQL', category: 'Backend', aliases: ['graphql'] },
  { name: 'gRPC', category: 'Backend', aliases: ['grpc'] },
  { name: 'Microservices', category: 'Backend', aliases: ['microservices', 'microservice'] },
  { name: 'WebSockets', category: 'Backend', aliases: ['websocket', 'websockets'] },

  // --- Databases ---
  { name: 'SQL', category: 'Data', aliases: ['sql'] },
  { name: 'PostgreSQL', category: 'Data', aliases: ['postgresql', 'postgres'] },
  { name: 'MySQL', category: 'Data', aliases: ['mysql', 'mariadb'] },
  { name: 'SQL Server', category: 'Data', aliases: ['sql server', 'mssql', 't-sql'] },
  { name: 'Oracle DB', category: 'Data', aliases: ['oracle db', 'oracle database', 'pl/sql'] },
  { name: 'MongoDB', category: 'Data', aliases: ['mongodb', 'mongo'] },
  { name: 'Redis', category: 'Data', aliases: ['redis'] },
  { name: 'Elasticsearch', category: 'Data', aliases: ['elasticsearch', 'opensearch'] },
  { name: 'SQLite', category: 'Data', aliases: ['sqlite'] },
  { name: 'DynamoDB', category: 'Data', aliases: ['dynamodb'] },
  { name: 'Cassandra', category: 'Data', aliases: ['cassandra'] },
  { name: 'Neo4j', category: 'Data', aliases: ['neo4j'] },

  // --- Data & analytics ---
  { name: 'Data Analysis', category: 'Data', aliases: ['data analysis', 'data analytics', 'data analyst'] },
  { name: 'Machine Learning', category: 'Data', aliases: ['machine learning', 'ml', 'deep learning'] },
  { name: 'Artificial Intelligence', category: 'Data', aliases: ['artificial intelligence', 'AI'], cased: true },
  { name: 'NLP', category: 'Data', aliases: ['nlp', 'natural language processing'] },
  { name: 'Computer Vision', category: 'Data', aliases: ['computer vision', 'opencv'] },
  { name: 'TensorFlow', category: 'Data', aliases: ['tensorflow', 'keras'] },
  { name: 'PyTorch', category: 'Data', aliases: ['pytorch'] },
  { name: 'scikit-learn', category: 'Data', aliases: ['scikit-learn', 'sklearn', 'scikit learn'] },
  { name: 'Pandas', category: 'Data', aliases: ['pandas'] },
  { name: 'NumPy', category: 'Data', aliases: ['numpy'] },
  { name: 'Spark', category: 'Data', aliases: ['spark', 'pyspark', 'apache spark'] },
  { name: 'Hadoop', category: 'Data', aliases: ['hadoop'] },
  { name: 'Airflow', category: 'Data', aliases: ['airflow'] },
  { name: 'dbt', category: 'Data', aliases: ['dbt'] },
  { name: 'Snowflake', category: 'Data', aliases: ['snowflake'] },
  { name: 'BigQuery', category: 'Data', aliases: ['bigquery'] },
  { name: 'Databricks', category: 'Data', aliases: ['databricks'] },
  { name: 'ETL', category: 'Data', aliases: ['etl', 'elt', 'data pipeline', 'data pipelines'] },
  { name: 'Tableau', category: 'Data', aliases: ['tableau'] },
  { name: 'Power BI', category: 'Data', aliases: ['power bi', 'powerbi'] },
  { name: 'Looker', category: 'Data', aliases: ['looker'] },
  { name: 'Statistics', category: 'Data', aliases: ['statistics', 'statistical analysis', 'biostatistics'] },
  { name: 'A/B Testing', category: 'Data', aliases: ['a/b testing', 'ab testing', 'experimentation'] },

  // --- Cloud & DevOps ---
  { name: 'AWS', category: 'Cloud', aliases: ['aws', 'amazon web services'] },
  { name: 'Azure', category: 'Cloud', aliases: ['azure', 'microsoft azure'] },
  { name: 'Google Cloud', category: 'Cloud', aliases: ['gcp', 'google cloud'] },
  { name: 'Docker', category: 'Cloud', aliases: ['docker', 'containerization'] },
  { name: 'Kubernetes', category: 'Cloud', aliases: ['kubernetes', 'k8s'] },
  { name: 'Terraform', category: 'Cloud', aliases: ['terraform'] },
  { name: 'Ansible', category: 'Cloud', aliases: ['ansible'] },
  { name: 'CI/CD', category: 'Cloud', aliases: ['ci/cd', 'cicd', 'continuous integration', 'continuous delivery'] },
  { name: 'Jenkins', category: 'Cloud', aliases: ['jenkins'] },
  { name: 'GitHub Actions', category: 'Cloud', aliases: ['github actions'] },
  { name: 'Linux', category: 'Cloud', aliases: ['linux', 'ubuntu', 'debian', 'centos', 'unix'] },
  { name: 'Nginx', category: 'Cloud', aliases: ['nginx', 'apache http'] },
  { name: 'Monitoring', category: 'Cloud', aliases: ['prometheus', 'grafana', 'datadog', 'observability'] },
  { name: 'Serverless', category: 'Cloud', aliases: ['serverless', 'lambda', 'aws lambda'] },

  // --- Engineering practice ---
  { name: 'Git', category: 'Engineering', aliases: ['git', 'github', 'gitlab', 'bitbucket', 'version control'] },
  { name: 'Testing', category: 'Engineering', aliases: ['unit testing', 'jest', 'pytest', 'junit', 'test automation', 'tdd'] },
  { name: 'Selenium', category: 'Engineering', aliases: ['selenium', 'cypress', 'playwright'] },
  { name: 'QA', category: 'Engineering', aliases: ['qa', 'quality assurance', 'manual testing'] },
  { name: 'System Design', category: 'Engineering', aliases: ['system design', 'software architecture', 'distributed systems'] },
  { name: 'Security', category: 'Engineering', aliases: ['cybersecurity', 'information security', 'infosec', 'penetration testing', 'appsec'] },
  { name: 'Agile', category: 'Engineering', aliases: ['agile', 'scrum', 'kanban', 'sprint planning'] },

  // --- Mobile ---
  { name: 'iOS', category: 'Mobile', aliases: ['ios', 'swiftui', 'uikit'] },
  { name: 'Android', category: 'Mobile', aliases: ['android', 'jetpack compose'] },
  { name: 'React Native', category: 'Mobile', aliases: ['react native'] },
  { name: 'Flutter', category: 'Mobile', aliases: ['flutter'] },

  // --- Design ---
  { name: 'UI Design', category: 'Design', aliases: ['ui design', 'user interface design', 'visual design'] },
  { name: 'UX Design', category: 'Design', aliases: ['ux', 'user experience', 'ux design'] },
  { name: 'Figma', category: 'Design', aliases: ['figma'] },
  { name: 'Adobe Creative Suite', category: 'Design', aliases: ['photoshop', 'illustrator', 'indesign', 'adobe creative'] },
  { name: 'Sketch', category: 'Design', aliases: ['sketch app'] },
  { name: 'Prototyping', category: 'Design', aliases: ['prototyping', 'wireframing', 'wireframes'] },
  { name: 'User Research', category: 'Design', aliases: ['user research', 'usability testing'] },
  { name: 'Motion Graphics', category: 'Design', aliases: ['motion graphics', 'after effects', 'animation'] },

  // --- Product & project ---
  { name: 'Product Management', category: 'Product', aliases: ['product management', 'product manager', 'product owner'] },
  { name: 'Project Management', category: 'Product', aliases: ['project management', 'project manager', 'pmp'] },
  { name: 'Roadmapping', category: 'Product', aliases: ['roadmap', 'roadmapping', 'product strategy'] },
  { name: 'Jira', category: 'Product', aliases: ['jira', 'confluence'] },
  { name: 'Asana', category: 'Product', aliases: ['asana', 'trello', 'monday.com', 'clickup'] },
  { name: 'Stakeholder Management', category: 'Product', aliases: ['stakeholder management', 'stakeholder engagement'] },
  { name: 'Requirements Gathering', category: 'Product', aliases: ['requirements gathering', 'business analysis', 'business analyst'] },

  // --- Marketing ---
  { name: 'Digital Marketing', category: 'Marketing', aliases: ['digital marketing', 'online marketing'] },
  { name: 'SEO', category: 'Marketing', aliases: ['seo', 'search engine optimization'] },
  { name: 'SEM', category: 'Marketing', aliases: ['sem', 'ppc', 'google ads', 'adwords'] },
  { name: 'Content Marketing', category: 'Marketing', aliases: ['content marketing', 'content strategy', 'copywriting'] },
  { name: 'Social Media', category: 'Marketing', aliases: ['social media', 'social media marketing'] },
  { name: 'Email Marketing', category: 'Marketing', aliases: ['email marketing', 'mailchimp', 'klaviyo'] },
  { name: 'Google Analytics', category: 'Marketing', aliases: ['google analytics', 'ga4'] },
  { name: 'Brand Management', category: 'Marketing', aliases: ['brand management', 'branding', 'brand strategy'] },
  { name: 'Marketing Automation', category: 'Marketing', aliases: ['marketing automation', 'hubspot', 'marketo'] },

  // --- Sales & customer ---
  { name: 'Sales', category: 'Sales', aliases: ['sales', 'b2b sales', 'inside sales'] },
  { name: 'Business Development', category: 'Sales', aliases: ['business development', 'bizdev', 'partnerships'] },
  { name: 'CRM', category: 'Sales', aliases: ['crm', 'salesforce', 'pipedrive'] },
  { name: 'Account Management', category: 'Sales', aliases: ['account management', 'account manager', 'key accounts'] },
  { name: 'Lead Generation', category: 'Sales', aliases: ['lead generation', 'prospecting', 'cold calling'] },
  { name: 'Negotiation', category: 'Sales', aliases: ['negotiation', 'contract negotiation'] },
  { name: 'Customer Success', category: 'Sales', aliases: ['customer success', 'customer support', 'client relations'] },

  // --- Finance & ops ---
  { name: 'Financial Analysis', category: 'Finance', aliases: ['financial analysis', 'financial modeling', 'fp&a'] },
  { name: 'Accounting', category: 'Finance', aliases: ['accounting', 'bookkeeping', 'general ledger'] },
  { name: 'Budgeting', category: 'Finance', aliases: ['budgeting', 'forecasting', 'cost control'] },
  { name: 'Auditing', category: 'Finance', aliases: ['auditing', 'internal audit', 'compliance audit'] },
  { name: 'Taxation', category: 'Finance', aliases: ['taxation', 'tax preparation', 'vat'] },
  { name: 'SAP', category: 'Finance', aliases: ['sap'] },
  { name: 'QuickBooks', category: 'Finance', aliases: ['quickbooks', 'xero'] },
  { name: 'ERP', category: 'Finance', aliases: ['erp', 'netsuite', 'oracle erp'] },
  { name: 'Supply Chain', category: 'Operations', aliases: ['supply chain', 'logistics', 'procurement'] },
  { name: 'Inventory Management', category: 'Operations', aliases: ['inventory management', 'warehouse management'] },
  { name: 'Lean Six Sigma', category: 'Operations', aliases: ['six sigma', 'lean manufacturing', 'lean'] },
  { name: 'Process Improvement', category: 'Operations', aliases: ['process improvement', 'process optimization'] },

  // --- HR & legal ---
  { name: 'Recruiting', category: 'HR', aliases: ['recruiting', 'recruitment', 'talent acquisition', 'sourcing'] },
  { name: 'Onboarding', category: 'HR', aliases: ['onboarding', 'employee onboarding'] },
  { name: 'Employee Relations', category: 'HR', aliases: ['employee relations', 'hr business partner', 'hrbp'] },
  { name: 'Payroll', category: 'HR', aliases: ['payroll', 'compensation and benefits', 'benefits administration'] },
  { name: 'Performance Management', category: 'HR', aliases: ['performance management', 'performance reviews'] },
  { name: 'Learning & Development', category: 'HR', aliases: ['learning and development', 'l&d', 'training and development'] },
  { name: 'Employment Law', category: 'Legal', aliases: ['employment law', 'labor law'] },
  { name: 'Contract Law', category: 'Legal', aliases: ['contract law', 'contract drafting', 'commercial contracts'] },
  { name: 'GDPR', category: 'Legal', aliases: ['gdpr', 'data protection', 'privacy compliance'] },

  // --- Healthcare & education ---
  { name: 'Patient Care', category: 'Healthcare', aliases: ['patient care', 'clinical care', 'bedside'] },
  { name: 'Nursing', category: 'Healthcare', aliases: ['nursing', 'registered nurse', 'rn'] },
  { name: 'Medical Coding', category: 'Healthcare', aliases: ['medical coding', 'icd-10', 'cpt coding'] },
  { name: 'Clinical Research', category: 'Healthcare', aliases: ['clinical research', 'clinical trials'] },
  { name: 'Teaching', category: 'Education', aliases: ['teaching', 'lecturing', 'instruction', 'curriculum development'] },

  // --- Office & general tools ---
  { name: 'Excel', category: 'Tools', aliases: ['Excel', 'Microsoft Excel', 'VLOOKUP', 'Pivot Tables'], cased: true },
  { name: 'PowerPoint', category: 'Tools', aliases: ['powerpoint', 'keynote'] },
  { name: 'Word', category: 'Tools', aliases: ['Microsoft Word', 'MS Word'], cased: true },
  { name: 'Google Workspace', category: 'Tools', aliases: ['google workspace', 'google sheets', 'g suite'] },
  { name: 'Notion', category: 'Tools', aliases: ['notion'] },
  { name: 'Slack', category: 'Tools', aliases: ['slack'] },
  { name: 'Salesforce Admin', category: 'Tools', aliases: ['salesforce admin', 'salesforce administrator'] },

  // --- Soft skills ---
  { name: 'Leadership', category: 'Soft skills', aliases: ['leadership', 'team lead', 'people management', 'line management'] },
  { name: 'Communication', category: 'Soft skills', aliases: ['communication skills', 'written communication', 'verbal communication'] },
  { name: 'Teamwork', category: 'Soft skills', aliases: ['teamwork', 'collaboration', 'cross-functional'] },
  { name: 'Problem Solving', category: 'Soft skills', aliases: ['problem solving', 'problem-solving', 'analytical thinking'] },
  { name: 'Mentoring', category: 'Soft skills', aliases: ['mentoring', 'coaching', 'mentorship'] },
  { name: 'Presentation', category: 'Soft skills', aliases: ['presentation skills', 'public speaking'] },
  { name: 'Time Management', category: 'Soft skills', aliases: ['time management', 'prioritization', 'multitasking'] },
  { name: 'Adaptability', category: 'Soft skills', aliases: ['adaptability', 'flexibility'] },

  // --- Spoken languages ---
  { name: 'English', category: 'Spoken languages', aliases: ['english'] },
  { name: 'Spanish', category: 'Spoken languages', aliases: ['spanish'] },
  { name: 'French', category: 'Spoken languages', aliases: ['french'] },
  { name: 'German', category: 'Spoken languages', aliases: ['german'] },
  { name: 'Mandarin', category: 'Spoken languages', aliases: ['mandarin', 'chinese'] },
  { name: 'Arabic', category: 'Spoken languages', aliases: ['arabic'] },
  { name: 'Hebrew', category: 'Spoken languages', aliases: ['hebrew'] },
  { name: 'Portuguese', category: 'Spoken languages', aliases: ['portuguese'] },
  { name: 'Russian', category: 'Spoken languages', aliases: ['russian'] },
  { name: 'Hindi', category: 'Spoken languages', aliases: ['hindi'] },
]

/**
 * The boundary class must list both cases explicitly: `cased` skills compile
 * without the `i` flag, and a lowercase-only class would let "C" match inside
 * "WCAG" or "R" inside "HR".
 *
 * `+` and `#` count as word characters so that "C++" does not also trigger the
 * "C" alias, and "C" does not trigger on "C++".
 */
const BOUNDARY = 'A-Za-z0-9+#'

function aliasPattern(alias, cased) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![${BOUNDARY}])${escaped}(?![${BOUNDARY}])`, cased ? '' : 'i')
}

/** Patterns are built once at load rather than per candidate. */
const COMPILED = SKILLS.map((skill) => ({
  ...skill,
  patterns: skill.aliases.map((alias) => aliasPattern(alias, skill.cased)),
}))

export const SKILL_NAMES = SKILLS.map((s) => s.name)

const BY_LOWER_NAME = new Map(SKILLS.map((s) => [s.name.toLowerCase(), s.name]))

/** Maps free text the recruiter typed onto a canonical name, when one exists. */
export function canonicalize(term) {
  const trimmed = String(term ?? '').trim()
  if (!trimmed) return null

  const exact = BY_LOWER_NAME.get(trimmed.toLowerCase())
  if (exact) return exact

  for (const skill of COMPILED) {
    if (skill.aliases.some((a) => a.toLowerCase() === trimmed.toLowerCase())) return skill.name
  }
  return trimmed
}

/** Returns the canonical names of every skill mentioned anywhere in `text`. */
export function detectSkills(text) {
  if (!text) return []
  const found = []
  for (const skill of COMPILED) {
    if (skill.patterns.some((p) => p.test(text))) found.push(skill.name)
  }
  return found
}

/** True when a candidate's CV text or self-declared skills cover `skillName`. */
export function textHasSkill(text, skillName) {
  const skill = COMPILED.find((s) => s.name === skillName)
  if (skill) return skill.patterns.some((p) => p.test(text))

  // Not in the taxonomy -- the recruiter typed something custom, so match it literally.
  return aliasPattern(skillName, false).test(text)
}

export function skillCategory(name) {
  return SKILLS.find((s) => s.name === name)?.category ?? 'Other'
}
