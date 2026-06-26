#!/usr/bin/env node

/**
 * Migration Drift Check Script
 * 
 * Detects drift between backend/migrations and supabase/migrations folders,
 * and optionally verifies applied migrations against the database.
 * 
 * Usage:
 *   node scripts/check-migration-drift.js                             # File-only check
 *   node scripts/check-migration-drift.js --verify-db                 # File + database verification
 *   node scripts/check-migration-drift.js --json                      # JSON output format
 *   node scripts/check-migration-drift.js --verify-db --json          # DB verification with JSON output
 *   node scripts/check-migration-drift.js --verify-db --env local     # Label output as local environment
 *   node scripts/check-migration-drift.js --verify-db --env ci-remote # Label output as CI remote environment
 * 
 * Environment variables (for --verify-db):
 *   SUPABASE_URL: Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY: Service role key for database access
 *   DATABASE_URL: Optional direct Postgres connection string (overrides Supabase)
 * 
 * Exit codes:
 *   0 - No drift detected
 *   1 - Drift detected (conflicts or duplicates found)
 *   2 - Error occurred
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Configuration
const BACKEND_MIGRATIONS = path.join(__dirname, '..', 'backend', 'migrations');
const SUPABASE_MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations');

// Parse command-line arguments
const args = process.argv.slice(2);
const envIdx = args.indexOf('--env');
const options = {
  verifyDb: args.includes('--verify-db'),
  json: args.includes('--json'),
  env: envIdx >= 0 && args[envIdx + 1] ? args[envIdx + 1] : 'unknown'
};

// ─────────────────────────────────────────────────────────────────────────────
// Database Query Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a SQL query against Supabase via REST API
 * @param {string} query - SQL query to execute
 * @param {string} supabaseUrl - Supabase project URL
 * @param {string} supabaseKey - Service role key
 * @returns {Promise<Object>} Query result
 */
async function executeSupabaseQuery(query, supabaseUrl, supabaseKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const url = new URL(`${supabaseUrl}/rest/v1/rpc/exec_sql`);
    
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Query failed: ${parsed.message || data}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Fetch applied migrations from database
 * @param {string} supabaseUrl - Supabase project URL
 * @param {string} supabaseKey - Service role key
 * @returns {Promise<Array>} List of applied migrations
 */
async function getAppliedMigrations(supabaseUrl, supabaseKey) {
  try {
    const result = await executeSupabaseQuery(
      `SELECT name, executed_at FROM supabase_migrations_history ORDER BY name ASC`,
      supabaseUrl,
      supabaseKey
    );
    return (result || []).map(row => ({
      name: row.name || row.Name || row[0],
      executedAt: row.executed_at || row.ExecutedAt || row[1]
    }));
  } catch (err) {
    throw new Error(`Failed to fetch migration history: ${err.message}`);
  }
}

// Normalize SQL content for comparison (remove comments, whitespace, case)
function normalizeSQL(content) {
  return content
    .replace(/--.*$/gm, '') // Remove single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
    .replace(/\s+/g, ' ') // Normalize whitespace
    .toLowerCase()
    .trim();
}

// Extract table names from SQL content
function extractTables(sql) {
  const tableRegex = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)/gi;
  const alterRegex = /alter\s+table\s+(?:only\s+)?(?:public\.)?(\w+)/gi;
  const tables = new Set();
  
  let match;
  while ((match = tableRegex.exec(sql)) !== null) {
    tables.add(match[1].toLowerCase());
  }
  while ((match = alterRegex.exec(sql)) !== null) {
    tables.add(match[1].toLowerCase());
  }
  
  return tables;
}

// Extract index names from SQL content
function extractIndexes(sql) {
  const indexRegex = /create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?(\w+)/gi;
  const indexes = new Set();
  
  let match;
  while ((match = indexRegex.exec(sql)) !== null) {
    indexes.add(match[1].toLowerCase());
  }
  
  return indexes;
}

// Extract policy names from SQL content
function extractPolicies(sql) {
  const policyRegex = /create\s+policy\s+(\w+)/gi;
  const policies = new Set();
  
  let match;
  while ((match = policyRegex.exec(sql)) !== null) {
    policies.add(match[1].toLowerCase());
  }
  
  return policies;
}

// Read all migration files from a directory
function readMigrations(dir) {
  const migrations = new Map();
  
  if (!fs.existsSync(dir)) {
    console.warn(`Warning: Directory does not exist: ${dir}`);
    return migrations;
  }
  
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    migrations.set(file, {
      content,
      normalized: normalizeSQL(content),
      tables: extractTables(content),
      indexes: extractIndexes(content),
      policies: extractPolicies(content)
    });
  }
  
  return migrations;
}

