import type { ProfileBundle, FieldProvenance } from '../types.js';
import type { FormControlInfo } from './blockers.js';

export interface FieldMapping {
  fieldId: string;
  selector: string;
  value: string;
  control: FormControlInfo;
  provenance: FieldProvenance;
}

export interface FieldMappingOutput {
  mappings: FieldMapping[];
  filledFields: string[];
  provenance: FieldProvenance[];
}

export function mapFormControls(
  formControls: FormControlInfo[],
  profile: ProfileBundle | null,
  options?: { resumePath?: string }
): FieldMappingOutput {
  const mappings: FieldMapping[] = [];
  const filledFields: string[] = [];
  const provenance: FieldProvenance[] = [];

  if (!profile) {
    return { mappings, filledFields, provenance };
  }

  const candidate = profile.candidateProfile || { name: '', email: '', phone: '', skills: [], experience: [], education: [] };
  const answerMemory = profile.answerMemory || {};

  for (const control of formControls) {
    // Skip submit buttons and general buttons
    if (control.type === 'submit' || control.type === 'button') {
      continue;
    }

    const fieldId = control.id || control.automationId || control.name;
    if (!fieldId) {
      continue;
    }

    let selector = '';
    if (control.id) {
      selector = `[id="${control.id}"]`;
    } else if (control.automationId) {
      selector = `[data-automation-id="${control.automationId}"]`;
    } else if (control.name) {
      selector = `[name="${control.name}"]`;
    }

    if (!selector) {
      continue;
    }

    const label = control.label.toLowerCase();
    const name = control.name.toLowerCase();
    const autoId = (control.automationId || '').toLowerCase();

    let mappedValue: string | null = null;
    let source = '';
    let confidence = 1.0;

    // 0. File upload: Resume / CV
    if (control.type === 'file' || label.includes('resume') || name.includes('resume') || autoId.includes('file-upload') || autoId.includes('drop-zone')) {
      if (options?.resumePath) {
        mappedValue = options.resumePath;
        source = 'artifact:resume';
        confidence = 1.0;
      }
    } else
    // 1. Identity: First Name
    if (
      autoId.includes('legalnamesection_firstname') ||
      autoId.includes('firstname') ||
      name.includes('firstname') ||
      label.includes('first name')
    ) {
      if (candidate.name) {
        const parts = candidate.name.trim().split(/\s+/);
        mappedValue = parts[0] || '';
        source = 'candidateProfile:name';
        confidence = 1.0;
      }
    }
    // 2. Identity: Last Name
    else if (
      autoId.includes('legalnamesection_lastname') ||
      autoId.includes('lastname') ||
      name.includes('lastname') ||
      label.includes('last name')
    ) {
      if (candidate.name) {
        const parts = candidate.name.trim().split(/\s+/);
        mappedValue = parts.length > 1 ? parts.slice(1).join(' ') : parts[0] || '';
        source = 'candidateProfile:name';
        confidence = 1.0;
      }
    }
    // 3. Identity: Full Name
    else if (
      autoId.includes('fullname') ||
      name.includes('fullname') ||
      label.includes('full name') ||
      ((name === 'name' || label === 'name') && !name.includes('first') && !name.includes('last'))
    ) {
      if (candidate.name) {
        mappedValue = candidate.name;
        source = 'candidateProfile:name';
        confidence = 1.0;
      }
    }
    // 4. Contact: Email
    else if (control.type === 'email' || autoId.includes('email') || name.includes('email') || label.includes('email')) {
      if (candidate.email) {
        mappedValue = candidate.email;
        source = 'candidateProfile:email';
        confidence = 1.0;
      }
    }
    // 5. Contact: Phone
    else if (control.type === 'tel' || autoId.includes('phone') || name.includes('phone') || label.includes('phone')) {
      if (candidate.phone) {
        mappedValue = candidate.phone;
        source = 'candidateProfile:phone';
        confidence = 1.0;
      }
    }
    // 6. Work Authorization
    else if (
      autoId.includes('work-auth') ||
      autoId.includes('workauth') ||
      name.includes('workauth') ||
      label.includes('authorized to work') ||
      label.includes('work authorization') ||
      label.includes('legally authorized')
    ) {
      const authAns = findAnswerMemoryValue(answerMemory, ['workAuth', 'work_authorization', 'workAuthorization', 'authorized', 'legally authorized']);
      if (authAns) {
        mappedValue = authAns.value;
        source = `answerMemory:${authAns.key}`;
        confidence = 0.95;
      } else {
        mappedValue = 'yes';
        source = 'profile:default_work_auth';
        confidence = 0.8;
      }
    }
    // 7. Sponsorship
    else if (
      autoId.includes('sponsorship') ||
      name.includes('sponsorship') ||
      label.includes('sponsorship') ||
      label.includes('require sponsorship')
    ) {
      const sponsorAns = findAnswerMemoryValue(answerMemory, ['sponsorship', 'visa_sponsorship', 'visa', 'require sponsorship']);
      if (sponsorAns) {
        mappedValue = sponsorAns.value;
        source = `answerMemory:${sponsorAns.key}`;
        confidence = 0.95;
      } else {
        mappedValue = 'no';
        source = 'profile:default_sponsorship';
        confidence = 0.8;
      }
    }
    // 8. Checkbox / Radio or Generic answerMemory lookup
    else {
      let foundInMemory = false;
      for (const [qKey, qVal] of Object.entries(answerMemory)) {
        const qLower = qKey.toLowerCase();
        if (qLower.includes(label) || label.includes(qLower) || (name && qLower.includes(name))) {
          const valStr = typeof qVal === 'string' ? qVal : qVal.answer;
          if (valStr) {
            mappedValue = valStr;
            source = `answerMemory:${qKey}`;
            confidence = 0.9;
            foundInMemory = true;
            break;
          }
        }
      }
      if (!foundInMemory) {
        if (control.type === 'checkbox') {
          if (label.includes('agree') || label.includes('terms') || label.includes('consent') || control.required) {
            mappedValue = 'true';
            source = 'profile:default_checkbox';
            confidence = 0.8;
          }
        } else if (control.type === 'radio') {
          if (control.required) {
            mappedValue = 'yes';
            source = 'profile:default_radio';
            confidence = 0.8;
          }
        }
      }
    }

    if (mappedValue !== null && mappedValue !== undefined) {
      if (control.type === 'select' && control.options && control.options.length > 0) {
        const matchedOption = resolveSelectOption(mappedValue, control.options);
        if (matchedOption) {
          mappedValue = matchedOption;
        }
      }

      const prov: FieldProvenance = {
        field: fieldId,
        source,
        confidence
      };

      mappings.push({
        fieldId,
        selector,
        value: mappedValue,
        control,
        provenance: prov
      });
      filledFields.push(fieldId);
      provenance.push(prov);
    }
  }

  return { mappings, filledFields, provenance };
}

function findAnswerMemoryValue(
  answerMemory: Record<string, string | { answer: string; scope?: string; source?: string }>,
  keywords: string[]
): { key: string; value: string } | null {
  for (const [key, val] of Object.entries(answerMemory)) {
    const kLower = key.toLowerCase();
    if (keywords.some(kw => kLower.includes(kw.toLowerCase()))) {
      const value = typeof val === 'string' ? val : val.answer;
      if (value) {
        return { key, value };
      }
    }
  }
  return null;
}

function resolveSelectOption(targetValue: string, options: string[]): string {
  const targetLower = targetValue.toLowerCase().trim();
  for (const opt of options) {
    if (opt.toLowerCase().trim() === targetLower) {
      return opt;
    }
  }
  for (const opt of options) {
    const optLower = opt.toLowerCase().trim();
    if (optLower.includes(targetLower) || targetLower.includes(optLower)) {
      return opt;
    }
  }
  return targetValue;
}
