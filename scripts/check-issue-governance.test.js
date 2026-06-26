#!/usr/bin/env node

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  EXPECTED_LABELS,
  parseLabelsYaml,
  checkLabels,
  checkTriagePolicy,
  checkTemplates
} = require('./check-issue-governance');

describe('check-issue-governance', () => {
  describe('parseLabelsYaml', () => {
    it('correctly parses a formatted list of labels', () => {
      const yaml = `
# Some comments
- name: "area/test"
  color: "123456"
  description: "Test description"

- name: "priority/P1"
  color: "ffffff"
  description: "High priority"
`;
      const parsed = parseLabelsYaml(yaml);
      assert.equal(parsed.length, 2);
      assert.deepEqual(parsed[0], {
        name: 'area/test',
        color: '123456',
        description: 'Test description'
      });
      assert.deepEqual(parsed[1], {
        name: 'priority/P1',
        color: 'ffffff',
        description: 'High priority'
      });
    });

    it('handles comments and whitespace', () => {
      const yaml = `
# Comment at top

- name: "status/test"
  # inline comment
  color: "000000"
  description: "Status test description"
`;
      const parsed = parseLabelsYaml(yaml);
      assert.equal(parsed.length, 1);
      assert.deepEqual(parsed[0], {
        name: 'status/test',
        color: '000000',
        description: 'Status test description'
      });
    });
  });

  describe('validates actual repository configuration', () => {
    it('labels.yml contains all expected labels with valid properties', () => {
      const errors = checkLabels();
      assert.deepEqual(errors, [], `Expected no errors in labels.yml, but got: ${errors.join(', ')}`);
    });

    it('issue-triage-policy.md contains all required sections and keywords', () => {
      const errors = checkTriagePolicy();
      assert.deepEqual(errors, [], `Expected no errors in issue-triage-policy.md, but got: ${errors.join(', ')}`);
    });

    it('issue templates have correct default labels and taxonomy references', () => {
      const errors = checkTemplates();
      assert.deepEqual(errors, [], `Expected no errors in issue templates, but got: ${errors.join(', ')}`);
    });
  });
});
