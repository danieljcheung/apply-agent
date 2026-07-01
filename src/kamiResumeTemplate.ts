export const KAMI_RESUME_TEMPLATE_VERSION = '1.7.4';
export const KAMI_RESUME_TEMPLATE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>{{NAME}} · Resume</title>
<meta name="author" content="{{NAME}}">
<meta name="description" content="{{DESCRIPTION}}">
<meta name="keywords" content="{{KEYWORDS}}">
<meta name="generator" content="Kami">
<style>
  @font-face { font-family: "Newsreader"; src: url("/Users/dan/.agents/skills/kami/assets/fonts/Newsreader.woff2") format("woff2"); font-weight: 400; font-style: normal; }
  @font-face { font-family: "Newsreader"; src: url("/Users/dan/.agents/skills/kami/assets/fonts/Newsreader.woff2") format("woff2"); font-weight: 500; font-style: normal; }
  @font-face { font-family: "Inter"; src: url("/Users/dan/.agents/skills/kami/assets/fonts/Inter.woff2") format("woff2"); font-weight: 400; font-style: normal; }
  @font-face { font-family: "Inter"; src: url("/Users/dan/.agents/skills/kami/assets/fonts/Inter-500.woff2") format("woff2"); font-weight: 500; font-style: normal; }
  @font-face { font-family: "Inter"; src: url("/Users/dan/.agents/skills/kami/assets/fonts/Inter-600.woff2") format("woff2"); font-weight: 600; font-style: normal; }
  @page { size: A4; margin: 8mm 12mm 8mm 12mm; background: #f5f4ed; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --parchment:#f5f4ed; --border:#e8e6dc; --border-soft:#e5e3d8; --near-black:#141413; --dark-warm:#3d3d3a; --olive:#5e5d59; --stone:#87867f; --brand:#1B365D; --brand-tint:#EEF2F7; --serif:"Newsreader","Source Serif 4","Source Serif Pro","Charter",Georgia,"Times New Roman",serif; --sans:"Inter",-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif; }
  html, body { background: var(--parchment); }
  @media screen { body { max-width: 210mm; margin: 0 auto; padding: 11mm 13mm; } }
  body { color: var(--near-black); font-family: var(--serif); font-size: 8.35pt; line-height: 1.31; }
  .serif { font-family: var(--serif); } a { color: var(--brand); text-decoration: none; }
  .header { display:flex; align-items:flex-end; justify-content:space-between; margin-bottom:2mm; border-left:2.5pt solid var(--brand); border-radius:1.5pt; padding-left:8pt; }
  .name { font-size:24pt; font-weight:500; letter-spacing:-0.2pt; line-height:1; white-space:nowrap; }
  .contact { text-align:right; font-size:8.35pt; color:var(--stone); line-height:1.32; }
  .contact .role { color:var(--brand); font-size:9.6pt; font-weight:500; }
  .contact .sep { color:var(--border); margin:0 0.4em; } .contact a { color:var(--dark-warm); } .contact .loc { color:var(--olive); font-weight:500; }
  .section-title { font-size:11.8pt; font-weight:500; border-bottom:0.5pt solid var(--border); padding:0 0 2pt 0; margin:2.8mm 0 1.1mm 0; display:flex; align-items:baseline; gap:2.5mm; }
  section:first-of-type .section-title { margin-top:0; }
  .summary { font-size:8.55pt; line-height:1.32; color:var(--near-black); } .summary .hl { color:var(--brand); }
  .edu-item { padding:0.35mm 0; break-inside:avoid; } .edu-head { display:flex; align-items:baseline; gap:2mm; margin-bottom:0.35mm; }
  .school { font-size:10.8pt; font-weight:500; } .major { font-size:9.8pt; color:var(--olive); }
  .edu-item .date { font-size:8.35pt; line-height:1.28; }
  .project { padding:0.72mm 0; border-top:0.4pt solid var(--border-soft); break-inside:avoid; }
  .project:first-of-type { border-top:0.4pt solid var(--border); padding-top:0.75mm; }
  .proj-head { display:flex; align-items:baseline; gap:2mm; margin-bottom:0.35mm; }
  .proj-name { font-size:10.2pt; font-weight:500; }
  .proj-kind { font-size:9.55pt; color:var(--olive); }
  .proj-role { font-size:8pt; color:var(--brand); font-weight:600; margin-left:auto; background:var(--brand-tint); padding:0.3mm 1.45mm; border-radius:2pt; letter-spacing:0.3pt; text-transform:uppercase; }
  .proj-lines { display:table; width:100%; } .proj-row { display:table-row; }
  .proj-label { display:table-cell; width:17mm; font-size:7.65pt; color:var(--brand); font-weight:600; letter-spacing:0.35pt; text-transform:uppercase; padding:0.12mm 0; vertical-align:top; }
  .proj-text { display:table-cell; font-size:8.25pt; line-height:1.27; padding:0 0 0.12mm 1mm; }
  .proj-text .hl { color:var(--brand); }
</style>
</head>
<body>
<div class="header">
  <div><div class="name serif">Daniel Cheung</div></div>
  <div class="contact">
    <div class="role">Computer Science Student · Full-Stack Software Engineering</div>
    <div><a href="https://danieljcheung.com">danieljcheung.com</a><span class="sep">·</span><a href="https://github.com/danieljcheung">github.com/danieljcheung</a><span class="sep">·</span><a href="mailto:danieljcheung@proton.me">danieljcheung@proton.me</a></div>
    <div><span class="loc">Toronto, ON</span></div>
  </div>
</div>

<section>
  <div class="section-title">Education</div>
  <div class="edu-item">
    <div class="edu-head"><span class="school serif">Western University</span><span class="major"> · Bachelor of Science · Computer Science</span></div>
    <div class="date">Expected Graduation: 2027 · <span class="hl">Computer Science Coursework Average: 80%</span></div>
    <div class="date">Coursework: Operating Systems, Computer Networks, Software Project Management, Object-Oriented Design &amp; Analysis, Data Structures &amp; Algorithms</div>
  </div>
</section>

<section>
  <div class="section-title">Summary</div>
  <div class="summary">Computer Science student focused on <span class="hl">full-stack React/TypeScript web applications, REST APIs, PostgreSQL, AI-assisted development, and cloud-native delivery</span>. Built production-style tools with React, Next.js, TypeScript, Prisma/PostgreSQL, OpenAI APIs, OAuth, REST integrations, GitHub Actions, Kubernetes, and observability tooling. Strong debugger who turns business problems into tested, documented software workflows.</div>
</section>

<section>
  <div class="section-title">Technical Projects</div>
  <div class="project">
    <div class="proj-head"><span class="proj-name serif">Popup Pearl Ops Dashboard</span><span class="proj-kind">· Full-stack AI-assisted web application</span><span class="proj-role">Builder</span></div>
    <div class="proj-lines">
      <div class="proj-row"><div class="proj-label">Frontend</div><div class="proj-text">Built a responsive operations dashboard with <span class="hl">React, Next.js, TypeScript, HTML, and CSS</span> to manage event inquiries, owner review, invoice readiness, and customer-facing reply drafts.</div></div>
      <div class="proj-row"><div class="proj-label">Backend</div><div class="proj-text">Implemented Next.js API routes, Prisma/PostgreSQL models, OAuth/API integration paths, validation, error handling, and R2-backed attachment storage for source-backed workflows.</div></div>
      <div class="proj-row"><div class="proj-label">AI + QA</div><div class="proj-text">Integrated OpenAI-powered structured extraction for receipts and inquiries; tested real customer/event edge cases and saved <span class="hl">4+ hours weekly</span> of email and invoice checking.</div></div>
    </div>
  </div>
  <div class="project">
    <div class="proj-head"><span class="proj-name serif">Kin</span><span class="proj-kind">· AWS-backed assistant workflow · <a href="https://github.com/danieljcheung/kin">GitHub</a></span><span class="proj-role">Builder</span></div>
    <div class="proj-lines">
      <div class="proj-row"><div class="proj-label">Services</div><div class="proj-text">Built cloud-backed TypeScript/Next.js workflows using <span class="hl">AWS EC2, RDS/PostgreSQL, EventBridge Scheduler, and SQS</span> for scheduled tasks and queue-backed message routing.</div></div>
      <div class="proj-row"><div class="proj-label">Data</div><div class="proj-text">Designed Prisma/PostgreSQL schemas for users, family bindings, task states, and scheduling metadata, applying object-oriented design concepts to keep models maintainable.</div></div>
      <div class="proj-row"><div class="proj-label">Debug</div><div class="proj-text">Investigated webhook delays, API latency, database query behaviour, and messaging-layer bugs using logs, endpoint checks, SQL troubleshooting, and deployment notes.</div></div>
    </div>
  </div>
  <div class="project">
    <div class="proj-head"><span class="proj-name serif">Talos Kubernetes Homelab</span><span class="proj-kind">· Container delivery + observability · <a href="https://github.com/danieljcheung/talos-kubernetes-homelab">GitHub</a></span><span class="proj-role">Operator</span></div>
    <div class="proj-lines">
      <div class="proj-row"><div class="proj-label">CI/CD</div><div class="proj-text">Packaged apps into container images with <span class="hl">GitHub Actions and GHCR</span>, then deployed them through Argo CD GitOps workflows to a multi-node Kubernetes cluster.</div></div>
      <div class="proj-row"><div class="proj-label">Monitor</div><div class="proj-text">Configured Prometheus, Grafana, Loki, and Alloy pipelines for health checks, logs, deployment troubleshooting, and backup/restore verification.</div></div>
      <div class="proj-row"><div class="proj-label">Cloud</div><div class="proj-text">Moved always-on lab workloads to owned bare-metal nodes to reduce recurring cloud VM spend while keeping AWS S3 for recovery practice.</div></div>
    </div>
  </div>
</section>

<section>
  <div class="section-title">Experience</div>
  <div class="project">
    <div class="proj-head"><span class="proj-name serif">Popup Pearl</span><span class="proj-kind">· Founder-operated catering business</span><span class="proj-role">Founder</span></div>
    <div class="proj-lines">
      <div class="proj-row"><div class="proj-label">Scale</div><div class="proj-text">Built and operated a catering business generating <span class="hl">$50,000 in first-year revenue</span> across <span class="hl">50+ corporate and private events</span> in the GTA.</div></div>
      <div class="proj-row"><div class="proj-label">Product</div><div class="proj-text">Translated operational pain points into software requirements, then tested workflows directly against customer inquiries, event logistics, receipts, and invoicing edge cases.</div></div>
      <div class="proj-row"><div class="proj-label">Delivery</div><div class="proj-text">Coordinated inventory, staffing, schedules, and customer communication under fixed deadlines, adapting execution plans from real-time feedback.</div></div>
    </div>
  </div>
</section>

<section>
  <div class="section-title">Technical Skills</div>
  <div class="summary">
    <span class="hl">Full-Stack Web:</span> TypeScript, JavaScript, React, Next.js, Node.js, HTML5, CSS3, REST APIs, validation, error handling<br/>
    <span class="hl">Data &amp; Integrations:</span> PostgreSQL, Prisma ORM, SQL, OAuth, Gmail API, Google Drive API, Cloudflare R2/S3-compatible storage<br/>
    <span class="hl">AI-Assisted Development:</span> OpenAI API workflows, structured extraction, prompt/schema design, Cursor/VS Code AI-assisted development<br/>
    <span class="hl">Cloud &amp; Delivery:</span> AWS fundamentals, GitHub Actions, Docker/container images, GHCR, Kubernetes, Argo CD, Vercel, Cloudflare Tunnel<br/>
    <span class="hl">Debugging &amp; Tools:</span> Git workflows, Linux, Bash/shell scripting, Python, npm, Prisma CLI, Prometheus, Grafana, Loki
  </div>
</section>

<section>
  <div class="section-title">Certifications</div>
  <div class="summary"><span class="hl">AWS Certified Cloud Practitioner</span> — <a href="https://www.credly.com/badges/e7405b8a-539b-41c0-af64-8bef0f9b8d7a/public_url">Credly</a> · <span class="hl">IBM Z Xplore - Concepts</span> — <a href="https://www.credly.com/badges/be96070c-ce25-447f-a9d0-96fd7143fd1a/public_url">Credly</a></div>
</section>
</body>
</html>
`;
