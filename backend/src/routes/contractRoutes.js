const express = require('express');
const router = express.Router();

// Helper: Binary search to find block number from timestamp
async function findBlockByTimestamp(targetTimestamp, endpoint) {
  const latestRes = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'starknet_blockNumber', params: [], id: 1 })
  });
  const latestData = await latestRes.json();
  let high = parseInt(latestData.result, 16);
  let low = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const blockRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'starknet_getBlockWithTxs', params: [{ block_number: mid }], id: mid })
    });
    const blockData = await blockRes.json();
    if (!blockData.result || !blockData.result.timestamp) break;
    const blockTime = blockData.result.timestamp;
    if (blockTime < targetTimestamp) low = mid + 1;
    else if (blockTime > targetTimestamp) high = mid - 1;
    else return mid;
  }
  return low;
}

// Analyze contract endpoint
router.post('/analyze', async (req, res) => {
  try {
    const { contractAddress, fromDate, toDate } = req.body;
    
    if (!contractAddress || !contractAddress.startsWith('0x') || contractAddress.length !== 66) {
      return res.status(400).json({
        success: false,
        message: 'Invalid contract address format'
      });
    }

    console.log(`🔍 Analyzing contract: ${contractAddress}`);

    // Starknet RPC endpoints
    const endpoints = [
      "https://starknet-mainnet.public.blastapi.io",
      "https://free-rpc.nethermind.io/mainnet-juno"
    ];

    // Get current block number
    const blockResponse = await fetch(endpoints[0], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'starknet_blockNumber',
        params: [],
        id: 1
      })
    });

    const blockData = await blockResponse.json();
    const currentBlock = parseInt(blockData.result, 16);
    console.log(`📦 Current block: ${currentBlock}`);

    // Determine block range
    let fromBlock, toBlock;
    if (fromDate && toDate) {
      const fromTimestamp = Math.floor(new Date(fromDate).getTime() / 1000);
      const toTimestamp = Math.floor(new Date(toDate).getTime() / 1000);
      fromBlock = await findBlockByTimestamp(fromTimestamp, endpoints[0]);
      toBlock = await findBlockByTimestamp(toTimestamp, endpoints[0]);
      console.log(`📅 Date range: ${fromDate} to ${toDate} → blocks ${fromBlock} to ${toBlock}`);
    } else {
      fromBlock = Math.max(0, currentBlock - 1000);
      toBlock = currentBlock;
    }

    const contractTransactions = [];
    const searchBlocks = Math.min(toBlock - fromBlock + 1, 20000); // Cap at 20k blocks

    for (let i = 0; i < searchBlocks; i++) {
      const blockNum = toBlock - i;
      if (blockNum < fromBlock) break;
      
      try {
        const response = await fetch(endpoints[0], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'starknet_getBlockWithTxs',
            params: [{ block_number: blockNum }],
            id: i + 2
          })
        });

        const data = await response.json();
        const block = data.result;

        if (block && block.transactions) {
          // Filter transactions involving this contract
          const relevantTxs = block.transactions.filter(tx => 
            tx.sender_address === contractAddress ||
            tx.contract_address === contractAddress ||
            (tx.calldata && tx.calldata.some(call => call.includes(contractAddress.slice(2))))
          );

          contractTransactions.push(...relevantTxs.map(tx => ({
            block_number: blockNum,
            transaction_hash: tx.transaction_hash,
            sender_address: tx.sender_address,
            contract_address: contractAddress,
            max_fee: tx.max_fee || '0x0',
            type: tx.type || 'INVOKE',
            timestamp: block.timestamp
          })));
        }
      } catch (blockError) {
        console.warn(`⚠️ Failed to fetch block ${blockNum}:`, blockError.message);
      }
    }

    console.log(`📊 Found ${contractTransactions.length} transactions`);

    if (contractTransactions.length === 0) {
      // Try to get contract class info
      let contractInfo = 'Unknown Contract';
      try {
        const classResponse = await fetch(endpoints[0], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'starknet_getClassAt',
            params: [contractAddress, 'latest'],
            id: 999
          })
        });
        const classData = await classResponse.json();
        if (classData.result && !classData.error) {
          contractInfo = 'Valid Contract (Deployed)';
        }
      } catch (e) {
        contractInfo = 'Contract Not Found or Invalid';
      }

      return res.json({
        success: true,
        data: {
          contract_address: contractAddress,
          status: 'No Recent Activity',
          contract_info: contractInfo,
          message: `No transactions found in blocks ${fromBlock} to ${toBlock}. This contract may be inactive or have older transactions.`,
          suggestion: 'Try a more active contract address or adjust the date range.',
          blocks_searched: searchBlocks,
          current_block: currentBlock,
          search_range: `Block ${fromBlock} to ${toBlock}`,
          from_block: fromBlock,
          to_block: toBlock,
          transactions: []
        }
      });
    }

    // Calculate metrics
    const totalFees = contractTransactions.reduce((sum, tx) => sum + parseInt(tx.max_fee, 16), 0);
    const avgFee = totalFees / contractTransactions.length;
    const uniqueSenders = new Set(contractTransactions.map(tx => tx.sender_address)).size;

    res.json({
      success: true,
      data: {
        contract_address: contractAddress,
        status: 'Active',
        transaction_count: contractTransactions.length,
        avg_fee: (avgFee / 1e18).toFixed(6),
        total_fees: (totalFees / 1e18).toFixed(4),
        unique_senders: uniqueSenders,
        blocks_analyzed: searchBlocks,
        current_block: currentBlock,
        from_block: fromBlock,
        to_block: toBlock,
        transactions: contractTransactions.slice(0, 10) // Return first 10 transactions
      }
    });

  } catch (error) {
    console.error('❌ Contract analysis error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to analyze contract',
      error: error.message
    });
  }
});

module.exports = router;