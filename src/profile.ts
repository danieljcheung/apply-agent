import type { AnswerMemory, CandidateProfile, Claim, ProfileBundle, ProjectEntry } from './types.js';

type ExperienceEntry = NonNullable<CandidateProfile['experience']>[number];
type EducationEntry = NonNullable<CandidateProfile['education']>[number];

type ParsedResume = CandidateProfile;

export class ProfileBuilder {
  candidateProfile: CandidateProfile;
  claimBank: Claim[];
  answerMemory: AnswerMemory;

  constructor() {
    this.candidateProfile = {
      name: '',
      email: '',
      phone: '',
      skills: [],
      experience: [],
      education: [],
      projects: []
    };
    this.claimBank = [];
    this.answerMemory = {};
  }

  parseResume(text: string): ParsedResume {
    if (!text) {
      return { name: '', email: '', phone: '', skills: [], experience: [], education: [], projects: [] };
    }

    const lines = text.split('\n').map(line => line.trim().replace(/^#{1,6}\s+/, '')).filter(Boolean);
    let name = '';
    let email = '';
    let phone = '';
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;

    for (const line of lines.slice(0, 5)) {
      if (!emailRegex.test(line) && !phoneRegex.test(line) && line.split(' ').length <= 4 && !line.toLowerCase().includes('resume') && !line.toLowerCase().includes('cv')) {
        name = line;
        break;
      }
    }

    for (const line of lines) {
      if (!email) {
        email = line.match(emailRegex)?.[0] ?? '';
      }
      if (!phone) {
        phone = line.match(phoneRegex)?.[0] ?? '';
      }
    }

    const skills: string[] = [];
    let inSkillsSection = false;
    for (const line of lines) {
      const lowerLine = line.toLowerCase();
      if (lowerLine.includes('skills') || lowerLine.includes('technologies') || lowerLine.includes('key expertise')) {
        inSkillsSection = true;
        continue;
      }
      if (!inSkillsSection) {
        continue;
      }
      if (/^(experience|education|work|employment|summary|projects|selected projects|technical projects|open source)/i.test(line)) {
        inSkillsSection = false;
        continue;
      }
      skills.push(...line.split(/[,;|•]/).map(skill => skill.trim()).filter(Boolean));
    }

    const experience: ExperienceEntry[] = [];
    const education: EducationEntry[] = [];
    const projects: ProjectEntry[] = [];
    let currentSection: 'experience' | 'education' | 'projects' | null = null;
    let currentExperience: ExperienceEntry | null = null;
    let currentEducation: EducationEntry | null = null;
    let currentProject: ProjectEntry | null = null;

    const flushCurrent = (): void => {
      if (currentSection === 'experience' && currentExperience) {
        experience.push(currentExperience);
      }
      if (currentSection === 'education' && currentEducation) {
        education.push(currentEducation);
      }
      if (currentSection === 'projects' && currentProject) {
        projects.push(currentProject);
      }
      currentExperience = null;
      currentEducation = null;
      currentProject = null;
    };

    for (const line of lines) {
      const lower = line.toLowerCase();
      if (lower.startsWith('experience') || lower.startsWith('work experience') || lower.startsWith('employment history') || lower.startsWith('professional experience')) {
        flushCurrent();
        currentSection = 'experience';
        continue;
      }
      if (lower.startsWith('education') || lower.startsWith('academic background')) {
        flushCurrent();
        currentSection = 'education';
        continue;
      }
      if (lower.startsWith('projects') || lower.startsWith('selected projects') || lower.startsWith('technical projects') || lower.startsWith('open source')) {
        flushCurrent();
        currentSection = 'projects';
        continue;
      }
      if (/^(skills|summary|certifications|awards)/i.test(line)) {
        flushCurrent();
        currentSection = null;
        continue;
      }

      if (currentSection === 'experience') {
        if (/\b(19|20)\d{2}\b/g.test(line) || /developer|engineer|manager|lead|analyst|specialist|consultant|architect/i.test(line)) {
          if (currentExperience) {
            experience.push(currentExperience);
          }
          currentExperience = { title: line, description: '' };
        } else if (currentExperience) {
          currentExperience.description += `${currentExperience.description ? '\n' : ''}${line}`;
        }
      } else if (currentSection === 'education') {
        if (/\b(19|20)\d{2}\b/g.test(line) || /university|college|school|degree|bachelor|master|phd|diploma/i.test(line)) {
          if (currentEducation) {
            education.push(currentEducation);
          }
          currentEducation = { institution: line, details: '' };
        } else if (currentEducation) {
          currentEducation.details += `${currentEducation.details ? '\n' : ''}${line}`;
        }
      } else if (currentSection === 'projects') {
        const isDescription = /^(developed|built|created|designed|implemented|wrote|managed|led|worked|optimized|used|tech stack|technologies|stack:|skills:|python|javascript|typescript|c\+\+|java|rust|go\b)/i.test(line) ||
          /^[-*•+]\s+/.test(line) ||
          line.endsWith('.') ||
          /^[a-z]/.test(line);

        if (!currentProject || (!isDescription && line.length < 60)) {
          if (currentProject) {
            projects.push(currentProject);
          }
          const title = line.replace(/^[-*•+\d.\s]+/, '').trim();
          currentProject = { name: title, title: title, description: '' };
        } else if (currentProject) {
          currentProject.description += `${currentProject.description ? '\n' : ''}${line}`;
        }
      }
    }
    flushCurrent();

    return {
      name,
      email,
      phone,
      skills: [...new Set(skills)],
      experience,
      education,
      projects
    };
  }

  build(resumeText: string, interviewAnswers: Record<string, string> = {}): ProfileBundle {
    const hasResume = typeof resumeText === 'string' && resumeText.trim().length > 0;
    if (hasResume) {
      const facts = this.parseResume(resumeText);
      this.candidateProfile = {
        ...this.candidateProfile,
        ...facts
      };
    }

    this.answerMemory = {
      ...this.answerMemory,
      ...interviewAnswers
    };

    if (hasResume) {
      this.claimBank = buildClaimBank(this.candidateProfile, this.answerMemory);
    } else {
      const skillAndExpClaims = this.claimBank.filter(c => c.category === 'skills' || c.category === 'experience' || c.category === 'projects');
      const qaClaims: Claim[] = [];
      Object.entries(this.answerMemory).forEach(([question, answer], idx) => {
        const text = typeof answer === 'string' ? answer : (answer && answer.answer) || '';
        qaClaims.push({
          id: `qa_${idx}`,
          text,
          category: 'interview',
          question,
          source: typeof answer === 'object' && answer && answer.source ? answer.source : undefined
        });
      });
      this.claimBank = [...skillAndExpClaims, ...qaClaims];
    }

    return {
      candidateProfile: this.candidateProfile,
      claimBank: this.claimBank,
      answerMemory: this.answerMemory
    };
  }
}

export function buildClaimBank(
  candidateProfile: CandidateProfile,
  answerMemory: AnswerMemory = {},
  sourcePrefix = ''
): Claim[] {
  const claimBank: Claim[] = [];
  const prefix = sourcePrefix ? `resume_${sourcePrefix}` : '';
  const source = sourcePrefix ? `resume:${sourcePrefix}` : undefined;

  (candidateProfile.skills || []).forEach((skill, idx) => {
    claimBank.push({
      id: prefix ? `${prefix}_skill_${idx}` : `skill_${idx}`,
      text: `Proficient in ${skill}.`,
      category: 'skills',
      value: skill,
      source
    });
  });

  (candidateProfile.experience || []).forEach((exp, idx) => {
    const sentences = (exp.description || '').split(/[.!?]+/).map(sentence => sentence.trim()).filter(Boolean);
    sentences.forEach((sentence, sentenceIndex) => {
      claimBank.push({
        id: prefix ? `${prefix}_exp_${idx}_${sentenceIndex}` : `exp_${idx}_${sentenceIndex}`,
        text: sentence,
        category: 'experience',
        context: exp.title,
        source
      });
    });
  });

  (candidateProfile.projects || []).forEach((proj, idx) => {
    const sentences = (proj.description || '').split(/[.!?]+/).map(sentence => sentence.trim()).filter(Boolean);
    sentences.forEach((sentence, sentenceIndex) => {
      claimBank.push({
        id: prefix ? `${prefix}_project_${idx}_${sentenceIndex}` : `project_${idx}_${sentenceIndex}`,
        text: sentence,
        category: 'projects',
        context: proj.name || proj.title,
        source
      });
    });
  });

  Object.entries(answerMemory).forEach(([question, answer], idx) => {
    const text = typeof answer === 'string' ? answer : (answer && answer.answer) || '';
    claimBank.push({
      id: `qa_${idx}`,
      text,
      category: 'interview',
      question,
      source: typeof answer === 'object' && answer && answer.source ? answer.source : undefined
    });
  });

  return claimBank;
}
