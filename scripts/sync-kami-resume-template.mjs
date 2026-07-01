import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const templatePath = process.env.KAMI_RESUME_TEMPLATE_PATH || '/Users/dan/clawd/job-hunt/Daniel-Cheung-MLSE-Software-Engineer-Intern-Resume.html';
const versionPath = process.env.KAMI_VERSION_PATH || '/Users/dan/.agents/skills/kami/VERSION';

let templateContent;
try {
  templateContent = await fs.readFile(templatePath, 'utf-8');
} catch (err) {
  console.error(`Kami resume template not found at ${templatePath}; set KAMI_RESUME_TEMPLATE_PATH to override it`);
  process.exit(1);
}

templateContent = templateContent
  .replace(/<title>[\s\S]*?<\/title>/, '<title>{{NAME}} · Resume</title>')
  .replace(/<meta name="author" content=".*?">/, '<meta name="author" content="{{NAME}}">')
  .replace(/<meta name="description" content=".*?">/, '<meta name="description" content="{{DESCRIPTION}}">')
  .replace(/<meta name="keywords" content=".*?">/, '<meta name="keywords" content="{{KEYWORDS}}">');

let version = 'unknown';
try {
  version = (await fs.readFile(versionPath, 'utf-8')).trim();
} catch {
  // Use 'unknown' fallback
}

const escapedTemplate = templateContent
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

const outputContent = `export const KAMI_RESUME_TEMPLATE_VERSION = '${version}';
export const KAMI_RESUME_TEMPLATE = String.raw\`${escapedTemplate}\`;
`;

const outputPath = path.join(root, 'src', 'kamiResumeTemplate.ts');
await fs.writeFile(outputPath, outputContent, 'utf-8');
console.log(`Synced template from ${templatePath} (version ${version}) to ${outputPath}`);
