import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const k8sDir = path.resolve(__dirname, '../deploy/kubernetes');

test('K8s Manifests Verification', async (t) => {
  await t.test('kustomization.yaml includes separate deployment/service resources', async () => {
    const content = await fs.readFile(path.join(k8sDir, 'kustomization.yaml'), 'utf8');
    
    // Check that split manifests are included
    assert.match(content, /-\s*04-api-deployment\.yaml/);
    assert.match(content, /-\s*04-worker-deployment\.yaml/);
    assert.match(content, /-\s*04-web-deployment\.yaml/);
    assert.match(content, /-\s*05-api-service\.yaml/);
    assert.match(content, /-\s*05-web-service\.yaml/);
    
    // Check that old files are excluded
    assert.ok(!content.includes('04-deployment.yaml'));
    assert.ok(!content.includes('05-service.yaml'));
    
    // Check that placeholder secrets or ServiceMonitor are not in base resources
    assert.ok(!content.includes('02-secret-template.yaml'));
    assert.ok(!content.includes('servicemonitor.yaml'));
  });

  await t.test('04-api-deployment.yaml specifies API container and probes with Host headers', async () => {
    const content = await fs.readFile(path.join(k8sDir, '04-api-deployment.yaml'), 'utf8');
    
    assert.match(content, /name:\s*apply-agent-api/);
    assert.match(content, /component:\s*api/);
    assert.match(content, /image:\s*ghcr\.io\/danieljcheung\/apply-agent-api@sha256:034c3f6b73b37631d157c14505bed98716d4d959e077e0e2e4228c8e063a28aa/);
    assert.match(content, /imagePullPolicy:\s*IfNotPresent/);
    assert.match(content, /automountServiceAccountToken:\s*false/);
    assert.match(content, /imagePullSecrets:\s*- name:\s*ghcr-pull-secret/);
    assert.match(content, /allowPrivilegeEscalation:\s*false/);
    assert.match(content, /readOnlyRootFilesystem:\s*true/);
    assert.match(content, /runAsNonRoot:\s*true/);
    assert.match(content, /capabilities:\s*drop:\s*-\s*ALL/);
    assert.match(content, /secretName:\s*apply-agent-postgres-ca/);
    assert.match(content, /name:\s*DB_SSL_CA_PATH/);
    assert.match(content, /value:\s*"?\/etc\/db-ca\/ca.crt"?/);
    
    // Probes must include the Host header
    assert.match(content, /name:\s*Host/);
    assert.match(content, /value:\s*"?apply-agent-api\.apply-agent\.svc\.cluster\.local"?/);
    
    // Proton bridge should not be in the API deployment
    assert.ok(!content.includes('proton-bridge'));
  });

  await t.test('04-worker-deployment.yaml specifies worker with Playwright and Proton Bridge sidecar', async () => {
    const content = await fs.readFile(path.join(k8sDir, '04-worker-deployment.yaml'), 'utf8');
    
    assert.match(content, /name:\s*apply-agent-worker/);
    assert.match(content, /component:\s*worker/);
    assert.match(content, /image:\s*ghcr\.io\/danieljcheung\/apply-agent-worker@sha256:0a9f8834f9e9080dab38ff3138e8b064572be1fd120da943ff7b3a864cbb5c59/);
    assert.match(content, /imagePullPolicy:\s*IfNotPresent/);
    assert.match(content, /automountServiceAccountToken:\s*false/);
    assert.match(content, /imagePullSecrets:\s*- name:\s*ghcr-pull-secret/);
    assert.match(content, /allowPrivilegeEscalation:\s*false/);
    assert.match(content, /readOnlyRootFilesystem:\s*true/);
    assert.match(content, /runAsNonRoot:\s*true/);
    assert.match(content, /capabilities:\s*drop:\s*-\s*ALL/);
    assert.match(content, /secretName:\s*apply-agent-postgres-ca/);
    assert.match(content, /name:\s*DB_SSL_CA_PATH/);
    assert.match(content, /value:\s*"?\/etc\/db-ca\/ca.crt"?/);
    
    // Proton bridge sidecar must be present
    assert.match(content, /name:\s*proton-bridge/);
    assert.match(content, /image:\s*ghcr\.io\/videocurio\/proton-mail-bridge@sha256:d44f6b12650c6b0f9e0aefee192d65c6e46d0a22bd5ec189e8624812fd139c8b/);
    
    // HOME env for proton bridge should be set to /home/protonbridge
    assert.match(content, /value:\s*"?\/home\/protonbridge"?/);
    
    // Persistent Volume Claim must be attached
    assert.match(content, /claimName:\s*proton-bridge-data/);

    // Proton bridge sidecar TCP probes
    assert.match(content, /tcpSocket:\s*port:\s*imap/);
  });

  await t.test('04-web-deployment.yaml specifies Web container and probes', async () => {
    const content = await fs.readFile(path.join(k8sDir, '04-web-deployment.yaml'), 'utf8');
    
    assert.match(content, /name:\s*apply-agent-web/);
    assert.match(content, /component:\s*web/);
    assert.match(content, /image:\s*ghcr\.io\/danieljcheung\/apply-agent-web@sha256:99b90cf0dcd2d67915407408e26bc383097863577feb7264ae52dc5ee66ed001/);
    assert.match(content, /imagePullPolicy:\s*IfNotPresent/);
    assert.match(content, /automountServiceAccountToken:\s*false/);
    assert.match(content, /imagePullSecrets:\s*- name:\s*ghcr-pull-secret/);
    assert.match(content, /allowPrivilegeEscalation:\s*false/);
    assert.match(content, /readOnlyRootFilesystem:\s*true/);
    assert.match(content, /runAsNonRoot:\s*true/);
    assert.match(content, /capabilities:\s*drop:\s*-\s*ALL/);
    
    // Probes must include the Host header
    assert.match(content, /name:\s*Host/);
    assert.match(content, /value:\s*"?apply-agent-web\.apply-agent\.svc\.cluster\.local"?/);

    // Must expose the unprivileged port 8080
    assert.match(content, /containerPort:\s*8080/);
    assert.doesNotMatch(content, /containerPort:\s*80(?!80)/);

    // Probes must use the unprivileged port 8080
    assert.match(content, /livenessProbe:[\s\S]*?port:\s*8080/);
    assert.match(content, /readinessProbe:[\s\S]*?port:\s*8080/);
    assert.doesNotMatch(content, /port:\s*http/);
    assert.doesNotMatch(content, /port:\s*80(?!80)/);
  });

  await t.test('05-api-service.yaml specifies API service and component', async () => {
    const content = await fs.readFile(path.join(k8sDir, '05-api-service.yaml'), 'utf8');
    
    assert.match(content, /name:\s*apply-agent-api/);
    assert.match(content, /component:\s*api/);
  });

  await t.test('05-web-service.yaml specifies Web service and component', async () => {
    const content = await fs.readFile(path.join(k8sDir, '05-web-service.yaml'), 'utf8');
    
    assert.match(content, /name:\s*apply-agent-web/);
    assert.match(content, /component:\s*web/);

    // Must target the unprivileged port 8080
    assert.match(content, /port:\s*8080/);
    assert.match(content, /targetPort:\s*8080/);
    assert.doesNotMatch(content, /port:\s*80(?!80)/);
    assert.doesNotMatch(content, /targetPort:\s*http/);
  });

  await t.test('package.json scripts do not rebuild in start, worker, or container', async () => {
    const pkgPath = path.resolve(__dirname, '../package.json');
    const content = await fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(content);
    
    assert.ok(pkg.scripts, 'scripts should exist');
    
    // Assert start, worker, container run dist/server.js and dist/src/worker.js/docker without rebuilds
    assert.ok(!pkg.scripts.start.includes('build'), 'start script must not trigger a rebuild');
    assert.ok(!pkg.scripts.start.includes('tsc'), 'start script must not run tsc');
    assert.match(pkg.scripts.start, /node\s+dist\/server\.js/, 'start script should execute server from dist');
    
    assert.ok(!pkg.scripts.worker.includes('build'), 'worker script must not trigger a rebuild');
    assert.ok(!pkg.scripts.worker.includes('tsc'), 'worker script must not run tsc');
    assert.match(pkg.scripts.worker, /node\s+dist\/src\/worker\.js/, 'worker script should execute worker from dist');
    
    // To prove it does not run any other rebuild (e.g. npm run build), we clean allowed occurrences of 'docker build'
    const containerCleaned = pkg.scripts.container.replace(/docker\s+build/g, '');
    assert.ok(!containerCleaned.includes('build'), 'container script must not trigger a rebuild');
    assert.ok(!pkg.scripts.container.includes('tsc'), 'container script must not run tsc');
    assert.ok(!pkg.scripts.container.includes('npm run'), 'container script must not delegate to run npm scripts');
    assert.match(pkg.scripts.container, /docker\s+build/, 'container script should run docker build');

    // Ensure it does not omit targets, and has explicit target options for web, api, and worker
    const commands = pkg.scripts.container.split('&&').map(cmd => cmd.trim());
    let hasWeb = false;
    let hasApi = false;
    let hasWorker = false;

    for (const cmd of commands) {
      if (cmd.includes('docker build')) {
        assert.ok(cmd.includes('--target'), 'Each docker build command must specify a target');
        if (/(^|\s)--target[=\s]+web(\s|$)/.test(cmd)) hasWeb = true;
        if (/(^|\s)--target[=\s]+api(\s|$)/.test(cmd)) hasApi = true;
        if (/(^|\s)--target[=\s]+worker(\s|$)/.test(cmd)) hasWorker = true;
      }
    }
    assert.ok(hasWeb, 'Must specify a docker build target for web');
    assert.ok(hasApi, 'Must specify a docker build target for api');
    assert.ok(hasWorker, 'Must specify a docker build target for worker');
  });

  await t.test('01-configmap.yaml sets DB_SSLMODE to require', async () => {
    const content = await fs.readFile(path.join(k8sDir, '01-configmap.yaml'), 'utf8');
    assert.match(content, /DB_SSLMODE:\s*"?require"?/);
  });

  await t.test('kustomization.yaml includes 09-networkpolicies.yaml', async () => {
    const content = await fs.readFile(path.join(k8sDir, 'kustomization.yaml'), 'utf8');
    assert.match(content, /-\s*09-networkpolicies\.yaml/);
    assert.match(content, /-\s*10-ingress-tailscale\.yaml/);
  });

  await t.test('09-networkpolicies.yaml defines default deny, DNS, scoped web ingress, web->api, api/worker->postgres, Prometheus metrics, and worker egress policies', async () => {
    const content = await fs.readFile(path.join(k8sDir, '09-networkpolicies.yaml'), 'utf8');
    assert.match(content, /name:\s*default-deny/);
    assert.match(content, /name:\s*allow-dns-egress/);
    assert.match(content, /name:\s*allow-web-ingress/);
    assert.match(content, /kubernetes\.io\/metadata\.name:\s*tailscale/);
    assert.match(content, /kubernetes\.io\/metadata\.name:\s*ingress-nginx/);
    assert.match(content, /name:\s*allow-web-egress-to-api/);
    assert.match(content, /name:\s*allow-api-ingress-from-web/);
    assert.match(content, /name:\s*allow-api-egress/);
    assert.match(content, /name:\s*allow-worker-egress/);
    assert.match(content, /name:\s*allow-postgres-internal/);
    assert.match(content, /kubernetes\.io\/metadata\.name:\s*cnpg-system/);
    assert.match(content, /name:\s*allow-metrics-scraping/);
  });

  await t.test('10-ingress-tailscale.yaml exposes web service through Tailscale', async () => {
    const content = await fs.readFile(path.join(k8sDir, '10-ingress-tailscale.yaml'), 'utf8');
    assert.match(content, /kind:\s*Ingress/);
    assert.match(content, /ingressClassName:\s*tailscale/);
    assert.match(content, /host:\s*apply-agent/);
    assert.match(content, /name:\s*apply-agent-web/);
    assert.match(content, /name:\s*http/);
  });

  await t.test('07-pvc.yaml uses ReadWriteMany and longhorn storageClassName', async () => {
    const content = await fs.readFile(path.join(k8sDir, '07-pvc.yaml'), 'utf8');
    assert.match(content, /accessModes:[\s\S]*?-\s*ReadWriteMany/);
    assert.match(content, /storageClassName:\s*longhorn/);
  });

  await t.test('03-postgres-cluster.yaml sets synchronous_commit to on', async () => {
    const content = await fs.readFile(path.join(k8sDir, '03-postgres-cluster.yaml'), 'utf8');
    assert.match(content, /synchronous_commit:\s*"on"/);
  });

  await t.test('deploy/nginx/default.conf uses internal Host and sets forwarded headers', async () => {
    const nginxConfPath = path.resolve(__dirname, '../deploy/nginx/default.conf');
    const content = await fs.readFile(nginxConfPath, 'utf8');
    assert.match(content, /proxy_set_header\s+Host\s+apply-agent-api\.apply-agent\.svc\.cluster\.local;/);
    assert.match(content, /proxy_set_header\s+X-Forwarded-Host\s+\$host;/);
    assert.match(content, /proxy_set_header\s+X-Forwarded-Proto\s+\$scheme;/);
  });
});
