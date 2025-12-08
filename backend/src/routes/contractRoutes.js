const express = require('express');
const router = express.Router();
const ContractQuery = require('../models/ContractQuery');
const authMiddleware = require('../middlewares/authMiddlewares');

const RPC_ENDPOINTS = [
  'https://rpc.starknet.lava.build',
  'https://starknet-mainnet.g.alchemy.com/v2/demo',
  'https://starknet-mainnet.public.blastapi.io',
  'https://free-rpc.nethermind.io/mainnet-juno'
];

let currentRpcIndex = 0;
const getRpcUrl = () => RPC_ENDPOINTS[currentRpcIndex];
const switchRpc = () => { currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length; };

async function rpcCall(method, params) {
  for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
    try {
      const res = await fetch(getRpcUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 })
      });
      const data = await res.json();
      if (data.result) return data.result;
    } catch (e) {
      switchRpc();
    }
  }
  throw new Error('All RPC endpoints failed');
}

async function findBlockByTimestamp(targetTs) {
  const latest = await rpcCall('starknet_blockNumber', []);
  let low = 0, high = latest;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const block = await rpcCall('starknet_getBlockWithTxs', [{ block_number: mid }]);
    if (!block?.timestamp) break;
    if (block.timestamp < targetTs) low = mid + 1;
    else if (block.timestamp > targetTs) high = mid - 1;
    else return mid;
  }
  return low;
}

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

// Fetch contract events with date range
router.post('/events', async (req, res) => {
  try {
    const { contractAddress, fromDate, toDate, chain } = req.body;

    if (!contractAddress) {
      return res.status(400).json({ success: false, message: 'Contract address required' });
    }

    const fromTs = fromDate ? Math.floor(new Date(fromDate).getTime() / 1000) : null;
    const toTs = toDate ? Math.floor(new Date(toDate).getTime() / 1000) : null;

    const latest = await rpcCall('starknet_blockNumber', []);
    const fromBlock = fromTs ? await findBlockByTimestamp(fromTs) : Math.max(0, latest - 2000);
    const toBlock = toTs ? await findBlockByTimestamp(toTs) : latest;

    const { RpcProvider } = require('starknet');
    const provider = new RpcProvider({ nodeUrl: getRpcUrl() });

    const events = await provider.getEvents({
      address: contractAddress,
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      chunk_size: 1000
    });

    const latestBlock = await rpcCall('starknet_getBlockWithTxs', [{ block_number: latest }]);
    const latestTimestamp = latestBlock?.timestamp || Math.floor(Date.now() / 1000);
    const fromBlockData = await rpcCall('starknet_getBlockWithTxs', [{ block_number: fromBlock }]);
    const fromTimestamp = fromBlockData?.timestamp || (latestTimestamp - 2000 * 15);

    const decodedEvents = (events.events || []).map(event => {
      let eventName = 'Unknown Event';
      let decodedData = {};

      const blockDiff = latest - event.block_number;
      const totalDiff = latest - fromBlock;
      const timeDiff = latestTimestamp - fromTimestamp;
      const estimatedTimestamp = latestTimestamp - (blockDiff / totalDiff) * timeDiff;

      if (event.keys?.[0]) {
        const key = event.keys[0];
        if (key === '0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9') {
          eventName = 'Transfer';
          if (event.data?.length >= 3) {
            decodedData = { from: event.data[0], to: event.data[1], amount: parseInt(event.data[2], 16).toString() };
          }
        } else if (key === '0x1dcde06aabdbca2f80aa51392b345d7549d7757aa855f7e37f5d335ac8243b1') {
          eventName = 'Approval';
          if (event.data?.length >= 3) {
            decodedData = { owner: event.data[0], spender: event.data[1], amount: parseInt(event.data[2], 16).toString() };
          }
        }
      }

      return {
        ...event,
        event_name: eventName,
        decoded_data: decodedData,
        timestamp: new Date(estimatedTimestamp * 1000).toISOString(),
        timestamp_raw: estimatedTimestamp
      };
    });

    res.json({
      success: true,
      data: {
        events: decodedEvents,
        fromBlock,
        toBlock,
        totalEvents: decodedEvents.length
      }
    });
  } catch (error) {
    console.error('Events fetch error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

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

    const currentBlock = await rpcCall('starknet_blockNumber', []);
    console.log(`📦 Current block: ${currentBlock}`);

    const fromTs = fromDate ? Math.floor(new Date(fromDate).getTime() / 1000) : null;
    const toTs = toDate ? Math.floor(new Date(toDate).getTime() / 1000) : null;
    const fromBlock = fromTs ? await findBlockByTimestamp(fromTs) : Math.max(0, currentBlock - 1000);
    const toBlock = toTs ? await findBlockByTimestamp(toTs) : currentBlock;

    const contractTransactions = [];
    const searchBlocks = Math.min(toBlock - fromBlock + 1, 20000); // Cap at 20k blocks

    for (let i = 0; i < searchBlocks; i++) {
      const blockNum = toBlock - i;
      if (blockNum < fromBlock) break;
      
      try {
        const block = await rpcCall('starknet_getBlockWithTxs', [{ block_number: blockNum }]);

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
        const classData = await rpcCall('starknet_getClassAt', [contractAddress, 'latest']);
        if (classData) contractInfo = 'Valid Contract (Deployed)';
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

// Save contract query
router.post('/save-query', authMiddleware.authenticate, async (req, res) => {
  try {
    const { contracts, chain, fromDate, toDate, events, stats, contractInfo } = req.body;
    const query = new ContractQuery({
      contracts,
      chain,
      fromDate,
      toDate,
      events,
      stats,
      contractInfo,
      createdBy: req.user.userId
    });
    await query.save();
    res.json({ success: true, data: { queryId: query._id } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get saved queries
router.get('/saved-queries', authMiddleware.authenticate, async (req, res) => {
  try {
    const queries = await ContractQuery.find({ createdBy: req.user.userId })
      .select('-events')
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ success: true, data: { queries } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get query by ID
router.get('/query/:id', authMiddleware.authenticate, async (req, res) => {
  try {
    const query = await ContractQuery.findById(req.params.id);
    if (!query || query.createdBy.toString() !== req.user.userId) {
      return res.status(404).json({ success: false, message: 'Query not found' });
    }
    res.json({ success: true, data: { query } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;