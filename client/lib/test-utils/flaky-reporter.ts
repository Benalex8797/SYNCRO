import type {
  Reporter,
  TestCase,
  TestResult,
  FullResult,
} from '@playwright/test/reporter';
import * as fs from 'fs';
import * as path from 'path';

interface FlakyTestRecord {
  testName: string;
  projectName: string;
  failures: number;
  totalRuns: number;
  lastFailure: string;
  flakeRate: number;
  status: 'stable' | 'flaky' | 'investigating';
  firstSeen?: string;
  triageStatus?: 'new' | 'acknowledged' | 'investigating' | 'resolved';
}

interface TriageGuidance {
  severity: 'critical' | 'warning' | 'info';
  recommendation: string;
  debugSteps: string[];
}

class FlakyReporter implements Reporter {
  private flakyTests: Map<string, FlakyTestRecord> = new Map();
  private outputPath = path.join(process.cwd(), 'test-results', 'flaky-tests.json');
  private triagePath = path.join(process.cwd(), 'test-results', 'flaky-triage.json');
  private isCI = process.env.CI === 'true';

  onBegin() {
    // Load existing flaky test data if available
    if (fs.existsSync(this.outputPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.outputPath, 'utf-8'));
        this.flakyTests = new Map(Object.entries(data));
      } catch (error) {
        console.warn('Failed to load existing flaky test data:', error);
      }
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const testKey = `${test.parent.project()?.name || 'unknown'}:${test.titlePath().join(' > ')}`;
    const record = this.flakyTests.get(testKey) || {
      testName: test.titlePath().join(' > '),
      projectName: test.parent.project()?.name || 'unknown',
      failures: 0,
      totalRuns: 0,
      lastFailure: '',
      flakeRate: 0,
      status: 'stable' as const,
      firstSeen: new Date().toISOString(),
      triageStatus: 'new' as const,
    };

    record.totalRuns++;

    // Check if test failed or was retried
    if (result.status === 'failed' || result.status === 'timedOut') {
      record.failures++;
      record.lastFailure = new Date().toISOString();
    }

    // Calculate flake rate
    record.flakeRate = record.failures / record.totalRuns;

    // Update status based on flake rate
    if (record.flakeRate > 0.3 && record.totalRuns >= 10) {
      record.status = 'flaky';
    } else if (record.flakeRate === 0 && record.totalRuns >= 20) {
      record.status = 'stable';
    }

