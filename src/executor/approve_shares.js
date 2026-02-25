import 'dotenv/config';
import { ethers } from 'ethers';

/**
 * approve_shares.js
 * 🏹 THE RUDY RAID: Finalized Share Approval
 * 
 * Specifically handles the ERC1155 setApprovalForAll for Polymarket CTF.
 */

const ETH_PRIVATE_KEY = process.env.ETH_PRIVATE_KEY;
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

async function approve() {
    console.log('--- 🏹 SHARE APPROVAL: INITIALIZING ---');

    // Using a list of RPCs for redundancy
    const rpcs = [
        'https://polygon-rpc.com',
        'https://rpc-mainnet.maticvigil.com',
        'https://1rpc.io/matic'
    ];

    for (const rpc of rpcs) {
        try {
            console.log(`  🌐 Connecting to: ${rpc}`);
            const provider = new ethers.JsonRpcProvider(rpc);
            const wallet = new ethers.Wallet(ETH_PRIVATE_KEY, provider);

            const ctfAbi = ["function setApprovalForAll(address, bool) returns ()"];
            const ctf = new ethers.Contract(CTF_CONTRACT, ctfAbi, wallet);

            console.log('  🔓 Sending setApprovalForAll...');
            const tx = await ctf.setApprovalForAll(CTF_EXCHANGE, true, {
                gasLimit: 150000,
                maxPriorityFeePerGas: ethers.parseUnits("35", "gwei"),
                maxFeePerGas: ethers.parseUnits("200", "gwei")
            });
            console.log('     Tx Sent:', tx.hash);
            const receipt = await tx.wait();
            console.log('     Approval Confirmed in Block:', receipt.blockNumber);
            return; // Success
        } catch (e) {
            console.log(`  ❌ Failed on ${rpc}: ${e.message}`);
        }
    }
}

approve();
