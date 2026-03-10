import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { checkGas } from './gas_sentinel.js';

/**
 * eth_bet.js
 * 📈 ETH ABOVE $1,900 — Polymarket Bet Executor
 * 
 * Market: "Will the price of Ethereum be above $1,900 on February 28?"
 * Strategy: ETH is at ~$1,926. Betting YES that it stays above $1,900.
 *           At 73¢ per share, that's ~36% return if correct.
 * 
 * Usage:
 *   node src/executor/eth_bet.js            # Dry run (no real trade)
 *   node src/executor/eth_bet.js --live     # Execute real bet
 */

const ETH_PRIVATE_KEY = process.env.ETH_PRIVATE_KEY;

// Market data extracted from Polymarket (Feb 27, 2026)
const MARKET = {
    name: "ETH above $1,900 on Feb 28",
    conditionId: "0x9cda415a0435c393d6fe394d4ffa4e4fa1159ea34c2d5c9588f13599cdb8c771",
    yesTokenId: "55559893875147765223899271594309236365275784126856932718305325676867834654453",
    noTokenId: "46178921369589750187275200045353660284365455155659623341191422263903074916149",
    endDate: "2026-02-28T17:00:00Z",
    threshold: 1900, // ETH must be above this
};

const BET_AMOUNT = 10; // $10 USDC
const MAX_YES_PRICE = 0.80; // Don't buy above 80¢ (still need edge)

async function checkEthPrice() {
    try {
        const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
        const data = await resp.json();
        return data.ethereum.usd;
    } catch (e) {
        console.log('  ⚠️ Could not fetch ETH price, proceeding with caution');
        return null;
    }
}

async function executeBet(isLive = false) {
    console.log(`\n${'═'.repeat(55)}`);
    console.log(`📈 ETH BET EXECUTOR — ${isLive ? '🔴 LIVE' : '🧪 DRY RUN'}`);
    console.log(`${'═'.repeat(55)}`);
    console.log(`  Market: ${MARKET.name}`);
    console.log(`  Bet: $${BET_AMOUNT} on YES (ETH stays above $${MARKET.threshold})`);
    console.log(`  Max Price: ${MAX_YES_PRICE * 100}¢ per share`);
    console.log(`  Resolves: ${MARKET.endDate}`);
    console.log(`${'─'.repeat(55)}`);

    // 1. Check current ETH price
    const ethPrice = await checkEthPrice();
    if (ethPrice) {
        const buffer = ethPrice - MARKET.threshold;
        const bufferPct = (buffer / MARKET.threshold * 100).toFixed(2);
        console.log(`\n  📊 Current ETH: $${ethPrice.toFixed(2)}`);
        console.log(`  📊 Buffer above $${MARKET.threshold}: $${buffer.toFixed(2)} (${bufferPct}%)`);

        if (buffer < 0) {
            console.log(`  🚨 ETH ALREADY BELOW $${MARKET.threshold}! Bet would LOSE. Aborting.`);
            return;
        }
        if (buffer < 20) {
            console.log(`  ⚠️ WARNING: Only $${buffer.toFixed(2)} buffer. High risk.`);
        }
    }

    // 2. Gas check
    console.log('\n  ⛽ Checking gas...');
    const isFueled = await checkGas('POL');
    if (!isFueled && isLive) {
        console.log('  🛑 Insufficient gas (POL/MATIC). Aborting.');
        return;
    }

    // 3. Setup wallet and CLOB client
    const provider = new ethers.JsonRpcProvider('https://polygon.drpc.org');
    const wallet = new ethers.Wallet(ETH_PRIVATE_KEY, provider);

    console.log(`\n  👛 Wallet: ${wallet.address}`);

    // 4. Check USDC balance
    const usdcAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    const usdcAbi = ["function balanceOf(address) view returns (uint256)"];
    const usdcContract = new ethers.Contract(usdcAddress, usdcAbi, provider);
    const usdcBalance = await usdcContract.balanceOf(wallet.address);
    const usdcBal = parseFloat(ethers.formatUnits(usdcBalance, 6));

    console.log(`  💰 USDC Balance: $${usdcBal.toFixed(2)}`);

    if (usdcBal < BET_AMOUNT) {
        console.log(`  🛑 Insufficient USDC ($${usdcBal.toFixed(2)} < $${BET_AMOUNT}). Aborting.`);
        return;
    }

    // 5. Calculate expected return
    const sharesEstimate = BET_AMOUNT / MAX_YES_PRICE;
    const profitEstimate = sharesEstimate - BET_AMOUNT;
    console.log(`\n  📐 Expected shares: ~${sharesEstimate.toFixed(1)}`);
    console.log(`  📐 Expected profit if YES: ~$${profitEstimate.toFixed(2)} (${(profitEstimate / BET_AMOUNT * 100).toFixed(1)}%)`);

    if (!isLive) {
        console.log(`\n  🧪 DRY RUN: Would place $${BET_AMOUNT} on YES at up to ${MAX_YES_PRICE * 100}¢`);
        console.log(`  🧪 To execute for real: node src/executor/eth_bet.js --live`);
        console.log(`${'═'.repeat(55)}\n`);
        return;
    }

    // 6. LIVE EXECUTION
    console.log('\n  🚀 EXECUTING LIVE BET...');

    const client = new ClobClient(
        'https://clob.polymarket.com',
        137,
        wallet
    );

    try {
        // Place market buy for YES shares
        console.log('  📝 Creating order: BUY YES...');
        const buyOrder = await client.createOrder({
            tokenID: MARKET.yesTokenId,
            price: MAX_YES_PRICE,
            side: "BUY",
            size: sharesEstimate
        });

        const result = await client.postOrder(buyOrder);
        console.log(`  ✅ Order placed: ${JSON.stringify(result)}`);
        console.log(`\n  🎯 Position: ${sharesEstimate.toFixed(1)} YES shares @ ${MAX_YES_PRICE * 100}¢`);
        console.log(`  🎯 Max loss: $${BET_AMOUNT}`);
        console.log(`  🎯 Max profit: $${profitEstimate.toFixed(2)}`);
        console.log(`  🎯 Resolves: ${MARKET.endDate}`);
    } catch (e) {
        console.log(`  ❌ Order failed: ${e.message}`);
    }

    console.log(`${'═'.repeat(55)}\n`);
}

// CLI
const isLive = process.argv.includes('--live');
executeBet(isLive);