// Compare two migration contents
function compareMigrations(name1, m1, name2, m2) {
  const issues = [];
  
  // Check if normalized content is identical
  if (m1.normalized === m2.normalized) {
    issues.push({
      type: 'duplicate',
      severity: 'error',
      message: `Identical migrations: "${name1}" and "${name2}"`,
      files: [name1, name2]
    });
  } else {
    // Check for table overlap with different content
    const commonTables = [...m1.tables].filter(t => m2.tables.has(t));
    if (commonTables.length > 0) {
      issues.push({
        type: 'conflict',
        severity: 'warning',
        message: `Common tables in different migrations: "${name1}" and "${name2}" affect tables: ${commonTables.join(', ')}`,
        files: [name1, name2],
        tables: commonTables
      });
    }
  }
  
  return issues;
}

// Main drift detection function
function detectDrift() {
  if (!options.json) {
    console.log(`🔍 Checking migration drift between backend and supabase... [env: ${options.env}]\n`);
  }
  
  const backendMigrations = readMigrations(BACKEND_MIGRATIONS);
  const supabaseMigrations = readMigrations(SUPABASE_MIGRATIONS);
  
  const issues = [];
  const analyzed = new Set();
  
  // Compare each backend migration with supabase migrations
  for (const [backendFile, backendData] of backendMigrations) {
    for (const [supabaseFile, supabaseData] of supabaseMigrations) {
      const pairKey = [backendFile, supabaseFile].sort().join('|');
      if (analyzed.has(pairKey)) continue;
      analyzed.add(pairKey);
      
      // Check for similar filenames (potential duplicates)
      const backendBase = backendFile.replace(/^\d+_/, '').replace('.sql', '');
      const supabaseBase = supabaseFile.replace(/^\d+_/, '').replace('.sql', '');
      
      if (backendBase === supabaseBase || 
          backendFile.includes(supabaseBase) || 
          supabaseFile.includes(backendBase)) {
        const comparisonIssues = compareMigrations(backendFile, backendData, supabaseFile, supabaseData);
        issues.push(...comparisonIssues);
      }
    }
  }
  
  // Check for table conflicts across all migrations
  const allBackendTables = new Map();
  const allSupabaseTables = new Map();
  
  for (const [file, data] of backendMigrations) {
    for (const table of data.tables) {
      if (!allBackendTables.has(table)) {
        allBackendTables.set(table, []);
      }
      allBackendTables.get(table).push(file);
    }
  }
  
  for (const [file, data] of supabaseMigrations) {
    for (const table of data.tables) {
      if (!allSupabaseTables.has(table)) {
        allSupabaseTables.set(table, []);
      }
      allSupabaseTables.get(table).push(file);
    }
  }
  
  // Report findings
  if (!options.json) {
    console.log('=== Migration Analysis ===\n');
    console.log(`Backend migrations: ${backendMigrations.size} files`);
    console.log(`Supabase migrations: ${supabaseMigrations.size} files\n`);
  }
  
  if (issues.length === 0) {
    if (!options.json) {
      console.log('✅ No migration drift detected.');
      console.log('\n--- Summary ---');
      console.log(`Total backend tables: ${allBackendTables.size}`);
      console.log(`Total supabase tables: ${allSupabaseTables.size}`);
    }
    return { 
      success: true, 
      issues: [],
      fileCheck: {
        backendCount: backendMigrations.size,
        supabaseCount: supabaseMigrations.size,
        backendTableCount: allBackendTables.size,
        supabaseTableCount: allSupabaseTables.size
      }
    };
  }
  
  // Group issues by type
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  
  if (!options.json) {
    if (errors.length > 0) {
      console.log('❌ ERRORS (must fix):\n');
      for (const issue of errors) {
        console.log(`  [${issue.type.toUpperCase()}] ${issue.message}`);
      }
      console.log('');
    }
    
    if (warnings.length > 0) {
      console.log('⚠️  WARNINGS (review recommended):\n');
      for (const issue of warnings) {
        console.log(`  [${issue.type.toUpperCase()}] ${issue.message}`);
      }
      console.log('');
    }
    
    console.log('\n--- Recommendations ---');
    console.log('1. Review duplicate migrations and consolidate them');
    console.log('2. Ensure all schema changes go through a single migration path');
    console.log('3. Use either backend/migrations OR supabase/migrations, not both');
    console.log('4. Run this check in CI to prevent drift');
  }
  
  return { 
    success: errors.length === 0, 
    issues,
    fileCheck: {
      backendCount: backendMigrations.size,
      supabaseCount: supabaseMigrations.size,
      backendTableCount: allBackendTables.size,
      supabaseTableCount: allSupabaseTables.size,
      errors: errors.length,
      warnings: warnings.length
    }
  };
}

