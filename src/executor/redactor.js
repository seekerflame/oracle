/**
 * 🛡️ GEP_002: REDACTOR PROXY
 * 
 * Automates the sanitization of mission-critical blueprints.
 * Strips PII, local paths, and institutional markers before global seeding.
 */

import fs from 'fs';
import path from 'path';

const SOURCE_DIRS = [
    '/Users/eternalflame/Eternal-Stack/projects/OSE/abundancetoken/07_Code/The_Ark/docs',
    '/Users/eternalflame/Eternal-Stack/projects/OSE/abundancetoken/07_Code/The_Ark/core',
    '/Users/eternalflame/Eternal-Stack/projects/OSE/abundancetoken/07_Code/The_Ark/api',
    '/Users/eternalflame/Eternal-Stack/archive/Antigrav_SSD_Backup/OSE/theArk'
];

const EXPORT_ROOT = '/Users/eternalflame/Eternal-Stack/export/spore_001';

const REDACTION_RULES = [
    { pattern: /\/Users\/eternalflame\//g, replacement: '/NODE_ROOT/' },
    { pattern: /eternalflame/gi, replacement: 'CHRONICLER' },
    { pattern: /Rudy's Hot Dogs/g, replacement: 'MERC_NODE_ALPHA' },
    { pattern: /Rudy/g, replacement: 'MERC_ALPHA' },
    { pattern: /CSUB/g, replacement: 'REDACTED_INSTITUTE' },
    { pattern: /127\.0\.0\.1/g, replacement: 'node.local' },
    { pattern: /localhost/g, replacement: 'node.local' },
    { pattern: /dagny/gi, replacement: 'MERC_BETA' },
    { pattern: /Marcin/gi, replacement: 'FOUNDER_ALPHA' },
    { pattern: /Vibecraft/gi, replacement: 'SIM_ENVIRONMENT' }
];

function sanitize(content) {
    let sanitized = content;
    REDACTION_RULES.forEach(rule => {
        sanitized = sanitized.replace(rule.pattern, rule.replacement);
    });
    return sanitized;
}

function processDir(dir) {
    if (!fs.existsSync(dir)) return;
    const items = fs.readdirSync(dir);

    items.forEach(item => {
        const fullPath = path.join(dir, item);
        if (!fs.existsSync(fullPath)) return; // Robustness: skip if file disappeared or is broken symlink
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            processDir(fullPath);
        } else if (['.md', '.js', '.py', '.json'].includes(path.extname(fullPath))) {
            const content = fs.readFileSync(fullPath, 'utf8');
            const sanitized = sanitize(content);

            // Generate output path based on original filename to prevent collisions
            const baseName = path.basename(fullPath);
            const relativeDir = path.relative('/Users/eternalflame/Eternal-Stack/', dir);
            const outputPath = path.join(EXPORT_ROOT, relativeDir, baseName);

            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, sanitized);
            console.log(`✅ Sanitize & Export: ${outputPath}`);
        }
    });
}

console.log('--- 🛡️ GEP_002: REDACTOR STARTING ---');
SOURCE_DIRS.forEach(processDir);
console.log('--- ✅ REDACTION COMPLETE: spore_001 ready at', EXPORT_ROOT, '---');
