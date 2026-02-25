import { getTrending } from './hype_discovery.js';
import { investigateToken } from './hype_investigation.js';

/**
 * hype_tracer.js
 * 🛰️ THE HYPE SENTINEL: Main Orchestrator
 * 
 * Chains Discovery -> Investigation -> Risk Report
 */

async function runHypeTrace() {
    console.log('--- 🛰️ HYPE SENTINEL: FULL TRACE INITIATED ---');

    // 1. Discover Trending Tickers
    const trending = await getTrending();
    if (!trending || trending.length === 0) return;

    // 2. Resolve Addresses & Investigate
    console.log(`\n🔍 Scanning Top ${trending.length} Trending Assets for Blue-Chip quality...`);

    const gems = [];

    for (const item of trending.slice(0, 10)) {
        const coin = item.item;
        console.log(`\n  --- 📡 RESOLVING: ${coin.name} ($${coin.symbol}) ---`);

        try {
            // Search for the token on DexScreener to get the address
            const searchUrl = `https://api.dexscreener.com/latest/dex/search/?q=${coin.symbol}`;
            const sResp = await fetch(searchUrl);
            const sData = await sResp.json();

            if (sData.pairs && sData.pairs.length > 0) {
                // Find the pair with highest liquidity
                const topPair = sData.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
                const address = topPair.baseToken.address;

                // 3. Investigate if it's a Blue Chip
                const investigation = await investigateToken(address);
                if (investigation.isBlueChip) {
                    gems.push({ coin, investigation });
                }
            } else {
                console.log(`  ⚠️  No DEX pairs found for ${coin.symbol}.`);
            }
        } catch (e) {
            console.log(`  ❌ Resolution Failed for ${coin.symbol}: ${e.message}`);
        }
    }

    if (gems.length > 0) {
        console.log('\n--- 💎 HIGH CONVICTION GEMS DETECTED ---');
        gems.forEach(g => {
            console.log(`  ✅ ${g.coin.name} ($${g.coin.symbol}) | Liquidity: $${Math.round(g.investigation.data.liquidity.usd).toLocaleString()}`);
        });
    } else {
        console.log('\n--- 🛡️ SAFETY CHECK: No Trending Tokens passed the Blue-Chip filter. ---');
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    runHypeTrace();
}

export { runHypeTrace };
