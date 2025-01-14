#!/usr/bin/env node

// This nodejs script loads the .nsprc's "exceptions" list (as `nsp check` used to support) and
// and then filters the output of `npm audit --json` to check if any of the security advisories
// detected should be a blocking issue and force the CI job to fail.
//
// We can remove this script if/once npm audit will support this feature natively
// (See https://github.com/npm/npm/issues/20565).

import shell from 'shelljs';
import stripJsonComments from 'strip-json-comments';

const npmVersion = parseInt(shell.exec('npm --version', {silent: true}).stdout.split('.')[0], 10);
const npmCmd = npmVersion >= 6 ? 'npm' : 'npx npm@latest';

if (npmCmd.startsWith('npx') && !shell.which('npx')) {
  shell.echo('Sorry, this script requires npm >= 6 or npx installed globally');
  shell.exit(1);
}

if (!shell.test('-f', 'package-lock.json')) {
  console.log('audit-deps is generating the missing package-lock.json file');
  shell.exec(`${npmCmd} i --package-lock-only`);
}

// Collect audit results and split them into blocking and ignored issues.
function getNpmAuditJSON() {
  const res = shell.exec(`${npmCmd} audit --json`, {silent: true});
  if (res.code !== 0) {
    try {
      return JSON.parse(res.stdout);
    } catch (err) {
      console.error('Error parsing npm audit output:', res.stdout);
      throw err;
    }
  }
  // npm audit didn't found any security advisories.
  return null;
}

const blockingIssues = [];
const ignoredIssues = [];
let auditReport = getNpmAuditJSON();

if (auditReport) {
  const cmdres = shell.cat('.nsprc');
  const {exceptions} = JSON.parse(stripJsonComments(cmdres.stdout));

  if (auditReport.error) {
    if (auditReport.error.code === 'ENETUNREACH') {
      console.log('npm was not able to reach the api endpoint:', auditReport.error.summary);
      console.log('Retrying...');
      auditReport = getNpmAuditJSON();
    }

    // If the error code is not ENETUNREACH or it fails again after a single retry
    // just log the audit error and exit with error code 2.
    if (auditReport.error) {
      console.error('npm audit error:', auditReport.error);
      process.exit(2);
    }
  }

  for (const advId of Object.keys(auditReport.advisories)) {
    const adv = auditReport.advisories[advId];

    if (exceptions.includes(adv.url)) {
      ignoredIssues.push(adv);
      continue;
    }
    blockingIssues.push(adv);
  }
}

// Reporting.

function formatFinding(desc) {
  const details = `(dev: ${desc.dev}, optional: ${desc.optional}, bundled: ${desc.bundled})`;
  return `${desc.version} ${details}\n    ${desc.paths.join('\n    ')}`;
}

function formatAdvisory(adv) {
  const findings = adv.findings.map(formatFinding).map((msg) => `  ${msg}`).join('\n');
  return `${adv.module_name} (${adv.url}):\n${findings}`;
}

if (ignoredIssues.length > 0) {
  console.log('\n== audit-deps: ignored security issues (based on .nsprc exceptions)\n');

  for (const adv of ignoredIssues) {
    console.log(formatAdvisory(adv));
  }
}

if (blockingIssues.length > 0) {
  console.log('\n== audit-deps: blocking security issues\n');

  for (const adv of blockingIssues) {
    console.log(formatAdvisory(adv));
  }

  // Exit with error if blocking security issues has been found.
  process.exit(1);
}
