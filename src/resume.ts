import type { Claim, ProfileBundle } from './types.js';
import { renderKamiResumeHtml } from './kamiResume.js';

export type TailoredResume = {
  html: string;
  evidenceMap: Record<string, string[]>;
  unsupported: string[];
};

export class ResumeTailor {
  constructor(private readonly profile: ProfileBundle = { candidateProfile: { name: '', email: '', phone: '', skills: [], experience: [], education: [] }, claimBank: [], answerMemory: {} }) {}

  tailor(jobRequirements: string[] = []): TailoredResume {
    const claims = this.profile.claimBank;
    const candidate = this.profile.candidateProfile;
    const evidenceMap: Record<string, string[]> = {};
    const unsupported: string[] = [];
    const matchedClaimIds = new Set<string>();

    for (const requirement of jobRequirements) {
      const requirementLower = requirement.toLowerCase();
      const requirementWords = requirementLower.split(/\W+/).filter(word => word.length > 2);
      const matchingClaims = claims.filter((claim: Claim) => {
        const claimText = claim.text.toLowerCase();
        return claimText.includes(requirementLower) || (requirementWords.length > 0 && requirementWords.every(word => claimText.includes(word)));
      });

      if (matchingClaims.length > 0) {
        evidenceMap[requirement] = matchingClaims.map(claim => claim.id);
        matchingClaims.forEach(claim => matchedClaimIds.add(claim.id));
      } else {
        unsupported.push(requirement);
      }
    }

    const html = renderKamiResumeHtml(this.profile, {
      jobRequirements,
      evidenceMap,
      unsupported
    });
    return {
      html,
      evidenceMap,
      unsupported
    };
  }
}
