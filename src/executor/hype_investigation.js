import fetch from 'node-fetch';

/**
 * hype_investigation.js
 * 🔍 THE HYPE SENTINEL: Investigation Module
 * 
 * Audits tokens for 'Blue-Chip' status:
 * - Liquidity > $1M
 * - Pair Age > 30 Days
 * - Volume Multiplier
 */

const MIN_LIQUIDITY = 1000000; // $1M
const MIN_AGE_DAYS = 30;

async function investigateToken(address) {
    console.log(`--- 🔍 INVESTIGATING: ${address} ---`);
    const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (!data.pairs || data.pairs.length === 0) {
            console.log('  ❌ No liquidity found on major DEXs.');
            return { isBlueChip: false, reason: 'No Liquid Pairs' };
        }

        const bestPair = data.pairs[0];
        const liquidity = bestPair.liquidity?.usd || 0;
        const createdAt = bestPair.pairCreatedAt || Date.now();
        const ageInDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);

        console.log(`  💧 Liquidity: $${Math.round(liquidity).toLocaleString()}`);
        console.log(`  ⏳ Pair Age:  ${Math.round(ageInDays)} days`);
        console.log(`  📊 24h Volume: $${Math.round(bestPair.volume?.h24 || 0).toLocaleString()}`);

        const isLiquidityPass = liquidity >= MIN_LIQUIDITY;
        const isAgePass = ageInDays >= MIN_AGE_DAYS;

        if (isLiquidityPass && isAgePass) {
            console.log('  ✅ VERDICT: BLUE-CHIP QUALITY DETECTED');
            return { isBlueChip: true, data: bestPair };
        } else {
            const reason = !isLiquidityPass ? 'Low Liquidity' : 'Fresh Token (High Risk)';
            console.log(`  ⚠️  VERDICT: REJECTED (${reason})`);
            return { isBlueChip: false, reason };
        }

    } catch (e) {
        console.log('  ❌ Investigation Failed:', e.message);
        return { isBlueChip: false, reason: 'API Error' };
    }
}

// Example: Wrapped SOL (Blue Chip Test)
if (import.meta.url === `file://${process.argv[1]}`) {
    investigateToken('So11111111111111111111111111111111111111112');
}

export { investigateToken };
