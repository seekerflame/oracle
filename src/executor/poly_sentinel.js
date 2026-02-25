import 'dotenv/config';
import fetch from 'node-fetch';

/**
 * poly_sentinel.js
 * 🛡️ SENTINEL TRACER: Geopolitical Alpha tracking.
 *
 * Targeting the high-asymmetry markets identified in the Geopolitical Hunt.
 */

const PRECISION_TARGETS = [
    { id: '1301544', question: 'U.S. evacuates Baghdad Embassy by February 28?', tag: 'BAGHDAD' },
    { id: '1277921', question: 'Will Israel strike Gaza on Feb 20?', tag: 'GAZA_STRIKE' },
];

const SENTINELS = [
    { name: 'KennedyG', desc: 'Staff movement scout (High Alpha)', address: '0x(ExtractedFromComments)' },
    { name: 'ImJustKen', desc: 'Consistent strike/evacuation whale' },
    { name: 'betwick', desc: 'Top holder: Israel-Iran Conflict' },
    { name: 'beachboy4', desc: 'Top 10 Global P&L regular' },
];

const ALPHA_KEYWORDS = ['staff movement', 'evacuation started', 'classified', 'movement', 'empty'];

async function trackAlpha() {
    console.log('--- 🛡️ SENTINEL TRACER: ALPHA MODE ---');
    console.log(`  Tracking ${SENTINELS.length} Sentinels for ${ALPHA_KEYWORDS.join(', ')} triggers...`);

    // ... (rest of the logic remains targeted at IDs 1301544 and 1277921)

    for (const target of PRECISION_TARGETS) {
        try {
            const url = `https://gamma-api.polymarket.com/markets?id=${target.id}`;
            const resp = await fetch(url);
            const data = await resp.json();

            if (data && data.length > 0) {
                const m = data[0];
                let prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
                const yes = (parseFloat(prices[0]) * 100).toFixed(1);
                const vol = Math.floor(m.volume24hr || 0);

                console.log(`\n  📍 [${target.tag}] ${m.question}`);
                console.log(`     Current Odds: ${yes}% | 24h Vol: $${vol}`);

                if (yes < 5) {
                    console.log('     ⚠️  SENTINEL SIGNAL: Extreme low odds. (ASYMMETRIC MOONSHOT)');
                } else if (yes > 40 && yes < 60) {
                    console.log('     ⚖️  SITUATION HEATING: High-conviction coinflip.');
                }

                if (vol > 100000) {
                    console.log('     🔥  WHALE ALERT: Heavy capital incoming.');
                }
            }
        } catch (e) {
            console.log(`     ❌ Failed to track ${target.tag}: ${e.message}`);
        }
    }
}

trackAlpha();