    this.flakyTests.set(testKey, record);
  }

  private generateTriageGuidance(record: FlakyTestRecord): TriageGuidance {
    const severity = record.flakeRate > 0.5 ? 'critical' : record.flakeRate > 0.3 ? 'warning' : 'info';
    
    const debugSteps = [
      'Review test logs for timing-related failures',
      'Check for race conditions in test setup/teardown',
      'Verify external service dependencies are stable',
      'Consider adding explicit waits for dynamic content',
      'Review recent code changes that might affect test',
    ];

    return {
      severity,
      recommendation: `This test has a ${(record.flakeRate * 100).toFixed(1)}% flake rate (${record.failures}/${record.totalRuns} failures). Priority: ${severity === 'critical' ? 'HIGH' : severity === 'warning' ? 'MEDIUM' : 'LOW'}`,
      debugSteps,
    };
  }

  private generateMarkdownReport(flakyTestsArray: FlakyTestRecord[]): string {
    const critical = flakyTestsArray.filter((t) => t.flakeRate > 0.5);
    const warning = flakyTestsArray.filter((t) => t.flakeRate >= 0.3 && t.flakeRate <= 0.5);

    let markdown = '# Flaky Test Report\n\n';
    markdown += `Generated: ${new Date().toISOString()}\n\n`;

    if (critical.length > 0) {
      markdown += '## 🔴 Critical Flaky Tests (>50% flake rate)\n\n';
      critical.forEach((test) => {
        const guidance = this.generateTriageGuidance(test);
        markdown += `### ${test.testName}\n`;
        markdown += `- **Project**: ${test.projectName}\n`;
        markdown += `- **Flake Rate**: ${(test.flakeRate * 100).toFixed(1)}% (${test.failures}/${test.totalRuns} failures)\n`;
        markdown += `- **Last Failure**: ${test.lastFailure}\n`;
        markdown += `- **Triage Status**: ${test.triageStatus || 'new'}\n`;
        markdown += `- **Recommendation**: ${guidance.recommendation}\n`;
        markdown += `- **Debug Steps**:\n`;
        guidance.debugSteps.forEach((step) => {
          markdown += `  - ${step}\n`;
        });
        markdown += '\n';
      });
    }

    if (warning.length > 0) {
      markdown += '## 🟡 Warning Flaky Tests (30-50% flake rate)\n\n';
      warning.forEach((test) => {
        const guidance = this.generateTriageGuidance(test);
        markdown += `### ${test.testName}\n`;
        markdown += `- **Project**: ${test.projectName}\n`;
        markdown += `- **Flake Rate**: ${(test.flakeRate * 100).toFixed(1)}% (${test.failures}/${test.totalRuns} failures)\n`;
        markdown += `- **Last Failure**: ${test.lastFailure}\n`;
        markdown += `- **Triage Status**: ${test.triageStatus || 'new'}\n`;
        markdown += `- **Recommendation**: ${guidance.recommendation}\n`;
        markdown += '\n';
      });
    }

    return markdown;
  }

  onEnd(result: FullResult) {
    // Ensure output directory exists
    const outputDir = path.dirname(this.outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Save flaky test data
    const data = Object.fromEntries(this.flakyTests);
    fs.writeFileSync(this.outputPath, JSON.stringify(data, null, 2));

    // Generate triage data
    const flakyTestsArray = Array.from(this.flakyTests.values())
      .filter((record) => record.status === 'flaky')
      .sort((a, b) => b.flakeRate - a.flakeRate);

    const triageData = {
      timestamp: new Date().toISOString(),
      totalFlakyTests: flakyTestsArray.length,
      critical: flakyTestsArray.filter((t) => t.flakeRate > 0.5).length,
      warning: flakyTestsArray.filter((t) => t.flakeRate >= 0.3 && t.flakeRate <= 0.5).length,
      tests: flakyTestsArray.map((test) => ({
        ...test,
        guidance: this.generateTriageGuidance(test),
      })),
    };

    fs.writeFileSync(this.triagePath, JSON.stringify(triageData, null, 2));

    // Generate markdown report for CI artifacts
    if (flakyTestsArray.length > 0) {
      const markdownReport = this.generateMarkdownReport(flakyTestsArray);
      const reportPath = path.join(outputDir, 'flaky-tests-report.md');
      fs.writeFileSync(reportPath, markdownReport);

      console.log('\n⚠️  Flaky Tests Detected:\n');
      
      const critical = flakyTestsArray.filter((t) => t.flakeRate > 0.5);
      const warning = flakyTestsArray.filter((t) => t.flakeRate >= 0.3 && t.flakeRate <= 0.5);

      if (critical.length > 0) {
        console.log('🔴 Critical (>50% flake rate):');
        critical.forEach((test) => {
          console.log(
            `  - [${test.projectName}] ${test.testName} - ${(test.flakeRate * 100).toFixed(1)}% (${test.failures}/${test.totalRuns} failures)`
          );
        });
        console.log('');
      }

      if (warning.length > 0) {
        console.log('🟡 Warning (30-50% flake rate):');
        warning.forEach((test) => {
          console.log(
            `  - [${test.projectName}] ${test.testName} - ${(test.flakeRate * 100).toFixed(1)}% (${test.failures}/${test.totalRuns} failures)`
          );
        });
        console.log('');
      }

      console.log(`Full report saved to: ${this.outputPath}`);
      console.log(`Triage data saved to: ${this.triagePath}`);
      console.log(`Markdown report saved to: ${reportPath}\n`);

      // In CI, fail if critical flaky tests exist
      if (this.isCI && critical.length > 0) {
        console.error('❌ CI FAILURE: Critical flaky tests detected. Please investigate and fix.');
        process.exit(1);
      }
    }
  }
}

export default FlakyReporter;
