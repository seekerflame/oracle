import { checkGas } from './gas_sentinel.js';
import { runHypeTrace } from './hype_tracer.js';

/**
 * heartbeat.js
 * 💓 THE ORACLE HEARTBEAT
 * 
 * Periodically executes monitoring and discovery tasks.
 */

const INTERVAL_MS = 1000 * 60 * 15; // 15 Minutes

async function pulse() {
    console.log(`\n--- 💓 HEARTBEAT PULSE: ${new Date().toISOString()} ---`);

    // 1. Gas Check
    console.log('Checking Fuel Levels...');
    const isFueled = await checkGas();

    // 2. Hype Trace
    console.log('Running Hype Sentinel Trace...');
    await runHypeTrace();

    console.log('--- 💓 PULSE COMPLETE ---\n');
}

// Initial pulse
pulse();

// Interval
setInterval(pulse, INTERVAL_MS);

export { pulse };
