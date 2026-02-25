import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';

async function test() {
    console.log('--- 🧪 POLYMARKET CLOB CONNECTION TEST ---');
    const provider = new ethers.JsonRpcProvider('https://polygon.drpc.org');
    const wallet = new ethers.Wallet(process.env.ETH_PRIVATE_KEY, provider);

    // Shim for signing
    wallet._signTypedData = wallet.signTypedData.bind(wallet);

    const client = new ClobClient(
        'https://clob.polymarket.com',
        137,
        wallet,
        process.env.POLY_API_KEY,
        process.env.POLY_API_SECRET,
        process.env.POLY_API_PASSPHRASE
    );

    try {
        console.log('  🔍 Testing Order Auth (getOpenOrders)...');
        const orders = await client.getOpenOrders();
        console.log(`     Auth Confirmed. Open Orders Count: ${orders.length}`);
        console.log('  ✅ CLOB Connection & Auth Verified.');
    } catch (e) {
        console.log('  ❌ Test Failed:', e.message);
    }
}

test();
