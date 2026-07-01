#!/usr/bin/env node

/**
 * Validates repository issue governance, triage policy, and labels taxonomy.
 * Fails CI if label definitions, triage policies, or templates drift from the taxonomy.
 *
 * Usage: node scripts/check-issue-governance.js
 * Exit code: 0 if valid, 1 if invalid
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

const EXPECTED_LABELS = [
  // Areas
  'area/client',
  'area/backend',
  'area/contracts',
  'area/supabase',
  'area/sdk',
  'area/shared',
  'area/docs',
  'area/scripts',
  'area/governance',
  'area/ops',
  // Priorities
  'priority/P0',
  'priority/P1',
  'priority/P2',
  'priority/P3',
  // Types
  'type/bug',
  'type/feature',
  'type/refactor',
  'type/chore',
  'type/security',
  'type/documentation',
  'type/performance',
  // Risks
  'risk/low',
  'risk/medium',
  'risk/high',
  // Statuses
  'status/triage',
  'status/backlog',
  'status/in-progress',
  'status/in-review',
  'status/blocked',
  'status/wontfix',
  'status/done'
];

function parseLabelsYaml(content) {
  const labels = [];
  const lines = content.split('\n');
  let currentLabel = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Handle YAML sequence item
    if (trimmed.startsWith('- name:')) {
      if (currentLabel) {
        labels.push(currentLabel);
      }
      const nameMatch = trimmed.match(/^- name:\s*"([^"]+)"/);
      if (nameMatch) {
        currentLabel = { name: nameMatch[1] };
      } else {
        currentLabel = { name: null };
      }
    } else if (currentLabel && trimmed.startsWith('color:')) {
      const colorMatch = trimmed.match(/^color:\s*"([^"]+)"/);
      if (colorMatch) {
        currentLabel.color = colorMatch[1];
      }
    } else if (currentLabel && trimmed.startsWith('description:')) {
      const descMatch = trimmed.match(/^description:\s*"([^"]+)"/);
      if (descMatch) {
        currentLabel.description = descMatch[1];
      }
    }
  }

  if (currentLabel) {
    labels.push(currentLabel);
  }

  return labels;
}

function checkLabels() {
  const errors = [];
  const labelsPath = path.join(REPO_ROOT, '.github', 'labels.yml');

  if (!fs.existsSync(labelsPath)) {
    return ['File .github/labels.yml does not exist'];
  }

  try {
    const content = fs.readFileSync(labelsPath, 'utf8');
    const parsed = parseLabelsYaml(content);
    const parsedNames = parsed.map(l => l.name);

    for (const expected of EXPECTED_LABELS) {
      if (!parsedNames.includes(expected)) {
        errors.push(`Missing expected label: "${expected}"`);
      }
    }

    for (const parsedLabel of parsed) {
      if (!parsedLabel.name) {
        errors.push('Found label entry with invalid or empty name');
        continue;
      }
      if (!parsedLabel.color) {
        errors.push(`Label "${parsedLabel.name}" is missing a color definition`);
      }
      if (!parsedLabel.description) {
        errors.push(`Label "${parsedLabel.name}" is missing a description`);
      }
    }
  } catch (err) {
    errors.push(`Failed to read/parse labels: ${err.message}`);
  }

  return errors;
}

function checkTriagePolicy() {
  const errors = [];
  const policyPath = path.join(REPO_ROOT, 'docs', 'issue-triage-policy.md');

  if (!fs.existsSync(policyPath)) {
    return ['File docs/issue-triage-policy.md does not exist'];
  }

  try {
    const content = fs.readFileSync(policyPath, 'utf8');

    // Check key requirements
    const requiredPhrases = [
      'intake',
      'grooming',
      'closure',
      'labels.yml',
      'docs/archive/'
    ];

    for (const phrase of requiredPhrases) {
      if (!content.toLowerCase().includes(phrase.toLowerCase())) {
        errors.push(`Triage policy lacks mention of "${phrase}"`);
      }
    }
  } catch (err) {
    errors.push(`Failed to read triage policy: ${err.message}`);
  }

  return errors;
}

function checkTemplates() {
  const errors = [];
  const templates = ['bug_report.md', 'feature_request.md'];

  for (const template of templates) {
    const templatePath = path.join(REPO_ROOT, '.github', 'ISSUE_TEMPLATE', template);

    if (!fs.existsSync(templatePath)) {
      errors.push(`Issue template .github/ISSUE_TEMPLATE/${template} does not exist`);
      continue;
    }

    try {
      const content = fs.readFileSync(templatePath, 'utf8');

      // Verify template frontmatter contains status/triage label
      if (!content.includes('status/triage')) {
        errors.push(`Template ${template} must specify default status/triage label in frontmatter`);
      }

      // Verify references to taxonomy in body
      if (!content.includes('Taxonomy (For Triagers)')) {
        errors.push(`Template ${template} should include the "Taxonomy (For Triagers)" checklist section`);
      }

      if (!content.includes('Area:') || !content.includes('Priority:') || !content.includes('Risk:')) {
        errors.push(`Template ${template} must prompt for Area, Priority, and Risk`);
      }
    } catch (err) {
      errors.push(`Failed to read template ${template}: ${err.message}`);
    }
  }

  return errors;
}

function main() {
  let allErrors = [];

  console.log('🔍 Checking issue governance and labels taxonomy...');

  const labelErrors = checkLabels();
  if (labelErrors.length > 0) {
    allErrors = allErrors.concat(labelErrors.map(e => `[Labels] ${e}`));
  }

  const policyErrors = checkTriagePolicy();
  if (policyErrors.length > 0) {
    allErrors = allErrors.concat(policyErrors.map(e => `[Policy] ${e}`));
  }

  const templateErrors = checkTemplates();
  if (templateErrors.length > 0) {
    allErrors = allErrors.concat(templateErrors.map(e => `[Templates] ${e}`));
  }

  if (allErrors.length > 0) {
    console.error('\n❌ Issue Governance validation failed:');
    for (const err of allErrors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log('\n✅ Issue Governance and Labels Taxonomy verified successfully!');
}

if (require.main === module) {
  main();
}

module.exports = {
  EXPECTED_LABELS,
  parseLabelsYaml,
  checkLabels,
  checkTriagePolicy,
  checkTemplates
};
