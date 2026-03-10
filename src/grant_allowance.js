import { ethers } from 'ethers';
import 'dotenv/config';

async function grantAllowance() {
    const provider = new ethers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');
    const wallet = new ethers.Wallet(process.env.ETH_PRIVATE_KEY, provider);
    
    // USDC.e on Polygon
    const collateralAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    // CTF Exchange / Proxy address for Polymarket
    const spenderAddress = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'; 

    const abi = ["function approve(address spender, uint256 amount) returns (bool)"];
    const contract = new ethers.Contract(collateralAddress, abi, wallet);

    console.log(`🧪 ACTION: Granting allowance for ${spenderAddress}...`);
    try {
        const tx = await contract.approve(spenderAddress, ethers.MaxUint256);
        console.log(`📡 Approval TX broadcasted: ${tx.hash}`);
        await tx.wait();
        console.log('✅ Allowance GRANTED.');
    } catch (e) {
        console.error(`❌ Approval Failed: ${e.message}`);
    }
}

grantAllowance();
