import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';

/**
 * baghdad_bet.js
 * 🏹 THE RUDY RAID: Finalized Execution - Limit Sell Staging
 * 
 * Sets the auto-sell limit for the Baghdad YES position.
 * Fixed with Retry Loop to handle public RPC rate limits.
 */

const ETH_PRIVATE_KEY = process.env.ETH_PRIVATE_KEY;
const YES_TOKEN_ID = "46139312350713967618426245298341049149495513939822327454410984217986250336846";
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runLimitSell() {
    console.log('--- 🏹 BAGHDAD BET: LIMIT SELL STAGING (RETRY LOOP) ---');

    const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
    const wallet = new ethers.Wallet(ETH_PRIVATE_KEY, provider);

    wallet.signTypedData = async (domain, types, value) => {
        const payload = ethers.TypedDataEncoder.hash(domain, types, value);
        return wallet.signingKey.sign(payload).serialized;
    };
    wallet._signTypedData = wallet.signTypedData.bind(wallet);

    const ctfAbi = [
        "function isApprovedForAll(address, address) view returns (bool)",
        "function setApprovalForAll(address, bool) returns ()",
        "function balanceOf(address, uint256) view returns (uint256)"
    ];

    const ctf = new ethers.Contract(CTF_CONTRACT, ctfAbi, wallet);

    let approved = false;
    for (let i = 0; i < 3; i++) {
        try {
            console.log(`  🔍 Verifying Share Approval (Attempt ${i + 1})...`);
            approved = await ctf.isApprovedForAll(wallet.address, CTF_EXCHANGE);
            if (approved) break;

            console.log('  🔓 Sending Approval...');
            const tx = await ctf.setApprovalForAll(CTF_EXCHANGE, true, {
                gasLimit: 120000,
                maxPriorityFeePerGas: ethers.parseUnits("50", "gwei"),
                maxFeePerGas: ethers.parseUnits("300", "gwei")
            });
            console.log('     Tx Sent:', tx.hash);
            await tx.wait();
            approved = true;
            console.log('     Approval Confirmed.');
            break;
        } catch (e) {
            console.log(`  ⚠️ Attempt ${i + 1} Failed: ${e.message}`);
            await wait(10000); // Wait 10s for rate limit to reset
        }
    }

    if (!approved) {
        console.log('  🛑 Failed to secure approval. Checking CLOB client anyway...');
    }

    // 2. Initializing CLOB Client
    console.log('  📜 Initializing CLOB Client...');
    const client = new ClobClient(
        'https://clob.polymarket.com',
        137,
        wallet,
        {
            key: process.env.POLY_API_KEY,
            secret: process.env.POLY_API_SECRET,
            passphrase: process.env.POLY_API_PASSPHRASE
        },
        0
    );

    try {
        console.log('  🏹 Setting LIMIT SELL at $0.40...');
        const shares = await ctf.balanceOf(wallet.address, BigInt(YES_TOKEN_ID));
        const size = Number(ethers.formatUnits(shares, 6));

        if (size > 0) {
            const sellOrder = await client.createOrder({
                tokenID: YES_TOKEN_ID,
                price: 0.40,
                side: "SELL",
                size: size
            });
            const sellResp = await client.postOrder(sellOrder);
            console.log('     Limit Result:', JSON.stringify(sellResp));
        } else {
            console.log('  🛑 No shares found.');
        }

        console.log('\n  ✅ MISSION SUCCESS: Baghdad auto-sell staged.');
    } catch (e) {
        console.log('  ❌ CLOB Error:', e.message);
    }
}

runLimitSell();
