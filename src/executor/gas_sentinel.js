import 'dotenv/config';
import { ethers } from 'ethers';

/**
 * gas_sentinel.js
 * ⛽ THE FUEL CHECK: Multi-Chain Gas Guard
 * 
 * Ensures the Oracle has the native assets required to execute.
 */

const RPC_CONFIG = {
    ARB: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.drpc.org'],
    POL: ['https://polygon-rpc.com', 'https://polygon.drpc.org', 'https://1rpc.io/poly'],
    BASE: ['https://mainnet.base.org']
};

const MIN_FLOORS = {
    ARB: 0.002, // ETH
    POL: 2.0,   // POL/MATIC
    BASE: 0.002 // ETH
};

async function checkGas(targetChain = null) {
    console.log(`--- ⛽ GAS SENTINEL: SYSTEM SCAN ${targetChain ? `(${targetChain})` : ''} ---`);
    const walletAddr = process.env.ETH_WALLET_ADDRESS;
    let allClear = true;

    for (const [chain, urls] of Object.entries(RPC_CONFIG)) {
        let balance = 0n;
        let success = false;

        for (const url of urls) {
            try {
                const provider = new ethers.JsonRpcProvider(url);
                balance = await provider.getBalance(walletAddr);
                success = true;
                break; // Found a working RPC
            } catch (e) {
                continue;
            }
        }

        if (!success) {
            console.log(`  ❌ ${chain}: All RPCs failed.`);
            allClear = false;
            continue;
        }

        const ethBal = parseFloat(ethers.formatEther(balance));
        const floor = MIN_FLOORS[chain];

        if (ethBal < floor) {
            console.log(`  ⚠️  ${chain}: LOW FUEL (${ethBal.toFixed(4)} < ${floor})`);
            allClear = false;
        } else {
            console.log(`  ✅ ${chain}: CLEAR (${ethBal.toFixed(4)})`);
        }
    }

    if (targetChain && MIN_FLOORS[targetChain]) {
        const p = new ethers.JsonRpcProvider(RPC_CONFIG[targetChain][0]);
        const b = await p.getBalance(walletAddr);
        const bal = parseFloat(ethers.formatEther(b));
        if (bal < MIN_FLOORS[targetChain]) {
            console.log(`  ❌ TARGET CHAIN LOW FUEL: ${targetChain} (${bal.toFixed(4)})`);
            return false;
        }
        console.log(`  ✅ TARGET CHAIN CLEAR: ${targetChain} (${bal.toFixed(4)})`);
        return true;
    }

    if (allClear) {
        console.log('--- 🚀 SYSTEM READY: ALL CLEAR ---');
    } else {
        console.log('--- 🛑 STOP: FUEL REQUIRED ---');
    }

    return allClear;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    checkGas();
}

export { checkGas };
