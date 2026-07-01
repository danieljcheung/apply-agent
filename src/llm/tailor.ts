import type { ProfileBundle, LLMActionRecord } from '../types.js';
import type { LLMProvider } from './provider.js';
import { renderKamiResumeHtml } from '../kamiResume.js';
import crypto from 'crypto';

export interface LLMTailorResult {
  html: string;
  evidenceMap: Record<string, string[]>;
  unsupported: string[];
  record: LLMActionRecord;
}

export class LLMTailorError extends Error {
  constructor(
    message: string,
    public readonly record: LLMActionRecord
  ) {
    super(message);
    this.name = 'LLMTailorError';
  }
}

export async function tailorResumeWithLLM(
  provider: LLMProvider,
  profile: ProfileBundle,
  jobRequirements: string[]
): Promise<LLMTailorResult> {
  const startTime = Date.now();
  const recordId = `llm-act-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  const inputPayload = {
    jobRequirements,
    candidateName: profile.candidateProfile?.name,
    skills: profile.candidateProfile?.skills,
    experienceCount: profile.candidateProfile?.experience?.length || 0,
    projectCount: (profile.candidateProfile as any)?.projects?.length || 0,
    claimCount: profile.claimBank?.length || 0
  };

  const record: LLMActionRecord = {
    id: recordId,
    type: 'resume_tailoring',
    status: 'executing',
    inputPayload,
    createdAt: new Date().toISOString()
  };

  const systemPrompt =
    'You are a professional resume tailoring assistant. You only output valid JSON.';
  const userPrompt = `Tailor the candidate's resume for the following job requirements:
${JSON.stringify(jobRequirements, null, 2)}

Candidate Profile:
${JSON.stringify(profile.candidateProfile, null, 2)}

Available Claims:
${JSON.stringify(
  (profile.claimBank || []).map(c => ({ id: c.id, text: c.text })),
  null,
  2
)}

You must return a JSON object with the following fields:
{
  "html": "A complete, beautifully styled HTML resume string highlighting matching skills and experience.",
  "evidenceMap": {
    "each requirement": ["array of matching claim IDs from the candidate's claims"]
  },
  "unsupported": ["array of job requirements that cannot be supported by the candidate's profile/claims"]
}

Your output must be strict JSON, with no explanation or markdown wrapper.`;

  try {
    const response = await provider.execute({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      responseFormat: { type: 'json_object' }
    });

    let cleaned = response.content.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.substring(7);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.substring(0, cleaned.length - 3);
    }
    cleaned = cleaned.trim();

    const parsed = JSON.parse(cleaned) as {
      html?: string;
      summary?: string;
      evidenceMap?: Record<string, string[]>;
      unsupported?: string[];
    };

    const evidenceMap = parsed.evidenceMap || {};
    const unsupported = Array.isArray(parsed.unsupported) ? parsed.unsupported : [];

    const rawHtml = typeof parsed.html === 'string' ? parsed.html : undefined;
    const html = renderKamiResumeHtml(profile, {
      jobRequirements,
      evidenceMap,
      unsupported
    });

    const latencyMs = Date.now() - startTime;
    record.status = 'completed';
    record.completedAt = new Date().toISOString();
    record.outputPayload = {
      evidenceMap,
      unsupported,
      htmlHash: crypto.createHash('sha256').update(html).digest('hex'),
      ...(rawHtml !== undefined ? { rawHtmlHash: crypto.createHash('sha256').update(rawHtml).digest('hex') } : {})
    };
    record.audit = {
      promptTokens: response.usage?.promptTokens,
      completionTokens: response.usage?.completionTokens,
      model: provider.config.model,
      latencyMs
    };

    return {
      html,
      evidenceMap,
      unsupported,
      record
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const latencyMs = Date.now() - startTime;
    record.status = 'failed';
    record.completedAt = new Date().toISOString();
    record.error = errorMsg;
    record.audit = {
      model: provider.config.model,
      latencyMs
    };

    throw new LLMTailorError(errorMsg, record);
  }
}
