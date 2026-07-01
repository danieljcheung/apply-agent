import type { ProfileBundle, ProjectEntry, AnswerMemory } from './types.js';
import { KAMI_RESUME_TEMPLATE } from './kamiResumeTemplate.js';

export type KamiResumeRenderOptions = {
  jobRequirements?: string[];
  evidenceMap?: Record<string, string[]>;
  unsupported?: string[];
  resumeId?: string | null;
  applicationTitle?: string | null;
  company?: string | null;
};

export function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderKamiResumeHtml(profile: ProfileBundle, options?: KamiResumeRenderOptions): string {
  const candidate = profile.candidateProfile || {
    name: '',
    email: '',
    phone: '',
    skills: [],
    experience: [],
    education: []
  };

  const name = candidate.name || 'Candidate Profile';
  const escapedName = escapeHtml(name);

  // 1. Extract and fill head metadata. Search for </head> instead of <body> because
  // the Kami CSS intentionally mentions `<body>` in a comment for dense variants.
  const headEndIdx = KAMI_RESUME_TEMPLATE.indexOf('</head>');
  if (headEndIdx === -1) {
    throw new Error('Could not find </head> in Kami template');
  }
  let headPart = KAMI_RESUME_TEMPLATE.substring(0, headEndIdx + '</head>'.length);
  // Replace title, author, description, keywords
  const skillsList = (candidate.skills || []).join(', ');
  headPart = headPart
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapedName} · Resume</title>`)
    .replace(/meta name="author" content="\{\{NAME\}\}"/g, `meta name="author" content="${escapedName}"`)
    .replace(/meta name="description" content="\{\{DESCRIPTION\}\}"/g, `meta name="description" content="${escapeHtml('Resume of ' + name)}"`)
    .replace(/meta name="keywords" content="\{\{KEYWORDS\}\}"/g, `meta name="keywords" content="${escapeHtml(skillsList)}"`);

  // Ensure generator remains Kami and has no other {{...}} in head
  headPart = headPart.replace(/\{\{[^}]*\}\}/g, '');

  const memory: AnswerMemory = profile.answerMemory || {};
  const getMemoryVal = (k: string): string => {
    const val = memory[k] || memory[k.toLowerCase()] || memory[k.charAt(0).toUpperCase() + k.slice(1)];
    if (typeof val === 'string') {
      return val;
    }
    if (val && typeof val === 'object' && 'answer' in val && typeof val.answer === 'string') {
      return val.answer;
    }
    return '';
  };

  const roleTitle = options?.applicationTitle || getMemoryVal('targetTitle') || 'Candidate Profile';
  const escapedRoleTitle = escapeHtml(roleTitle);

  let website = '';
  if (candidate && typeof candidate === 'object' && 'website' in candidate) {
    const candidateWebsite = candidate.website;
    if (typeof candidateWebsite === 'string') {
      website = candidateWebsite;
    }
  }
  if (!website) {
    website = getMemoryVal('website');
  }

  let github = '';
  if (candidate && typeof candidate === 'object' && 'github' in candidate) {
    const candidateGithub = candidate.github;
    if (typeof candidateGithub === 'string') {
      github = candidateGithub;
    }
  }
  if (!github) {
    github = getMemoryVal('github');
  }

  const email = candidate.email || getMemoryVal('email') || '';
  const phone = candidate.phone || getMemoryVal('phone') || '';

  let location = '';
  if (candidate && typeof candidate === 'object' && 'location' in candidate) {
    const candidateLocation = candidate.location;
    if (typeof candidateLocation === 'string') {
      location = candidateLocation;
    }
  }
  if (!location) {
    location = getMemoryVal('location');
  }

  const contacts: string[] = [];
  if (website) {
    const href = website.startsWith('http') ? website : `https://${website}`;
    const display = website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    contacts.push(`<a href="${escapeHtml(href)}">${escapeHtml(display)}</a>`);
  }
  if (github) {
    let href = github;
    let display = github;
    if (!github.includes('github.com')) {
      href = `https://github.com/${github}`;
      display = `github.com/${github}`;
    } else {
      href = github.startsWith('http') ? github : `https://${github}`;
      display = github.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    }
    contacts.push(`<a href="${escapeHtml(href)}">${escapeHtml(display)}</a>`);
  }
  if (email) {
    contacts.push(`<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`);
  }
  if (phone) {
    contacts.push(`<span class="phone">${escapeHtml(phone)}</span>`);
  }
  const contactRowHtml = contacts.length > 0
    ? `    <div>${contacts.join('<span class="sep">·</span>')}</div>`
    : '';

  const locationHtml = location
    ? `    <div><span class="loc">${escapeHtml(location)}</span></div>`
    : '';

  let bodyHtml = `<body>
<div class="header">
  <div><div class="name serif">${escapedName}</div></div>
  <div class="contact">
    <div class="role">${escapedRoleTitle}</div>
    ${contactRowHtml}
    ${locationHtml}
  </div>
</div>
`;

  // 1. Education Section (first)
  if (candidate.education && candidate.education.length > 0) {
    bodyHtml += `<section>
  <div class="section-title">Education</div>
`;
    candidate.education.forEach(edu => {
      bodyHtml += `  <div class="edu-item">
    <div class="edu-head"><span class="school serif">${escapeHtml(edu.institution || 'Education')}</span><span class="major">${edu.details ? ' · ' + escapeHtml(edu.details) : ''}</span></div>
  </div>
`;
    });
    bodyHtml += `</section>\n`;
  }

  // 2. Summary Section (second)
  let summaryText = '';
  if (options?.applicationTitle && options?.company) {
    summaryText = `This resume has been tailored for the ${escapeHtml(options.applicationTitle)} position at ${escapeHtml(options.company)} using verified claims from the candidate's parsed resume history.`;
  } else if (options?.applicationTitle) {
    summaryText = `This resume has been tailored for the ${escapeHtml(options.applicationTitle)} position using verified claims from the candidate's parsed resume history.`;
  } else if (options?.company) {
    summaryText = `This resume has been tailored for a position at ${escapeHtml(options.company)} using verified claims from the candidate's parsed resume history.`;
  } else {
    summaryText = `This resume presents a professional summary built from the candidate's verified parsed resume claims.`;
  }

  bodyHtml += `<section>
  <div class="section-title">Summary</div>
  <div class="summary">
    ${summaryText}
  </div>
</section>
`;

  // 3. Technical Projects Section (third)
  const matchedClaimIds = new Set<string>();
  if (options?.evidenceMap) {
    Object.values(options.evidenceMap).forEach(ids => {
      if (Array.isArray(ids)) {
        ids.forEach(id => matchedClaimIds.add(id));
      }
    });
  }

  const projects: ProjectEntry[] = candidate.projects || [];
  if (projects.length > 0) {
    bodyHtml += `<section>
  <div class="section-title">Technical Projects</div>
`;
    projects.forEach((proj, idx) => {
      const matchedClaimsForThisProj = (profile.claimBank || []).filter(c => {
        const isProjCategory = c.category === 'project' || c.category === 'projects';
        const matchesProjId = proj.id && (c.id.includes(String(proj.id)) || c.id === String(proj.id));
        const matchesProjIndex = c.id.includes(`_proj_${idx}_`) || c.id.startsWith(`proj_${idx}_`) ||
                                 c.id.includes(`_project_${idx}_`) || c.id.startsWith(`project_${idx}_`);
        const isProjClaim = isProjCategory || matchesProjId || matchesProjIndex;
        return isProjClaim && matchedClaimIds.has(c.id);
      });

      const hasImpact = matchedClaimsForThisProj.length > 0;
      const impactText = hasImpact
        ? matchedClaimsForThisProj.map(c => escapeHtml(c.text)).join(' ')
        : '';

      const techRowHtml = proj.technologies && proj.technologies.length > 0
        ? `      <div class="proj-row">
        <div class="proj-label">Technologies</div>
        <div class="proj-text">${escapeHtml(Array.isArray(proj.technologies) ? proj.technologies.join(', ') : String(proj.technologies))}</div>
      </div>\n`
        : '';

      const impactRowHtml = hasImpact
        ? `      <div class="proj-row">
        <div class="proj-label">Impact</div>
        <div class="proj-text">${impactText}</div>
      </div>\n`
        : '';

      let kindText = '';
      if (proj && typeof proj === 'object' && 'kind' in proj) {
        const candidateKind = proj.kind;
        if (typeof candidateKind === 'string') {
          kindText = candidateKind;
        }
      }
      const kindHtml = kindText ? `<span class="proj-kind">· ${escapeHtml(kindText)}</span>` : '';
      const roleText = proj.role || proj.title || proj.name || 'Builder';
      const roleHtml = `<span class="proj-role">${escapeHtml(roleText)}</span>`;

      bodyHtml += `  <div class="project">
    <div class="proj-head">
      <span class="proj-name serif">${escapeHtml(proj.name || proj.title || 'Project')}</span>${kindHtml}${roleHtml}
    </div>
    <div class="proj-lines">
      <div class="proj-row">
        <div class="proj-label">Role</div>
        <div class="proj-text">${escapeHtml(proj.role || proj.title || proj.name || 'Project')}</div>
      </div>
      <div class="proj-row">
        <div class="proj-label">Actions</div>
        <div class="proj-text">${escapeHtml(proj.description || '')}</div>
      </div>
${techRowHtml}${impactRowHtml}    </div>
  </div>
`;
    });
    bodyHtml += `</section>\n`;
  }

  // 4. Experience Section (fourth)
  if (candidate.experience && candidate.experience.length > 0) {
    bodyHtml += `<section>
  <div class="section-title">Experience</div>
`;
    candidate.experience.forEach((exp, idx) => {
      const matchedClaimsForThisExp = (profile.claimBank || []).filter(c => {
        const isExp = c.category === 'experience' && (c.id.includes(`_exp_${idx}_`) || c.id.startsWith(`exp_${idx}_`));
        return isExp && matchedClaimIds.has(c.id);
      });

      const impactText = matchedClaimsForThisExp.length > 0
        ? matchedClaimsForThisExp.map(c => escapeHtml(c.text)).join(' ')
        : 'Evidence drawn from parsed resume text; no quantified result provided.';

      const expRoleText = exp.title || 'Experience';
      const expRoleHtml = `<span class="proj-role">${escapeHtml(expRoleText)}</span>`;

      let expKindText = '';
      if (exp && typeof exp === 'object' && 'kind' in exp) {
        const candidateKind = exp.kind;
        if (typeof candidateKind === 'string') {
          expKindText = candidateKind;
        }
      }
      const expKindHtml = expKindText ? `<span class="proj-kind">· ${escapeHtml(expKindText)}</span>` : '';

      bodyHtml += `  <div class="project">
    <div class="proj-head">
      <span class="proj-name serif">${escapeHtml(exp.company || 'Experience')}</span>${expKindHtml}${expRoleHtml}
    </div>
    <div class="proj-lines">
      <div class="proj-row">
        <div class="proj-label">Role</div>
        <div class="proj-text">${escapeHtml(exp.title || 'Experience')}</div>
      </div>
      <div class="proj-row">
        <div class="proj-label">Actions</div>
        <div class="proj-text">${escapeHtml((exp.description || '').slice(0, 240))}</div>
      </div>
      <div class="proj-row">
        <div class="proj-label">Impact</div>
        <div class="proj-text">${impactText}</div>
      </div>
    </div>
  </div>
`;
    });
    bodyHtml += `</section>\n`;
  }

  // 5. Technical Skills Section (fifth)
  if (candidate.skills && candidate.skills.length > 0) {
    bodyHtml += `<section>
  <div class="section-title">Technical Skills</div>
  <div class="summary">
    ${candidate.skills.map(s => escapeHtml(s)).join(', ')}
  </div>
</section>
`;
  }

  // 6. Certifications Section (sixth, optional)
  const certificationsVal = getMemoryVal('certifications') || getMemoryVal('Certifications') || '';
  if (certificationsVal) {
    bodyHtml += `<section>
  <div class="section-title">Certifications</div>
  <div class="summary">${escapeHtml(certificationsVal)}</div>
</section>
`;
  }

  bodyHtml += `</body>\n</html>`;

  // Replace any possible left-over double braces to guarantee no {{...}} placeholders in final output
  return (headPart + bodyHtml).replace(/\{\{[^}]*\}\}/g, '');
}