/**
 * Verify database state against filesystem migrations
 * @returns {Promise<Object>} Database verification result
 */
async function verifyDatabaseState() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    const msg = 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables required for --verify-db';
    if (options.json) {
      return { 
        success: false, 
        error: msg,
        dbCheck: null
      };
    }
    throw new Error(msg);
  }
  
  try {
    const appliedMigrations = await getAppliedMigrations(supabaseUrl, supabaseKey);
    const appliedNames = new Set(appliedMigrations.map(m => m.name));
    
    // Get all filesystem migrations
    const backendMigrations = readMigrations(BACKEND_MIGRATIONS);
    const supabaseMigrations = readMigrations(SUPABASE_MIGRATIONS);
    const allFileSystemMigrations = new Set([
      ...backendMigrations.keys(),
      ...supabaseMigrations.keys()
    ]);
    
    const dbIssues = [];
    
    // Check for migrations in database but not in filesystem
    for (const appliedMigration of appliedMigrations) {
      if (!allFileSystemMigrations.has(appliedMigration.name)) {
        dbIssues.push({
          type: 'orphaned_migration',
          severity: 'warning',
          message: `Migration in database but not in filesystem: "${appliedMigration.name}"`,
          migration: appliedMigration.name,
          executedAt: appliedMigration.executedAt
        });
      }
    }
    
    // Check for migrations in filesystem but not in database
    for (const fileMigration of allFileSystemMigrations) {
      if (!appliedNames.has(fileMigration)) {
        dbIssues.push({
          type: 'unapplied_migration',
          severity: 'warning',
          message: `Migration in filesystem but not applied to database: "${fileMigration}"`,
          migration: fileMigration
        });
      }
    }
    
    if (!options.json) {
      if (dbIssues.length === 0) {
        console.log('✅ Database migration state matches filesystem.');
        console.log(`Applied migrations: ${appliedMigrations.length}`);
      } else {
        console.log('\n=== Database Verification Issues ===\n');
        for (const issue of dbIssues) {
          console.log(`  [${issue.type.toUpperCase()}] ${issue.message}`);
        }
      }
    }
    
    return {
      success: dbIssues.filter(i => i.severity === 'error').length === 0,
      dbCheck: {
        appliedCount: appliedMigrations.length,
        filesystemCount: allFileSystemMigrations.size,
        issues: dbIssues,
        appliedMigrations: appliedMigrations.map(m => ({ name: m.name, executedAt: m.executedAt }))
      }
    };
  } catch (err) {
    const msg = `Database verification failed: ${err.message}`;
    if (!options.json) {
      console.error(`⚠️  ${msg}`);
      console.error('Proceeding with file-level checks only.');
    }
    return {
      success: true,
      dbCheck: { error: msg, appliedCount: 0, filesystemCount: 0 }
    };
  }
}

// Run the check
async function main() {
  try {
    const fileCheckResult = detectDrift();
    
    let dbCheckResult = null;
    if (options.verifyDb) {
      dbCheckResult = await verifyDatabaseState();
    }
    
    // Determine overall success
    const fileSuccess = fileCheckResult.success;
    const dbSuccess = dbCheckResult ? dbCheckResult.success : true;
    const overallSuccess = fileSuccess && dbSuccess;
    
    // Output JSON if requested
    if (options.json) {
      const output = {
        success: overallSuccess,
        env: options.env,
        fileCheck: fileCheckResult.fileCheck,
        dbCheck: dbCheckResult?.dbCheck || null,
        issues: fileCheckResult.issues
      };
      console.log(JSON.stringify(output, null, 2));
    } else if (!overallSuccess && !options.json) {
      console.log('\n❌ Migration drift detected! Please fix the issues above.');
      if (options.verifyDb) {
        console.log('\nFor remediation guidance, see docs/MIGRATION_REMEDIATION.md');
      }
    }
    
    process.exit(overallSuccess ? 0 : 1);
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({
        success: false,
        error: err.message
      }, null, 2));
    } else {
      console.error(`\n❌ Error: ${err.message}`);
    }
    process.exit(2);
  }
}

main();