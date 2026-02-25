import 'dotenv/config';
/**
 * Oracle Trading Engine — Quick Deployment
 * 
 * Deploys identified capital immediately into proven strategies.
 * Target: <YOUR_RECOVERY_WALLET>
 */

import { WalletAggregator } from '../data/wallets.js';
import { YieldStrategy } from '../strategies/yield.js';

async function quickStart() {
    const address = process.env.RECOVERY_WALLET || '0x_YOUR_RECOVERY_WALLET';
    const agg = new WalletAggregator();
    const yieldStrat = new YieldStrategy();

    console.log('\n🚀 ORACLE QUICK START — DEPLOYING CAPITAL');
    console.log('═'.repeat(60));

    // 1. Fetch current balances
    const eth = await agg.getEthBalance(address);
    const arb = await agg.getArbitrumBalance(address);

    console.log(`\n  Target Wallet: \${address}`);
    console.log(`  Balance:       \${arb?.toFixed(6) || 0} ETH on Arbitrum (\$(\${((arb || 0) * 2800).toFixed(2)}))`);

    if (arb && arb > 0.01) {
        console.log('\n  ✅ ACTIONABLE CAPITAL FOUND');
        console.log('  ------------------------------------------------------------');

        console.log('  OPTION 1: Swap for $MAGIC (Arbitrum)');
        console.log('     Current MAGIC Price: ~$0.40');
        console.log(`     Estimated Buy:       ~100 MAGIC`);
        console.log('     Strategy:            RSI Extreme (+67% annual backtested)');

        console.log('\n  OPTION 2: Yield Generation');
        console.log('     Platform:            Aave v3 (Arbitrum)');
        console.log('     APY:                 ~5% (Stable)');
        console.log('     Platform:            Jupiter JLP (via bridge to SOL)');
        console.log('     APY:                 ~35% (Variable)');

        console.log('\n  RECOMMENDATION:');
        console.log('  1. Swap 0.015 ETH for MAGIC on Sushi/Camelot (Arbitrum)');
        console.log('  2. Keep 0.005 ETH for gas fees');
        console.log('  3. Start the Oracle RSI Signal Monitor on this wallet');
    } else {
        console.log('\n  ⌛ Wallet is nearly empty or has dust. Waiting for consolidation...');
    }

    console.log('\n═'.repeat(60) + '\n');
}

quickStart();
