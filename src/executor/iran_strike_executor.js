import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { checkGas } from './gas_sentinel.js';

/**
 * iran_strike_executor.js
 * 🔥 IRAN STRIKE TRADES — Stacked near-certainties
 * 
 * Buys YES on 3 Iran strike markets:
 *   1. US strike Iran Feb 28 (98¢) — $5
 *   2. US/Israel strike Iran Mar 1 (97¢) — $5  
 *   3. US/Israel strike Iran Mar 2 (89¢) — $5
 */

const TRADES = [
    {
        name: "US next strike Iran Feb 28",
        yesTokenId: "15052934213634595778860506780061300924840406606782657138856492802067972899387",
        conditionId: "0x8f48b7a8bca71c288587bc51c7ee67479422e90bdcbe868790215cec7887c468",
        price: 0.98,
        amount: 5
    },
    {
        name: "US/Israel strike Iran Mar 1",
        yesTokenId: "81796058586020001040299103749527120444014656405453258841850892635157446919",
        conditionId: "0xaffffdcf1ac14c2b3d6888f5efc76c0ea1aa5db4891588cc6e99f6e37e938acb",
        price: 0.97,
        amount: 5
    },
    {
        name: "US/Israel strike Iran Mar 2",
        yesTokenId: "24748787692148674467721380471093526911592120124083141304090990787224433180280",
        conditionId: "0xba580e15cb600f9fb9a70c7a04a239e4df64a1d5c13780a5192525e4d1c71eec",
        price: 0.89,
        amount: 5
    }
];

async function executeTrades() {
    console.log('🔥 IRAN STRIKE EXECUTOR — 3 stacked near-certainties');
    console.log('═'.repeat(55));

    // Pre-flight gas check
    const isFueled = await checkGas('POL');
    if (!isFueled) {
        console.log('🛑 ABORTED: Insufficient gas (POL/MATIC).');
        return;
    }

    const provider = new ethers.JsonRpcProvider('https://polygon.drpc.org');
    const wallet = new ethers.Wallet(process.env.ETH_PRIVATE_KEY, provider);
    console.log(`💳 Wallet: ${wallet.address}`);

    // Check USDC balance
    const usdcAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    const usdcAbi = ["function balanceOf(address) view returns (uint256)"];
    const usdcContract = new ethers.Contract(usdcAddress, usdcAbi, provider);
    const usdcBalance = await usdcContract.balanceOf(wallet.address);
    const balance = parseFloat(ethers.formatUnits(usdcBalance, 6));
    console.log(`💰 USDC Balance: $${balance.toFixed(2)}`);

    const totalNeeded = TRADES.reduce((s, t) => s + t.amount, 0);
    if (balance < totalNeeded) {
        console.log(`🛑 Need $${totalNeeded} but only have $${balance.toFixed(2)}`);
        return;
    }

    // Initialize CLOB client with L2 credentials
    const client = new ClobClient(
        'https://clob.polymarket.com',
        137,
        wallet,
        undefined,
        undefined,
        undefined,
        {
            key: process.env.POLY_API_KEY,
            secret: process.env.POLY_API_SECRET,
            passphrase: process.env.POLY_API_PASSPHRASE
        }
    );

    // Execute each trade
    for (const trade of TRADES) {
        console.log(`\n📍 ${trade.name}`);
        console.log(`   Price: ${(trade.price * 100).toFixed(0)}¢ | Amount: $${trade.amount}`);

        try {
            // Calculate shares: $amount / price = shares
            const shares = Math.floor(trade.amount / trade.price);

            console.log(`   Buying ${shares} YES shares at ${(trade.price * 100).toFixed(0)}¢...`);

            const order = await client.createOrder({
                tokenID: trade.yesTokenId,
                price: trade.price,
                side: "BUY",
                size: shares
            });

            const result = await client.postOrder(order);
            console.log(`   ✅ Order placed: ${JSON.stringify(result).substring(0, 200)}`);

            // Small delay between trades
            await new Promise(r => setTimeout(r, 2000));

        } catch (e) {
            console.log(`   ❌ Failed: ${e.message}`);
        }
    }

    console.log('\n═'.repeat(55));
    console.log('📊 Expected outcomes if all resolve YES:');
    let totalInvested = 0, totalProfit = 0;
    for (const t of TRADES) {
        const profit = t.amount * (1 - t.price) / t.price;
        totalInvested += t.amount;
        totalProfit += profit;
        console.log(`  ${t.name}: $${t.amount} → +$${profit.toFixed(2)}`);
    }
    console.log(`  TOTAL: $${totalInvested} invested → +$${totalProfit.toFixed(2)} profit`);
}

executeTrades().catch(e => console.error(`Fatal: ${e.message}`));
